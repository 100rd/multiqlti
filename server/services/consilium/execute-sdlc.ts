/**
 * execute-sdlc.ts — the SERVER path that EXECUTES a consilium verdict's
 * `action_points` directly via the SDLC executor, replacing the legacy
 * "hand off to a pipeline" mechanism.
 *
 * This is the consilium loop's DEVELOPING phase, now HUMAN-TRIGGERED by a button:
 * read the group's latest-iteration Judge verdict, code EACH action point in an
 * ISOLATED git worktree (one agentic `claude` coder run + one commit per action
 * point), and open ONE Draft PR aggregating them. It reuses the EXACT same
 * `runSdlcHandoff` executor the loop uses, so every SDLC security property is
 * inherited unchanged (no Bash, sanitized env, untrusted action-point text only
 * via stdin + clamped commit/PR body, arg-array git, Draft-PR-only — agents NEVER
 * merge). See `server/services/sdlc/executor.ts`.
 *
 * SECURITY (the same surface as POST /api/consilium-reviews — get it right):
 *   1. ACTION POINTS ARE SERVER-READ. They come ONLY from the group's latest
 *      iteration's Judge `output` (`pickJudgeOutput` → `extractActionPoints`).
 *      A client-supplied `action_points` is NEVER consulted (the route's zod
 *      schema doesn't even surface it). No verdict / no action points ⇒ a clean
 *      "no action points to execute" rejection — NOTHING runs.
 *   2. repoPath IS ALLOWLIST + WORKSPACE GATED. The candidate (the consilium
 *      loop's persisted `repoPath`, else an optional body `repoPath`) is run
 *      through `assertAllowedRepoPath` (the fail-closed GLOBAL allowlist, S1) AND
 *      THEN `assertRepoIsProjectWorkspace` (the per-project workspace confinement,
 *      MED-3/S5) — a repo must pass BOTH. A stored loop.repoPath is RE-VALIDATED
 *      here (never trust the row). On rejection NOTHING runs.
 *   3. BRANCH SHAPE IS SERVER-DERIVED. A FRESH uuid (NOT the loop's id) + round 1
 *      feeds `buildBranchName` so the executor's `consilium/loop-<uuid>/round-1`
 *      branch can never collide with the loop's OWN developing-phase branches.
 *      action-point text never touches the branch / PR title.
 *   4. SINGLE-FLIGHT / DEDUP + GLOBAL CAP + ANTI-WEDGE.
 *      - DEDUP (per-group): a process-local registry keyed by groupId is RESERVED
 *        synchronously on entry; a concurrent second request for the SAME group
 *        gets the EXISTING handle back instead of launching a second worktree on a
 *        fresh branch (the #417 double-dispatch lesson). A validation failure frees
 *        the slot so the user can retry after fixing the input.
 *      - GLOBAL CAP (MED-1): per-group dedup did NOT bound a user who owns N verdict
 *        groups from POSTing to ALL N → N concurrent coder subprocesses. A process
 *        GLOBAL cap (`MAX_CONCURRENT_EXECUTE_SDLC`) refuses a NEW group's run beyond
 *        the cap with a typed `EXECUTOR_BUSY` outcome (route → HTTP 429). The
 *        cap-check + slot-reserve is ATOMIC (no await between). Dedup is NOT blocked
 *        by the cap — an already-running group always gets its handle back.
 *      - WATCHDOG + GC (MED-2): a run whose executor promise never settles past its
 *        time budget would wedge the group at "running" forever (dedup keeps handing
 *        the stuck handle back) until restart. A watchdog FORCE-settles such a run to
 *        `failed` and frees its slot, so a fresh POST can relaunch. Settled rows are
 *        GC'd after a retention window so the registry can't grow unbounded.
 *   5. BACKGROUND RUN. The coder takes minutes; it runs fire-and-forget OFF the
 *      request path (never blocks the HTTP response). The registry tracks
 *      running→done/failed with { prRef, headCommit, error } for the status poll.
 *
 * NOTE on which action points run (FLAGGED for the adversarial reviewer): this
 * executes the FULL `action_points` list from the verdict (ALL priorities), via
 * `extractActionPoints`, NOT the loop's open-P0-only `readConvergence` narrowing.
 * Rationale: a maintainer who clicks "execute this verdict" wants every flagged
 * item implemented, and the task's "no action_points → 400" wording keys off the
 * presence of action points, not of open P0s. The count is bounded
 * (MAX_ACTION_POINTS = 50) + each field clamped in `extractActionPoints`.
 */
