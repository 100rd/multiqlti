/**
 * consilium-loop-controller.ts — B.3 of the consilium loop (design §3 FSM).
 *
 * The persisted FSM that drives an auto-versioned loop:
 *   design-idea → consilium debate (REVIEW) → decide → DEV → re-review,
 * until convergence / cap / anti-stall. State lives in `consilium_loops`; long
 * work (a consilium round, a DEV pipeline) runs as the EXISTING async
 * orchestrator/pipeline jobs. `tick()` is a single-flight reducer: it reads the
 * persisted state + the child job status, computes ONE transition via the PURE
 * `reduce(state, event)` function, then commits it with an atomic compare-and-
 * swap (Security H-3 — NO in-memory Set is the guard). It never blocks on long
 * work.
 *
 * Security acceptance criteria honoured here:
 *   H-3  every transition is `casLoopState(id, from, to, …)`; a lost CAS is a
 *        no-op (another tick/instance won). The one-active-loop-per-group rule
 *        is enforced by the DB partial-unique index at create time.
 *   M-2  `round` only ever increments (on entering REVIEWING); cancel/recreate
 *        or a 2nd start can never reset it to buy another `maxRounds` — the cap
 *        binds the loop row's lifetime, and a NEW loop on the same group is
 *        blocked while the old one is non-terminal.
 *   M-3  `headCommitAtReview` is captured on entering AWAITING_MERGE;
 *        `onMergeApproved` records the server-read merged HEAD as the next
 *        baseline and the delta vs `headCommitAtReview` (never a client sha).
 *   L-1  `prRef` is display-only — it never drives a merge.
 *
 * §14 (DEV→repo→PR close-out + non-blocking side effects):
 *   - `startReviewRound`/`startDevHandoff` use the NON-BLOCKING `startGroupAsync`
 *     (D.1) so the child ref (`currentIterationNumber`/`devGroupId`) is persisted
 *     on KICKOFF (milliseconds), not after the child completes. `deriveReviewEvent`
 *     /`deriveDevEvent` then poll the settled child to advance — they are now the
 *     primary completion driver (§14.5), not vestigial.
 *   - The DEVELOPING→AWAITING_MERGE side effect runs `DevPrCloseout` (D.5) to
 *     produce a REAL branch + Draft PR; `prRef` + `headCommitAtReview` are
 *     persisted on the won row (§14.4). The close-out runs ONLY on the CAS/claim
 *     winner (single-flight, §13) — a re-driven DEVELOPING never double-runs it;
 *     pr-wrapper's M-6/M-7 idempotency is the second line.
 *   - The DEV handoff's `pipeline_run` tasks carry the resolved `workspaceId`
 *     (D.2/D.3) so the DEV pipeline's read tools are grounded in the loop's repo.
 */
import type { IStorage } from "../../storage.js";
import { runAsSystem, runAsProject } from "../../context.js";
import type { ConsiliumLoopRow, ConsiliumLoopRoundRow, ConsiliumLoopState } from "@shared/schema";
import type { ActionPoint, ConvergenceVerdict } from "@shared/types";
import { P0_PRIORITY } from "@shared/types";
import type { TaskOrchestrator } from "../task-orchestrator.js";
import type { AppConfig } from "../../config/schema.js";
import { readConvergence } from "../orchestrator/convergence.js";
import { buildDiffContext } from "./diff-context.js";
import { buildDevHandoffGroup } from "./dev-handoff.js";
import { resolveLoopWorkspace, type WorkspaceBindStorage } from "./workspace-bind.js";
import { DevPrCloseout, type DevCloseoutResult } from "./dev-closeout.js";

// ─── FSM events (design §3 "Event / guard" column) ──────────────────────────

/** The discriminated event a `tick` derives from persisted + child-job state. */
export type LoopEvent =
  | { kind: "start" }
  | { kind: "context_built" }
  | { kind: "review_completed"; verdict: ConvergenceVerdict }
  | { kind: "review_failed"; error: string }
  | { kind: "decided"; verdict: ConvergenceVerdict; priorOpenP0: number[] }
  | { kind: "dev_completed"; prRef: string | null; headCommit: string }
  | { kind: "merge_approved" }
  | { kind: "cancel" };

/** A single FSM transition: CAS `from → to`, plus optional column updates. */
export interface LoopTransition {
  from: ConsiliumLoopState;
  to: ConsiliumLoopState;
  extra?: Record<string, unknown>;
}

const ANTI_STALL_MIN_ROUND = 3;

/**
 * Decide whether the open-P0 count failed to decrease across two consecutive
 * rounds (design §3 anti-stall). `series` is the per-round openP0 history,
 * oldest→newest, INCLUDING the round just decided.
 */
export function isAntiStall(series: number[], round: number): boolean {
  if (round < ANTI_STALL_MIN_ROUND || series.length < 3) return false;
  const [a, b, c] = series.slice(-3);
  return c >= b && b >= a;
}

/**
 * PURE reducer (design §3 table). Given the current persisted `state` and an
 * `event`, return the single transition to commit, or `null` for a no-op.
 * No storage, no I/O, no `any` — the whole table is unit-testable in isolation.
 */
export function reduce(state: ConsiliumLoopState, event: LoopEvent): LoopTransition | null {
  // `cancel` from any non-terminal state → CANCELLED (design §3 last row).
  if (event.kind === "cancel") {
    if (isTerminal(state)) return null;
    return { from: state, to: "cancelled", extra: { completedAt: new Date() } };
  }

  switch (state) {
    case "pending":
      if (event.kind === "start") return { from: "pending", to: "building_context" };
      return null;

    case "building_context":
      if (event.kind === "context_built") return { from: "building_context", to: "reviewing" };
      return null;

    case "reviewing":
      if (event.kind === "review_completed") return { from: "reviewing", to: "deciding" };
      if (event.kind === "review_failed") {
        return { from: "reviewing", to: "failed", extra: { error: event.error, completedAt: new Date() } };
      }
      return null;

    case "deciding":
      if (event.kind === "decided") return decide(event.verdict, event.priorOpenP0);
      return null;

    case "developing":
      if (event.kind === "dev_completed") {
        // §14.4: the REAL `prRef` + `headCommit` are produced by `DevPrCloseout`
        // in `runSideEffect` AFTER this CAS wins (so the close-out runs only on
        // the winning path). The event carries placeholders here; the won row's
        // follow-up `updateLoop` persists the real values. The transition still
        // seeds whatever the event happens to carry (null/"" by default).
        return {
          from: "developing",
          to: "awaiting_merge",
          extra: { prRef: event.prRef, headCommitAtReview: event.headCommit },
        };
      }
      return null;

    case "awaiting_merge":
      if (event.kind === "merge_approved") return { from: "awaiting_merge", to: "building_context" };
      return null;

    default:
      return null; // terminal states never transition
  }
}

/** DECIDING precedence: converged → cap → anti-stall → DEVELOPING (design §3). */
function decide(verdict: ConvergenceVerdict, priorOpenP0: number[]): LoopTransition {
  const completedAt = new Date();
  // 1. A clean verdict wins, even at the cap round (design §3 "round 6 clean").
  if (verdict.converged) {
    return { from: "deciding", to: "converged", extra: { completedAt } };
  }
  // 2. Cap: the last-allowed round produced open P0s → STOPPED_CAP.
  //    `priorOpenP0` already includes this round's count as its last element;
  //    its length is the round number reached.
  const round = priorOpenP0.length;
  // 3. Anti-stall: open_p0 flat (non-decreasing) across 2 consecutive rounds.
  if (isAntiStall(priorOpenP0, round)) {
    return { from: "deciding", to: "escalated", extra: { completedAt } };
  }
  // Caller decides cap by comparing round to maxRounds before calling reduce;
  // it injects the cap as a synthetic terminal below. Here, open P0s with room
  // left → hand off to DEV.
  return { from: "deciding", to: "developing" };
}

function isTerminal(state: ConsiliumLoopState): boolean {
  return (
    state === "converged" ||
    state === "stopped_cap" ||
    state === "escalated" ||
    state === "failed" ||
    state === "cancelled"
  );
}

// ─── Controller (impure shell around the pure reducer) ──────────────────────

export interface ConsiliumLoopControllerDeps {
  storage: IStorage;
  taskOrchestrator: TaskOrchestrator;
  config: () => AppConfig;
  /** Resolve the judge convergence verdict for a settled iteration. */
  readIterationVerdict?: (loop: ConsiliumLoopRow) => Promise<ConvergenceVerdict | null>;
  /**
   * Resolve the repo HEAD sha for audit / the merge-gate baseline. Injectable so
   * tests never touch real `process.cwd()` git (the default routes through A2's
   * buildDiffContext). Returns "" when unreadable (caller treats it as best-effort).
   */
  readRepoHead?: (loop: ConsiliumLoopRow) => Promise<string>;
  /**
   * §14.2/D.5 DEV→repo→PR close-out. Injectable so unit tests assert prRef flow
   * with a fake (no real repo / gh). The default runs the real `DevPrCloseout`
   * over the injected `closeoutManager` + the controller's `storage`.
   */
  runCloseout?: (loop: ConsiliumLoopRow, verdict: ConvergenceVerdict) => Promise<DevCloseoutResult>;
  /**
   * The `WorkspaceManager`-shaped seam the default close-out drives (branch +
   * write). Required only when `runCloseout` is NOT injected.
   */
  closeoutManager?: ConstructorParameters<typeof DevPrCloseout>[0]["manager"];
}