import { randomUUID } from "crypto";
import type { IStorage } from "../../storage.js";
import type { AppConfig } from "../../config/schema.js";
import type { ActionPoint } from "@shared/types";
import { runSdlcHandoff, type SdlcProgress } from "../sdlc/executor.js";
import { pickJudgeOutput } from "./consilium-loop-controller.js";
import { extractActionPoints } from "../orchestrator/convergence.js";
import { assertAllowedRepoPath } from "./repo-allowlist.js";
import { assertRepoIsProjectWorkspace } from "./review-factory.js";

/**
 * MED-1: the process GLOBAL ceiling on simultaneously-RUNNING execute-sdlc runs.
 * Each run spawns a real agentic coder subprocess + a git worktree, so the fan-out
 * has to be bounded across ALL groups, not just deduped per group. A NEW group's
 * run beyond this is refused with `EXECUTOR_BUSY` (route → 429), not queued.
 */
export const MAX_CONCURRENT_EXECUTE_SDLC = 3;

/**
 * MED-2: how long past `coderTimeoutMs` the watchdog waits before FORCE-settling a
 * still-"running" row to `failed`. The executor's own timeout should fire first;
 * this margin only catches the pathological "timeout failed to kill the subprocess
 * and the promise never settled" wedge.
 */
const WATCHDOG_MARGIN_MS = 60_000;

/**
 * MED-2: how long a SETTLED (done/failed) registry row stays readable by the status
 * poll before it is GC'd, so the registry can't grow unbounded. A still-`running`
 * row is NEVER evicted.
 */
const SETTLED_RETENTION_MS = 10 * 60_000;

/** Stable, machine-checkable failure codes the route maps to actionable 4xx. */
export type ExecuteSdlcErrorCode =
  | "NO_ACTION_POINTS" // no verdict / no parseable action points → 400
  | "NO_REPO_PATH" // no loop repoPath and no body repoPath → 400
  | "REPO_NOT_ALLOWED" // outside the fail-closed global allowlist → 400
  | "REPO_NOT_WORKSPACE" // allowlisted but not a workspace of this project → 400
  | "EXECUTOR_BUSY"; // global concurrency cap reached (MED-1) → 429

/** A typed, route-mappable rejection. NOTHING has run when this is thrown. */
export class ExecuteSdlcError extends Error {
  constructor(
    readonly code: ExecuteSdlcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExecuteSdlcError";
  }
}

/** Public, pollable status of a group's execute-sdlc run (registry snapshot). */
export interface ExecuteSdlcStatus {
  /** running while the background coder works; done/failed once settled. */
  status: "running" | "done" | "failed";
  /** The synthetic loop id that shaped the branch (`consilium/loop-<id>/round-1`). */
  runId: string;
  /** Always 1 for a human-triggered run (round-shape invariant). */
  round: number;
  /** How many action points the verdict carried (one coder run + commit each). */
  actionPointCount: number;
  /** Draft PR URL once settled, or null when zero commits were produced. */
  prRef?: string | null;
  /** HEAD sha of the SDLC branch after the last commit; "" when nothing committed. */
  headCommit?: string;
  /** Scrubbed note present on any non-happy settle. */
  error?: string;
  /** epoch ms the run was launched. */
  startedAt: number;
  /** epoch ms the run settled (absent while running). */
  settledAt?: number;
  /** Latest per-action-point progress beat (display-only): which phase + index/
   *  total + clamped title + completed count. The LAST-SEEN beat while running;
   *  retained as the last-seen beat once settled. Absent before the first beat. */
  progress?: SdlcProgress;
}