export class ConsiliumLoopController {
  /**
   * In-process single-flight (regression fix): loopIds whose `tick` — INCLUDING
   * its async side effect — is still running in THIS process. The persisted CAS
   * (H-3) stops cross-INSTANCE double-STATE-writes, but it does NOT stop SAME-
   * process re-entry while a long side effect (startGroup / createTaskGroup) is
   * in flight: the side effect writes the child ref only AFTER it resolves, so
   * the row legitimately sits in `reviewing`/`developing` with a null child ref
   * for seconds, and the 5s poller would otherwise re-enter and double-fire.
   * This lock + the grace guard below close that window. Both, not either.
   */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: ConsiliumLoopControllerDeps) {}

  private get storage(): IStorage {
    return this.deps.storage;
  }

  private loopConfig() {
    return this.deps.config().pipeline.consiliumLoop;
  }

  /** Structured controller log — one line per decision (loopId-scoped). */
  private log(loopId: string, msg: string): void {
    // eslint-disable-next-line no-console
    console.log(`[consilium-loop] ${loopId} ${msg}`);
  }

  /**
   * Grace window before a null-child-ref loop is treated as crash-stranded:
   * max(2x poll interval, 30s). An in-flight side effect (seconds) must never be
   * re-driven; only a loop whose `updatedAt` predates this window — i.e. the
   * state was persisted and then the process died — is re-driven.
   */
  private redriveGraceMs(): number {
    return Math.max(2 * this.loopConfig().pollIntervalMs, 30_000);
  }

  /** Begin round 1. 409s (returns null) unless the loop is PENDING. */
  async start(loopId: string): Promise<ConsiliumLoopRow | null> {
    const loop = await this.storage.getLoop(loopId);
    if (!loop || loop.state !== "pending") return null;
    return this.tick(loopId);
  }

  /**
   * The HITL merge gate: a maintainer/admin confirms the PR merged → resume into
   * round n+1 (design §3). M-3 (TOCTOU): the merged HEAD is read SERVER-side here
   * (never the client-supplied `clientHead`, which is ignored) and becomes the
   * next round's baseline. We record any delta vs `headCommitAtReview` so a
   * mid-gate force-push between review and approval is auditable.
   */
  async onMergeApproved(loopId: string, _clientHead?: string): Promise<ConsiliumLoopRow | null> {
    const loop = await this.storage.getLoop(loopId);
    if (!loop || loop.state !== "awaiting_merge") return null;
    const mergedHead = await this.readRepoHead(loop); // SERVER-read, never client.
    const transition = reduce(loop.state, { kind: "merge_approved" });
    if (!transition) return null;
    // Audit the delta vs the HEAD we reviewed (M-3); empty string = unreadable.
    const error =
      mergedHead && loop.headCommitAtReview && mergedHead !== loop.headCommitAtReview
        ? `merged HEAD ${mergedHead} differs from reviewed HEAD ${loop.headCommitAtReview}`
        : null;
    return this.commit(loop, transition, {
      lastReviewedCommit: mergedHead || loop.headCommitAtReview,
      error,
    });
  }

  /** Cancel + cascade-cancel the child group; terminal. */
  async cancel(loopId: string): Promise<ConsiliumLoopRow | null> {
    const loop = await this.storage.getLoop(loopId);
    if (!loop || isTerminal(loop.state)) return null;
    const transition = reduce(loop.state, { kind: "cancel" });
    if (!transition) return null;
    await this.deps.taskOrchestrator.cancelGroup(loop.groupId).catch(() => undefined);
    return this.commit(loop, transition);
  }

  /**
   * Advance the loop by exactly one transition. Single-flight via CAS: the event
   * is derived from persisted + child-job state, fed to the pure `reduce`, then
   * committed with `casLoopState`. A lost CAS (concurrent tick) is a silent
   * no-op — `tick` NEVER blocks on long work.
   */
  async tick(loopId: string): Promise<ConsiliumLoopRow | null> {
    // In-process single-flight: a tick for THIS loopId must not re-enter while
    // its prior tick (incl. the async side effect) is still running in this
    // process — that re-entry is exactly what double-fired the review iteration.
    if (this.inFlight.has(loopId)) {
      this.log(loopId, "tick skipped — already in flight in this process");
      return null;
    }
    this.inFlight.add(loopId);
    try {
      return await this.tickInner(loopId);
    } finally {
      this.inFlight.delete(loopId);
    }
  }

  private async tickInner(loopId: string): Promise<ConsiliumLoopRow | null> {
    const loop = await this.storage.getLoop(loopId);
    if (!loop || isTerminal(loop.state)) return null;

    // Liveness (crash-window fix): the CAS-first reorder claims the new state
    // BEFORE the follow-up updateLoop writes the child ref. A crash in that
    // window strands the loop holding the state claim with a NULL child ref, and
    // the pollers dead-end (deriveDev/ReviewEvent return null on a null ref).
    // Re-drive it — but ONLY after the grace window, so an in-flight side effect
    // (the row is legitimately null-ref for seconds) is never mistaken for a
    // crash. The in-process lock above + this grace guard together close the
    // window the original null-only guard left open.
    const redriven = await this.redriveStranded(loop);
    if (redriven) return redriven;

    const event = await this.deriveEvent(loop);
    if (!event) {
      this.log(loopId, `no-op in state=${loop.state} (no event)`);
      return null;
    }

    // Cap precedence (M-2): a `decided` event at the cap round with open P0s is
    // STOPPED_CAP — but a CONVERGED verdict still wins (handled in `decide`).
    if (event.kind === "decided" && !event.verdict.converged && loop.round >= loop.maxRounds) {
      return this.commit(loop, {
        from: "deciding",
        to: "stopped_cap",
        extra: { completedAt: new Date() },
      });
    }

    const transition = reduce(loop.state, event);
    if (!transition) return null;

    // H-3 (BLOCKER fix): CLAIM the transition with the CAS FIRST, then run any
    // non-idempotent side effect (createTaskGroup / startGroup / the DevPrCloseout
    // branch+push+PR — all mint NEW external state with no idempotency key) ONLY
    // on the row that WON the CAS. Under multi-instance (>=2 pollers reading the
    // same `deciding`/`developing` row) exactly one CAS updates a row; the loser
    // gets `undefined` -> null no-op -> NO side effect, so the DEV group / review
    // iteration / the close-out PR can never double-fire. Child refs + prRef are
    // persisted AFTER the side effect via a follow-up updateLoop on the won row.
    const won = await this.commit(loop, transition);
    if (!won) {
      this.log(loopId, `CAS lost ${transition.from}->${transition.to} (another tick won)`);
      return null; // lost the CAS race -> no side effect runs
    }
    this.log(loopId, `CAS won ${transition.from}->${transition.to}`);

    const extra = await this.runSideEffect(won, transition, event);
    if (Object.keys(extra).length === 0) return won;
    return this.storage.updateLoop(won.id, extra);
  }

  /** Commit a transition via the atomic CAS (H-3). Lost race → null no-op. */
  private async commit(
    loop: ConsiliumLoopRow,
    transition: LoopTransition,
    extra?: Record<string, unknown>,
  ): Promise<ConsiliumLoopRow | null> {
    const merged = { ...(transition.extra ?? {}), ...(extra ?? {}) };
    return (
      (await this.storage.casLoopState(loop.id, transition.from, transition.to, merged)) ?? null
    );
  }

  /**
   * Recover a loop stranded by a crash between the CAS claim and the child-ref
   * write. A null child ref alone is ambiguous — EITHER "side effect in flight"
   * (normal, seconds) OR "crashed mid-transition". We disambiguate AND make the
   * re-drive cross-instance single-flight with an ATOMIC DB CLAIM
   * (`storage.claimRedrive`): a conditional UPDATE that matches only a row still
   * in `expected` state, with its child ref NULL, stranded past the grace window
   * (`updatedAt < now - grace`), and bumps `updatedAt`. The FIRST instance's
   * UPDATE moves `updatedAt` to now, so a concurrent second instance's grace
   * predicate fails → 0 rows → it backs off. The non-idempotent side effect runs
   * ONLY for the claim winner — closing the cross-instance re-drive double-fire
   * (same H-3 class as casLoopState). The in-process Set (cheap same-process
   * guard) + this DB claim (authoritative cross-instance guard) together.
   */
  private async redriveStranded(loop: ConsiliumLoopRow): Promise<ConsiliumLoopRow | null> {
    const nullRef =
      (loop.state === "reviewing" && loop.currentIterationNumber == null) ||
      (loop.state === "developing" && loop.devGroupId == null);
    if (!nullRef) return null; // child ref set — not stranded, advance normally

    const ageMs = Date.now() - new Date(loop.updatedAt).getTime();
    if (ageMs < this.redriveGraceMs()) {
      this.log(loop.id, `null child ref in ${loop.state} but within grace (${ageMs}ms) — assume in-flight, no re-drive`);
      return null; // in-flight side effect — must NOT re-drive (cheap pre-check)
    }

    // Cross-instance ATOMIC claim: only the winner proceeds (H-3 re-drive guard).
    const claimed = await this.storage.claimRedrive(loop.id, loop.state, this.redriveGraceMs());
    if (!claimed) {
      this.log(loop.id, `re-drive claim lost in ${loop.state} (another instance is re-driving) — no-op`);
      return null;
    }

    this.log(loop.id, `re-drive CLAIMED stranded ${loop.state} (age ${ageMs}ms > grace) — running side effect`);
    if (claimed.state === "reviewing") {
      const extra = await this.startReviewRound(claimed);
      return Object.keys(extra).length === 0 ? claimed : this.storage.updateLoop(claimed.id, extra);
    }
    // developing
    const verdict = await this.resolveVerdict(claimed);
    if (!verdict) {
      this.log(claimed.id, "re-drive developing aborted — verdict unreadable");
      return null;
    }
    const extra = await this.startDevHandoff(claimed, verdict);
    return Object.keys(extra).length === 0 ? claimed : this.storage.updateLoop(claimed.id, extra);
  }

  /**
   * Translate persisted + child-job status into the FSM event for this state.
   * Returns null when the loop is waiting on long work (no transition yet).
   */
  private async deriveEvent(loop: ConsiliumLoopRow): Promise<LoopEvent | null> {
    switch (loop.state) {
      case "pending":
        return { kind: "start" };
      case "building_context":
        return { kind: "context_built" };
      case "reviewing":
        return this.deriveReviewEvent(loop);
      case "deciding":
        return this.deriveDecideEvent(loop);
      case "developing":
        return this.deriveDevEvent(loop);
      default:
        return null; // awaiting_merge advances only via onMergeApproved
    }
  }

  /** REVIEWING: poll the consilium iteration; settle → completed/failed. */
  private async deriveReviewEvent(loop: ConsiliumLoopRow): Promise<LoopEvent | null> {
    const n = loop.currentIterationNumber;
    if (n == null) return null;
    const iteration = await this.storage.getIteration(loop.groupId, n);
    if (!iteration) return null;
    if (iteration.status === "completed") {
      const verdict = await this.resolveVerdict(loop);
      if (!verdict) return { kind: "review_failed", error: "judge verdict unreadable" };
      return { kind: "review_completed", verdict };
    }
    if (iteration.status === "failed" || iteration.status === "cancelled") {
      return { kind: "review_failed", error: `consilium iteration ${iteration.status}` };
    }
    return null; // still running
  }

  /** DECIDING: re-resolve the verdict + assemble the per-round openP0 history. */
  private async deriveDecideEvent(loop: ConsiliumLoopRow): Promise<LoopEvent | null> {
    const verdict = await this.resolveVerdict(loop);
    if (!verdict) return null;
    const rounds = await this.storage.getLoopRounds(loop.id);
    const priorOpenP0 = rounds.map((r) => r.openP0 ?? 0);
    priorOpenP0.push(verdict.openP0); // include the round just decided
    return { kind: "decided", verdict, priorOpenP0 };
  }

  /**
   * DEVELOPING: poll the DEV handoff group; completed → open the merge gate.
   *
   * §14.4: this returns a PLACEHOLDER `dev_completed` (prRef null / headCommit
   * "") — the REAL `prRef` + `headCommit` come from `DevPrCloseout`, which runs
   * in `runSideEffect` AFTER the `developing→awaiting_merge` CAS WINS, so the
   * close-out (a non-idempotent branch+push+PR) runs ONLY on the winning path
   * (single-flight, §13). Running it here would let a losing tick open a
   * duplicate PR before the CAS rejects it.
   */
  private async deriveDevEvent(loop: ConsiliumLoopRow): Promise<LoopEvent | null> {
    if (!loop.devGroupId) return null;
    const group = await this.storage.getTaskGroup(loop.devGroupId);
    if (!group) return null;
    if (group.status === "completed") {
      return { kind: "dev_completed", prRef: null, headCommit: "" };
    }
    if (group.status === "failed" || group.status === "cancelled") {
      return { kind: "review_failed", error: `DEV group ${group.status}` };
    }
    return null;
  }

  /**
   * Run a transition's side effect, returning the extra columns the CAS must
   * persist atomically with the state change. Each branch is <30 lines and
   * single-responsibility; the CAS that PRECEDED this call makes them run on the
   * winning path only (single-flight).
   */
  private async runSideEffect(
    loop: ConsiliumLoopRow,
    transition: LoopTransition,
    event: LoopEvent,
  ): Promise<Record<string, unknown>> {
    if (transition.to === "reviewing") return this.startReviewRound(loop);
    if (transition.to === "developing" && event.kind === "decided") {
      return this.startDevHandoff(loop, event.verdict);
    }
    // §14.4: DEVELOPING→AWAITING_MERGE — run the close-out on the WON row and
    // persist the real prRef + reviewed HEAD. The verdict (open action points)
    // is re-resolved here for the close-out artifact body.
    if (transition.to === "awaiting_merge") return this.runDevCloseout(loop);
    return {};
  }

  /**
   * DEVELOPING→AWAITING_MERGE side effect (§14.2/§14.4). Runs `DevPrCloseout`
   * (real branch + Draft PR) and returns `{ prRef, headCommitAtReview, error? }`
   * for the follow-up `updateLoop` on the won row. The close-out NEVER throws
   * (branch-only fallback on any VCS failure) so the loop is never failed here.
   * Runs ONLY on the CAS winner — a re-driven DEVELOPING never double-runs it.
   */
  private async runDevCloseout(loop: ConsiliumLoopRow): Promise<Record<string, unknown>> {
    const verdict = await this.resolveVerdict(loop);
    if (!verdict) {
      this.log(loop.id, "close-out skipped — verdict unreadable; AWAITING_MERGE with null prRef");
      return { prRef: null, error: "verdict unreadable at close-out" };
    }
    const result = await this.closeout(loop, verdict);
    this.log(loop.id, `close-out done -> prRef=${result.prRef ?? "null"}${result.error ? ` (${result.error})` : ""}`);
    return {
      prRef: result.prRef,
      headCommitAtReview: result.headCommit,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  /** Resolve the close-out fn: injected fake (tests) or the real DevPrCloseout. */
  private async closeout(
    loop: ConsiliumLoopRow,
    verdict: ConvergenceVerdict,
  ): Promise<DevCloseoutResult> {
    if (this.deps.runCloseout) return this.deps.runCloseout(loop, verdict);
    const cfg = this.loopConfig();
    if (!this.deps.closeoutManager) {
      return { prRef: null, headCommit: "", error: "no close-out manager configured" };
    }
    const closeout = new DevPrCloseout({
      manager: this.deps.closeoutManager,
      storage: this.storage as unknown as WorkspaceBindStorage,
    });
    return closeout.run({
      loopId: loop.id,
      round: loop.round,
      repoPath: loop.repoPath,
      ownerId: loop.createdBy ?? "",
      allowedRepoPaths: cfg.allowedRepoPaths,
      openActionPoints: verdict.openActionPoints,
    });
  }

  /**
   * BUILDING_CONTEXT → REVIEWING: build A2 diff-context, seed the group input,
   * start the consilium round NON-BLOCKINGLY (D.1 `startGroupAsync`), record the
   * new iteration number + incremented round. The child ref is persisted on
   * KICKOFF (milliseconds) — `deriveReviewEvent` then polls the settle (§14.5).
   * `round` only ever increments here (M-2).
   */
  private async startReviewRound(loop: ConsiliumLoopRow): Promise<Record<string, unknown>> {
    const cfg = this.loopConfig();
    const group = await this.storage.getTaskGroup(loop.groupId);
    const objective = group?.input ?? "";
    // Enh1: for every review AFTER the first (loop.round >= 1), inject the prior
    // rounds' still-open findings so the debaters VERIFY CLOSURE against the new
    // diff instead of re-discovering or circling. Round 1 (loop.round === 0,
    // baselineCommit null) is unchanged: objective-only, no history.
    const priorFindings =
      loop.round >= 1 ? await this.buildPriorFindings(loop, cfg.maxDiffBytes) : undefined;
    const ctx = await buildDiffContext({
      repoPath: loop.repoPath,
      baselineCommit: loop.lastReviewedCommit,
      objective,
      allowedRepoPaths: cfg.allowedRepoPaths,
      maxDiffBytes: cfg.maxDiffBytes,
      priorFindings,
    });
    if (!ctx.ok) {
      // Surface the (scrubbed) git failure as a loop error; the next tick from
      // REVIEWING with no iteration will not advance — recorded for the human.
      return { error: ctx.message };
    }
    await this.storage.updateTaskGroup(loop.groupId, { input: ctx.input });
    this.log(loop.id, `startReviewRound -> startGroupAsync(group=${loop.groupId}) round ${loop.round + 1}`);
    // §14.5: NON-BLOCKING — returns the instant the iteration row is created, NOT
    // after the consilium round completes. The child runs in the background and
    // settles the iteration; `deriveReviewEvent` polls that settle.
    const { iteration } = await this.deps.taskOrchestrator.startGroupAsync(loop.groupId, {
      triggeredBy: loop.createdBy,
    });
    this.log(loop.id, `startReviewRound done -> iteration #${iteration.iterationNumber} (dispatched)`);
    return {
      round: loop.round + 1,
      currentIterationNumber: iteration.iterationNumber,
      openP0: null,
    };
  }

  /**
   * DECIDING → DEVELOPING: persist the round audit row, resolve the loop's
   * workspace (D.3, grounds the DEV pipeline's read tools §14.3), then hand the
   * open action points to the DEV pipeline as a `pipeline_run` group started
   * NON-BLOCKINGLY (D.1). `devGroupId` is persisted on KICKOFF (§14.5).
   */
  private async startDevHandoff(
    loop: ConsiliumLoopRow,
    verdict: ConvergenceVerdict,
  ): Promise<Record<string, unknown>> {
    const devPipelineId = loop.devPipelineId ?? this.loopConfig().devPipelineId;
    if (!devPipelineId) {
      return { state: "escalated", error: "no DEV pipeline configured", completedAt: new Date() };
    }
    await this.recordRound(loop, verdict);
    const workspaceId = await this.resolveWorkspaceId(loop); // §14.3 grounding.
    const payload = buildDevHandoffGroup({
      openActionPoints: verdict.openActionPoints,
      devPipelineId,
      source: loop.id,
      createdBy: loop.createdBy ?? undefined,
      workspaceId,
    });
    this.log(loop.id, `startDevHandoff -> createTaskGroup (${verdict.openActionPoints.length} action points, ws=${workspaceId ?? "none"})`);
    const { group } = await this.deps.taskOrchestrator.createTaskGroup(payload);
    // §14.5: NON-BLOCKING — `devGroupId` is persisted on KICKOFF; `deriveDevEvent`
    // polls the DEV group's settle to open the merge gate.
    await this.deps.taskOrchestrator.startGroupAsync(group.id, { triggeredBy: loop.createdBy });
    this.log(loop.id, `startDevHandoff done -> devGroup ${group.id} (dispatched)`);
    return { devGroupId: group.id, openP0: verdict.openP0 };
  }

  /**
   * §14.3: resolve (scan-or-create) the `local` workspace bound to the loop's
   * repo so the DEV handoff's read tools are grounded in the repo. Best-effort:
   * a bind failure (non-allowlisted path / fs error) must NOT block the handoff
   * — it degrades to today's no-workspace behaviour (undefined).
   */
  private async resolveWorkspaceId(loop: ConsiliumLoopRow): Promise<string | undefined> {
    try {
      const ws = await resolveLoopWorkspace(
        this.storage as unknown as WorkspaceBindStorage,
        loop.repoPath,
        loop.createdBy ?? "",
        this.loopConfig().allowedRepoPaths,
      );
      return ws.id;
    } catch (err) {
      this.log(loop.id, `workspace bind failed (DEV runs without workspace): ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * Enh1: assemble the "prior findings to verify" block for round > 1 from the
   * persisted per-round verdict rows (`consilium_loop_rounds.openActionPoints`).
   * Best-effort: a storage failure or empty history yields `undefined` (no
   * history injected — round proceeds as before). Bounded oldest-first to
   * `budgetBytes` by `formatPriorFindings`.
   */
  private async buildPriorFindings(
    loop: ConsiliumLoopRow,
    budgetBytes: number,
  ): Promise<string | undefined> {
    let rounds: ConsiliumLoopRoundRow[];
    try {
      rounds = await this.storage.getLoopRounds(loop.id);
    } catch (err) {
      this.log(loop.id, `buildPriorFindings: getLoopRounds failed (no history injected): ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    return formatPriorFindings(rounds, budgetBytes) ?? undefined;
  }

  /** Persist this round's audit row (NEVER the raw diff/input — H-4). */
  private async recordRound(loop: ConsiliumLoopRow, verdict: ConvergenceVerdict): Promise<void> {
    const head = await this.readRepoHead(loop);
    await this.storage
      .appendLoopRound({
        loopId: loop.id,
        round: loop.round,
        iterationNumber: loop.currentIterationNumber ?? loop.round,
        converged: verdict.converged,
        openP0: verdict.openP0,
        openActionPoints: verdict.openActionPoints,
        baselineCommit: loop.lastReviewedCommit,
        headCommit: head,
      })
      .catch(() => undefined); // UNIQUE(loop,round) → idempotent re-tick
  }

  /** Resolve the judge convergence verdict for the loop's current iteration. */
  private async resolveVerdict(loop: ConsiliumLoopRow): Promise<ConvergenceVerdict | null> {
    if (this.deps.readIterationVerdict) return this.deps.readIterationVerdict(loop);
    const n = loop.currentIterationNumber;
    if (n == null) return null;
    const iteration = await this.storage.getIteration(loop.groupId, n);
    if (!iteration) return null;
    const executions = await this.storage.getExecutionsByIteration(loop.groupId, iteration.id);
    const judgeOutput = pickJudgeOutput(executions.map((e) => e.output));
    if (judgeOutput === undefined) return null;
    return readConvergence(judgeOutput);
  }

  /** Best-effort HEAD read for audit; bounded, never throws (H-4 scrubbed). */
  private async readRepoHead(loop: ConsiliumLoopRow): Promise<string> {
    if (this.deps.readRepoHead) return this.deps.readRepoHead(loop);
    const cfg = this.loopConfig();
    const ctx = await buildDiffContext({
      repoPath: loop.repoPath,
      baselineCommit: null,
      objective: "",
      allowedRepoPaths: cfg.allowedRepoPaths,
      maxDiffBytes: cfg.maxDiffBytes,
    });
    return ctx.ok ? ctx.headCommit : "";
  }
}

/**
 * Pick the judge execution's `output` from an iteration's executions. Prefers an
 * output carrying `action_points` (the judge), else the first with a verdict —
 * server port of `verdict-panel.tsx extractVerdict` (~L49). Returns `undefined`
 * when no execution carries a parseable verdict.
 */
export function pickJudgeOutput(outputs: unknown[]): unknown {
  let fallback: unknown;
  for (const o of outputs) {
    if (!o || typeof o !== "object" || Array.isArray(o)) continue;
    const obj = o as Record<string, unknown>;
    const aps = Array.isArray(obj.action_points)
      ? (obj.action_points as unknown[]).filter(
          (a): a is ActionPoint =>
            !!a && typeof a === "object" && typeof (a as ActionPoint).title === "string",
        )
      : [];
    const hasVerdict = typeof obj.verdict === "string";
    const hasConvergence = obj.convergence !== undefined;
    if (aps.length === 0 && !hasVerdict && !hasConvergence) continue;
    if (aps.length > 0 || hasConvergence) return o; // the judge — take it
    fallback = fallback ?? o;
  }
  return fallback;
}

/**
 * Enh1: format the round-history block injected into reviews after the first
 * (round > 1). For each EARLIER round it lists the still-open action points
 * (title + priority) persisted in `consilium_loop_rounds.openActionPoints`, plus
 * the open-P0 trend across rounds, so the debaters confirm CLOSURE of prior items
 * against the new diff rather than re-discovering them or circling.
 *
 * Bounding (treated as INERT prior-verdict text — never executed): the whole
 * block is kept within `budgetBytes` by dropping WHOLE rounds OLDEST-first and
 * noting how many were omitted. If even the newest round's detail will not fit,
 * a header-only block (trend + a "detail omitted" note) is returned; if not even
 * that fits, returns `null` (nothing injected). A `diff-context` byte clamp is a
 * second, defensive backstop.
 *
 * Note on provenance: the per-round verdict (titles + priorities) IS persisted
 * per round in `consilium_loop_rounds.openActionPoints` (jsonb ActionPoint[]),
 * so no fallback-to-counts-only is needed; rows whose action points are absent
 * (e.g. an unreadable verdict at record time) degrade to their openP0 count.
 */
export function formatPriorFindings(
  rounds: ConsiliumLoopRoundRow[],
  budgetBytes: number,
): string | null {
  if (rounds.length === 0) return null;
  const ordered = [...rounds].sort((a, b) => a.round - b.round);

  const trend = ordered.map((r) => r.openP0 ?? 0).join(" -> ");
  const header =
    "## Prior findings to verify (from earlier rounds)\n\n" +
    "Earlier rounds flagged the items below. For EACH item: confirm it is ACTUALLY " +
    "closed by the changes above, or flag it as still-open / regressed. Do NOT " +
    "re-discover items already listed here — only raise genuinely NEW issues.\n\n" +
    `Open P0 trend across rounds: ${trend}`;

  const chunkFor = (r: ConsiliumLoopRoundRow): string => {
    const aps = Array.isArray(r.openActionPoints) ? r.openActionPoints : [];
    const p0 =
      r.openP0 ??
      aps.filter((a) => (a.priority ?? "").toUpperCase() === P0_PRIORITY).length;
    const headline = `### Round ${r.round} (${aps.length} open${p0 ? `, ${p0} P0` : ""})`;
    if (aps.length === 0) {
      return `${headline}\n- _no structured action points recorded for this round (open P0: ${r.openP0 ?? "unknown"})_`;
    }
    const lines = aps.map((a) => `- [${(a.priority ?? "P?").toUpperCase()}] ${a.title}`);
    return `${headline}\n${lines.join("\n")}`;
  };

  const chunks = ordered.map(chunkFor);
  const assemble = (kept: string[], omitted: number): string => {
    const note =
      omitted > 0 ? `\n\n_(${omitted} earlier round(s) omitted to fit the size budget)_` : "";
    return `${header}${note}\n\n${kept.join("\n\n")}`;
  };

  let kept = chunks.slice();
  let omitted = 0;
  while (kept.length > 0 && Buffer.byteLength(assemble(kept, omitted), "utf8") > budgetBytes) {
    kept.shift(); // drop the OLDEST round first
    omitted += 1;
  }
  if (kept.length === 0) {
    const minimal = `${header}\n\n_(all ${omitted} round(s) of detail omitted to fit the size budget; see the P0 trend above)_`;
    return Buffer.byteLength(minimal, "utf8") > budgetBytes ? null : minimal;
  }
  return assemble(kept, omitted);
}

/**
 * ConsiliumLoopPoller — the restart-safe backstop driver (design §7). On an
 * interval it sweeps every NON-terminal loop and `tick`s it. `tick` is single-
 * flight via the persisted CAS (H-3), so a poller tick that races an event-tick
 * (or another instance) is a harmless no-op. The poller is constructed ONLY when
 * `config.consiliumLoop.enabled` — a normal boot leaves it null (kill-switch).
 */
export class ConsiliumLoopPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    private readonly controller: ConsiliumLoopController,
    private readonly storage: IStorage,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sweep: tick every non-terminal loop. Errors are swallowed per-loop. */
  private async sweep(): Promise<void> {
    if (this.sweeping) return; // never overlap sweeps
    this.sweeping = true;
    try {
      // Cross-project sweep of every non-terminal loop, under an audited system
      // context. Per-loop tick() keeps its existing (context-free) behavior.
      const loops = await runAsSystem("consilium-loop-poller-sweep", () =>
        this.storage.getLoops(),
      );
      for (const loop of loops) {
        // tick() calls project-scoped storage (getTaskGroup/updateLoop/startGroupAsync
        // inserts) which fail-close without an ALS context. A loop belongs to a
        // project via its group → run the tick inside that project's context so
        // every scoped read/write resolves correctly. Fall back to a system
        // context only if the group's project can't be resolved.
        const group = await runAsSystem("consilium-loop-resolve-project", () =>
          this.storage.getTaskGroup(loop.groupId),
        ).catch(() => null);
        const projectId = group?.projectId ?? null;
        const runTick = () => this.controller.tick(loop.id);
        await (projectId
          ? runAsProject(projectId, runTick)
          : runAsSystem("consilium-loop-tick", runTick)
        ).catch(() => undefined);
      }
    } catch {
      // a transient storage error must not kill the interval
    } finally {
      this.sweeping = false;
    }
  }
}