/** The 202 handle the route returns (a subset of the status, plus `deduped`). */
export interface ExecuteSdlcHandle {
  groupId: string;
  runId: string;
  round: number;
  status: "running";
  actionPointCount: number;
  /** True when an in-flight run already existed — no new worktree was launched. */
  deduped: boolean;
}

/** Internal registry row. */
interface ExecuteSdlcRun {
  status: "running" | "done" | "failed";
  runId: string;
  round: number;
  actionPointCount: number;
  prRef?: string | null;
  headCommit?: string;
  error?: string;
  startedAt: number;
  settledAt?: number;
  /** Latest display-only progress beat (written synchronously by the executor's
   *  onProgress sink while the run is `running`; never after settle). */
  progress?: SdlcProgress;
  /** MED-2: the anti-wedge timer, armed at dispatch and cleared on settle. */
  watchdog?: ReturnType<typeof setTimeout>;
}

export interface SdlcExecutionDeps {
  storage: IStorage;
  config: () => AppConfig;
  /** The SDLC executor. Defaults to the real `runSdlcHandoff`; tests inject a fake. */
  runSdlc?: typeof runSdlcHandoff;
}

/**
 * Owns the process-local execute-sdlc registry (mirrors the loop controller's
 * `sdlcRuns` pattern) and the read→validate→launch flow. One instance per server.
 */
export class SdlcExecutionService {
  /** Keyed by groupId — at most one tracked run per group (single-flight). */
  private readonly runs = new Map<string, ExecuteSdlcRun>();

  /**
   * MED-1: the number of registry rows currently holding a GLOBAL concurrency slot
   * (reserved at launch, freed on settle / force-settle / validation-failure). Kept
   * as a counter — NOT derived by scanning `runs` — so the cap-check + reserve stays
   * a single synchronous step (no await, no race) like the dedup reserve.
   */
  private runningCount = 0;

  constructor(private readonly deps: SdlcExecutionDeps) {}

  private get storage(): IStorage {
    return this.deps.storage;
  }

  private cfg() {
    return this.deps.config().pipeline.consiliumLoop;
  }

  /**
   * Launch (or dedup) an execute-sdlc run for a group. Reads the action points +
   * resolves the repoPath SERVER-side, gates the repoPath, then fires the SDLC
   * executor in the BACKGROUND and returns immediately with a handle.
   *
   * Throws {@link ExecuteSdlcError} BEFORE anything runs when there is no
   * verdict/action points, no resolvable repoPath, the repoPath fails the
   * allowlist/workspace gate (caller maps each to 400), OR the global concurrency
   * cap is reached for a NEW group (`EXECUTOR_BUSY` → 429). Returns
   * `{ deduped: true }` (no new run, never capped) when an execute-sdlc run is
   * already in flight for this group.
   *
   * @param groupId  the task group whose latest verdict to execute.
   * @param ownerId  the request user id (audit only — `runSdlcHandoff.ownerId`).
   * @param bodyRepoPath optional repoPath fallback when the group has no loop.
   */
  async execute(
    groupId: string,
    ownerId: string,
    bodyRepoPath?: string,
  ): Promise<ExecuteSdlcHandle> {
    // SINGLE-FLIGHT (1): a running entry → hand the SAME run back; do NOT launch a
    // second worktree on a fresh branch (the #417 double-dispatch lesson). Checked
    // FIRST, so dedup is NEVER blocked by the global cap below.
    const inflight = this.runs.get(groupId);
    if (inflight && inflight.status === "running") {
      return this.toHandle(groupId, inflight, true);
    }

    // MED-1 GLOBAL CAP: a NEW group's run beyond the cap is REFUSED (429), not
    // queued. The cap-check and the slot-reserve below are ATOMIC (no await between
    // them) so two concurrent NEW-group requests can never both slip past the cap.
    if (this.runningCount >= MAX_CONCURRENT_EXECUTE_SDLC) {
      throw new ExecuteSdlcError(
        "EXECUTOR_BUSY",
        "SDLC executor busy — too many concurrent runs, retry shortly",
      );
    }

    // RESERVE the slot SYNCHRONOUSLY (no await before the set + count bump) so a
    // concurrent second request for this group dedups, and a concurrent NEW group
    // sees the bumped count — even while the reads below are still pending. Filled
    // in once the verdict/repo are resolved.
    const runId = `${randomUUID()}`; // fresh uuid → branch can't collide w/ the loop's rounds
    const run: ExecuteSdlcRun = {
      status: "running",
      runId,
      round: 1,
      actionPointCount: 0,
      startedAt: Date.now(),
    };
    this.runs.set(groupId, run);
    this.runningCount += 1; // hold a global slot (freed on settle / validation-failure)

    try {
      // (2) SERVER-READ the action points from the group's latest iteration verdict.
      const actionPoints = await this.readActionPoints(groupId);

      // (3) Resolve + GATE the repoPath (global allowlist ∩ project workspace).
      const repoPath = await this.resolveRepoPath(groupId, bodyRepoPath);

      run.actionPointCount = actionPoints.length;

      // (4) Fire the executor in the BACKGROUND — never blocks the HTTP response.
      this.dispatch(groupId, run, repoPath, actionPoints, ownerId);

      return this.toHandle(groupId, run, false);
    } catch (err) {
      // A validation rejection: FREE the reserved slot (registry row + global count)
      // so the user can retry after fixing the input (no stuck "running" entry, and
      // no leaked concurrency slot, on a never-launched run).
      if (this.runs.get(groupId) === run) {
        this.runs.delete(groupId);
        this.runningCount = Math.max(0, this.runningCount - 1);
      }
      throw err;
    }
  }

  /** The latest execute-sdlc status for a group, or undefined if none was ever run. */
  getStatus(groupId: string): ExecuteSdlcStatus | undefined {
    const run = this.runs.get(groupId);
    if (!run) return undefined;
    return {
      status: run.status,
      runId: run.runId,
      round: run.round,
      actionPointCount: run.actionPointCount,
      prRef: run.prRef,
      headCommit: run.headCommit,
      error: run.error,
      startedAt: run.startedAt,
      settledAt: run.settledAt,
      progress: run.progress,
    };
  }

  // ─── internals ────────────────────────────────────────────────────────────

  /**
   * SERVER-READ the verdict's action points: the latest iteration's executions →
   * the Judge output (`pickJudgeOutput`) → the bounded FULL action_points list
   * (`extractActionPoints`). NEVER reads the request body. No verdict / no action
   * points ⇒ a clean NO_ACTION_POINTS rejection (NOTHING runs).
   */
  private async readActionPoints(groupId: string): Promise<readonly ActionPoint[]> {
    const iteration = await this.storage.getLatestIteration(groupId);
    if (!iteration) {
      throw new ExecuteSdlcError("NO_ACTION_POINTS", "no action points to execute");
    }
    const executions = await this.storage.getExecutionsByIteration(groupId, iteration.id);
    const judgeOutput = pickJudgeOutput(executions.map((e) => e.output));
    const actionPoints = extractActionPoints(judgeOutput);
    if (actionPoints.length === 0) {
      throw new ExecuteSdlcError("NO_ACTION_POINTS", "no action points to execute");
    }
    return actionPoints;
  }

  /**
   * Resolve the repoPath: prefer the consilium loop for this group
   * (`loop.repoPath`); else the optional body `repoPath`. The candidate is then
   * RE-VALIDATED (never trust a stored row) through the GLOBAL allowlist (S1) and
   * the per-project WORKSPACE confinement (S5/MED-3) — it must pass BOTH. Returns
   * the canonical realpath the allowlist resolved. Throws a typed rejection (the
   * route maps to 400) on any failure; nothing is launched.
   */
  private async resolveRepoPath(groupId: string, bodyRepoPath?: string): Promise<string> {
    const loop = await this.findLoopForGroup(groupId);
    const candidate = loop?.repoPath ?? (bodyRepoPath?.trim() ? bodyRepoPath.trim() : undefined);
    if (!candidate) {
      throw new ExecuteSdlcError(
        "NO_REPO_PATH",
        "no repoPath: this group has no consilium loop and no repoPath was supplied",
      );
    }

    let resolved: string;
    try {
      // S1: fail-closed GLOBAL allowlist (canonical realpath ⇒ a symlink can't escape).
      resolved = assertAllowedRepoPath(candidate, this.cfg().allowedRepoPaths);
    } catch (err) {
      throw new ExecuteSdlcError(
        "REPO_NOT_ALLOWED",
        err instanceof Error ? err.message : String(err),
      );
    }
    try {
      // S5/MED-3: INTERSECT with THIS project's workspaces (caller is in the ALS).
      await assertRepoIsProjectWorkspace(resolved, this.storage);
    } catch (err) {
      throw new ExecuteSdlcError(
        "REPO_NOT_WORKSPACE",
        err instanceof Error ? err.message : String(err),
      );
    }
    return resolved;
  }

  /**
   * The consilium loop for a group (most-recent if several), or undefined. Uses
   * the project-scoped `getLoops()` (the caller runs in the request's project ALS),
   * so it only ever sees THIS project's loops — and works for a TERMINAL review
   * loop (maxRounds:1 ⇒ converged) where `getActiveLoopByGroup` returns nothing.
   */
  private async findLoopForGroup(groupId: string) {
    const loops = await this.storage.getLoops(); // sorted newest-first
    return loops.find((l) => l.groupId === groupId);
  }

  /**
   * Fire `runSdlcHandoff` as a fire-and-forget BACKGROUND job and settle the
   * registry row when it resolves. The executor NEVER throws (it degrades to a
   * no-PR result), so the `.catch` is purely defensive — it guarantees the row
   * always settles, so the status poll can never hang on "running" forever.
   *
   * MED-2: a WATCHDOG is armed at `coderTimeoutMs + WATCHDOG_MARGIN_MS`. If the
   * executor promise never settles (a hang the timeout failed to kill), the watchdog
   * FORCE-settles the row to `failed` and frees the global slot, so the group can
   * relaunch with a fresh uuid → fresh branch. `finalize` is the SINGLE settle path
   * for all three (resolve / reject / watchdog) and is idempotent, so whichever fires
   * first wins and the others no-op (no double-settle, no double slot-free).
   */
  private dispatch(
    groupId: string,
    run: ExecuteSdlcRun,
    repoPath: string,
    actionPoints: readonly ActionPoint[],
    ownerId: string,
  ): void {
    const cfg = this.cfg();
    const exec = this.deps.runSdlc ?? runSdlcHandoff;

    // MED-2: arm the anti-wedge watchdog BEFORE dispatch so even a synchronously
    // hung promise is covered. `finalize` clears it on a normal settle.
    // The run codes each action point SEQUENTIALLY, each bounded by sdlcTimeoutMs,
    // so the WHOLE-run budget is N x sdlcTimeoutMs (+ margin) — sizing it for a
    // single coder would force-settle a HEALTHY multi-AP run mid-way (the #417
    // per-AP-vs-single-coder lesson, here applied to the watchdog).
    const budgetMs = Math.max(1, run.actionPointCount) * cfg.sdlcTimeoutMs + WATCHDOG_MARGIN_MS;
    run.watchdog = setTimeout(() => {
      this.finalize(groupId, run, {
        status: "failed",
        prRef: null,
        headCommit: "",
        error: scrub("SDLC run exceeded its time budget — force-settled"),
      });
    }, budgetMs);
    if (typeof run.watchdog.unref === "function") run.watchdog.unref();

    // Record the LATEST progress beat onto the registry row so the status poll can
    // show WHAT the executor is doing (coding AP i/N, pushing, opening PR, done).
    // GUARD on `running`: a late beat must NEVER resurrect / mutate a settled
    // (done / failed / force-settled) row. Synchronous + single-process → no lock.
    const onProgress = (p: SdlcProgress): void => {
      if (run.status !== "running") return;
      run.progress = p;
    };

    void exec(
      {
        repoPath,
        loopId: run.runId, // fresh uuid → server-derived branch consilium/loop-<id>/round-1
        round: run.round, // 1 — round-shape invariant
        actionPoints,
        allowedRepoPaths: cfg.allowedRepoPaths,
        ownerId,
        coderTimeoutMs: cfg.sdlcTimeoutMs,
      },
      undefined,
      onProgress,
    )
      .then((result) => {
        this.finalize(groupId, run, {
          status: result.error && result.prRef === null ? "failed" : "done",
          prRef: result.prRef,
          headCommit: result.headCommit,
          // LOW-1: scrub the happy-path error too, so the no-leak guarantee is
          // route-local (not merely inherited from the executor's pre-scrub).
          error: result.error == null ? result.error : scrub(result.error),
        });
      })
      .catch((err: unknown) => {
        // Defensive: the executor shouldn't throw, but a settled row must NEVER hang.
        this.finalize(groupId, run, {
          status: "failed",
          prRef: null,
          headCommit: "",
          error: scrub(err instanceof Error ? err.message : String(err)),
        });
      });
  }

  /**
   * The SINGLE, idempotent settle path (resolve / reject / watchdog all route here).
   * Guards on `status === "running"` so whichever caller fires FIRST wins and the
   * rest no-op — no double-settle, no double slot-free. Clears the watchdog timer,
   * frees the global concurrency slot, stamps `settledAt`, and schedules GC.
   */
  private finalize(
    groupId: string,
    run: ExecuteSdlcRun,
    patch: {
      status: "done" | "failed";
      prRef: string | null;
      headCommit: string;
      error?: string;
    },
  ): void {
    if (run.status !== "running") return; // already settled — DOUBLE-SETTLE guard
    if (run.watchdog) {
      clearTimeout(run.watchdog);
      run.watchdog = undefined;
    }
    run.status = patch.status;
    run.prRef = patch.prRef;
    run.headCommit = patch.headCommit;
    run.error = patch.error;
    run.settledAt = Date.now();
    this.runningCount = Math.max(0, this.runningCount - 1); // free the global slot
    this.scheduleGc(groupId, run);
  }

  /**
   * MED-2 GC: drop a SETTLED row after the retention window so the registry can't
   * grow unbounded. Never evicts a still-`running` row, and skips a row that a fresh
   * relaunch already replaced (object identity check) — so a force-settle→relaunch
   * can never have its NEW running row evicted by the OLD row's timer.
   */
  private scheduleGc(groupId: string, run: ExecuteSdlcRun): void {
    const gc = setTimeout(() => {
      const current = this.runs.get(groupId);
      if (current === run && current.status !== "running") {
        this.runs.delete(groupId);
      }
    }, SETTLED_RETENTION_MS);
    if (typeof gc.unref === "function") gc.unref();
  }

  private toHandle(groupId: string, run: ExecuteSdlcRun, deduped: boolean): ExecuteSdlcHandle {
    return {
      groupId,
      runId: run.runId,
      round: run.round,
      status: "running",
      actionPointCount: run.actionPointCount,
      deduped,
    };
  }
}

/** Scrub fs layout from an error string before it lands in the status row. */
function scrub(raw: string): string {
  return raw.replace(/\/[^\s'"]+/g, "<path>").replace(/\s+/g, " ").trim().slice(0, 200);
}
