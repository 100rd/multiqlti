/**
 * writeback-observer.ts — TRACK-2: the READ-ONLY loop-state observer that keeps a
 * tracker-born issue a LIVE RECORD. It watches consilium loops that trace back to
 * an origin ticket and comments each lifecycle transition (start / verdict / PR /
 * terminal) back on that issue (task-tracker-triggers.md §4).
 *
 * WHY READ-ONLY (SPEC-2's zone is off-limits)
 *   The loop controller (`consilium-loop-controller.ts`) and the spec-review
 *   dispatch are owned by a PARALLEL team (SPEC-2). This observer NEVER imports or
 *   mutates the controller. It only READS loop rows via the same `storage.getLoops`
 *   path the Triggers page already uses (GET /api/triggers/:id/loops) and writes
 *   COMMENTS to GitHub — nothing about the loop's own state machine is touched.
 *
 * THE JOIN (provenance, not coupling)
 *   TRACK-1 stamps a spec's frontmatter `source: { kind:"github", ref:"<n>", url }`;
 *   SPEC-1 folds that into the fired loop's `triggerProvenance.spec.source`. So a
 *   loop whose `spec.source.kind === "github"` and whose `source.url` sits under a
 *   tracker trigger's `repo` traces to issue `source.ref` in that repo. That is the
 *   ONLY link between a loop and its origin ticket — no controller callback.
 *
 * RAILS (adversarial)
 *   (a) NEVER DOUBLE-POST A PHASE — every comment carries a hidden marker keyed by
 *       loopId+phase (issue is implicit). The marker lives on the DURABLE issue, so
 *       dedup survives a process restart (this observer keeps NO persisted state;
 *       the issue itself is the ledger). One `gh` READ per issue per cycle fetches
 *       all comments; markers are then checked IN MEMORY.
 *   (b) NON-TRACKER LOOPS — a loop with no `spec.source` (human/API/file_change
 *       loop) is filtered out up front and NEVER commented on.
 *   (c) CLOSED ISSUES — the code PR's `Closes #N` closes the issue natively on
 *       merge; the observer does NOT comment on a closed issue (leave the resolved
 *       ticket alone), unless `writeback.reopenOnFailure` and the loop ended in a
 *       non-converged terminal state.
 *   (d) `gh` OUTAGE — `fetchIssueView` degrades to `null` ⇒ the loop is SKIPPED
 *       (cannot read ⇒ do not post), never a crash. Each trigger + each cycle is
 *       guarded so one failure never stops the others.
 *   (e) NOT HAMMERING `gh` — the observer rides the tracker poll interval (min 60s)
 *       and bounds work per cycle: only loops updated within OBSERVE_MAX_AGE_MS are
 *       considered, capped at OBSERVE_MAX_PER_CYCLE (most-recently-updated first).
 *   (f) RACE WITH TRACK-1's PICKUP — TRACK-2 markers live in a DISTINCT namespace
 *       (`factory:track2:*`), so the pickup comment and the start comment never
 *       collide.
 *
 * SECURITY
 *   The `gh` token is never read/logged (shared `gh` seams). `repo` is shape-
 *   validated; `issueNumber` is derived from `source.ref` and integer-validated —
 *   nothing attacker-shaped is ever read as a flag. Loop/user-authored text (the
 *   #486 explanation, the cancellation `error`) is sanitised (control-stripped,
 *   marker-neutralised, clamped) and only ever posted via `--body-file`.
 */
import type { TriggerRow, ConsiliumLoopRow } from "@shared/schema";
import { CONSILIUM_LOOP_TERMINAL_STATES } from "@shared/schema";
import type { TrackerEventTriggerConfig } from "@shared/types";
import { explainLoopState } from "@shared/loop-status";
import type { AppConfig } from "../../../config/schema.js";
import type { ExecFileFn } from "../../github-status.js";
import {
  fetchIssueView,
  postStartComment,
  postPrOpenedComment,
  postVerdictComment,
  postTerminalComment,
  reopenIssue,
  type WritebackDeps,
} from "./issue-writeback.js";

/** `owner/repo` — conservative GitHub name charset (no leading dash / no flag). */
const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** Max loops the observer inspects per trigger per cycle (bounds `gh` reads). */
const OBSERVE_MAX_PER_CYCLE = 50;
/** Only observe loops updated within this window — a long-resolved ticket is done. */
const OBSERVE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const TERMINAL = new Set<string>(CONSILIUM_LOOP_TERMINAL_STATES);
/** Non-converged terminals — the "needs a human" outcomes (§4 status-explanation). */
const FAILED_TERMINAL = new Set<string>(["stopped_cap", "escalated", "failed"]);

export interface TrackerWritebackObserverDeps {
  /** Cross-project, SYSTEM-context load of enabled tracker_event triggers (runAsSystem). */
  getEnabledTriggersByType: (type: "tracker_event") => Promise<TriggerRow[]>;
  /** Establish a project-scoped ALS context for one trigger's pass (= runAsProject). */
  runInProject: <T>(projectId: string, fn: () => Promise<T>) => Promise<T>;
  /** Project-scoped read of consilium loops (the SAME path the Triggers page uses). */
  getLoops: () => Promise<ConsiliumLoopRow[]>;
  /** Live config accessor (kill-switches + interval). */
  config: () => AppConfig;
  /** Injectable `gh` runner (tests pass a fake — no real `gh`/network). */
  runGh?: ExecFileFn;
  /** Structured logger. */
  log: (message: string) => void;
  /** Injectable clock (tests). */
  now?: () => number;
}

/** Which lifecycle rows a given loop should attempt this cycle. */
interface Plan {
  start: boolean;
  prOpened: boolean;
  verdict: boolean;
  terminal: boolean;
}

export class TrackerWritebackObserver {
  private readonly deps: TrackerWritebackObserverDeps;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private observing = false;

  constructor(deps: TrackerWritebackObserverDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Start the interval observer IFF `tracker.enabled && tracker.writeback.enabled`.
   * Rides the tracker `pollIntervalSec`. Idempotent.
   */
  start(): void {
    if (this.timer) return;
    const cfg = this.deps.config().features.triggers.tracker;
    if (!cfg.enabled || !cfg.writeback.enabled) {
      this.deps.log("tracker write-back disabled — observer not started");
      return;
    }
    const intervalMs = cfg.pollIntervalSec * 1000;
    this.timer = setInterval(() => void this.observeAllSafe(), intervalMs);
    this.timer.unref?.();
    this.deps.log(`tracker write-back observer started (every ${cfg.pollIntervalSec}s)`);
  }

  /** Stop the interval observer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One pass, fully guarded — a throw here must never kill the interval. */
  async observeAllSafe(): Promise<void> {
    if (this.observing) return; // never overlap passes.
    this.observing = true;
    try {
      await this.observeAll();
    } catch (e) {
      this.deps.log(`tracker write-back pass error: ${(e as Error).message}`);
    } finally {
      this.observing = false;
    }
  }

  /**
   * Observe every enabled tracker_event trigger. Gated on the MASTER switch
   * (`features.triggers.enabled`) AND the write-back sub-switch: either off ⇒ skip
   * the pass entirely (byte-identical to TRACK-1 — no lifecycle comments).
   */
  async observeAll(): Promise<void> {
    const triggers = this.deps.config().features.triggers;
    if (!triggers.enabled) {
      this.deps.log("tracker write-back skipped — features.triggers.enabled (master switch) off");
      return;
    }
    if (!triggers.tracker.writeback.enabled) {
      this.deps.log("tracker write-back skipped — writeback sub-switch off");
      return;
    }
    const rows = await this.deps.getEnabledTriggersByType("tracker_event");
    for (const trigger of rows) {
      try {
        await this.observeTrigger(trigger);
      } catch (e) {
        this.deps.log(`tracker write-back error for trigger ${trigger.id}: ${(e as Error).message}`);
      }
    }
  }

  /** Observe one trigger: resolve its repo + write-back config, then its loops. */
  async observeTrigger(trigger: TriggerRow): Promise<void> {
    if (!trigger.projectId) return;
    const config = trigger.config as TrackerEventTriggerConfig;
    if (config.tracker !== "github") return;
    const repo = (config.repo ?? "").trim();
    if (!OWNER_REPO_RE.test(repo)) {
      this.deps.log(`tracker write-back skipped for trigger ${trigger.id} — repo not owner/repo`);
      return;
    }
    const verdictComments = config.writeback?.verdictComments === true;
    const reopenOnFailure = config.writeback?.reopenOnFailure === true;

    await this.deps.runInProject(trigger.projectId, async () => {
      const loops = await this.deps.getLoops();
      const nowMs = this.now();
      const matching = loops
        .filter((l) => this.loopBelongsToRepo(l, repo))
        .filter((l) => nowMs - new Date(l.updatedAt).getTime() <= OBSERVE_MAX_AGE_MS)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, OBSERVE_MAX_PER_CYCLE);

      for (const loop of matching) {
        try {
          await this.observeLoop(loop, repo, { verdictComments, reopenOnFailure });
        } catch (e) {
          this.deps.log(`tracker write-back loop ${loop.id} error: ${(e as Error).message}`);
        }
      }
    });
  }

  /**
   * True iff this loop traces to an issue in `repo`. Join = `spec.source`: the
   * kind must be "github" and, when a `url` is present (TRACK-1 always sets it),
   * it must sit under `owner/repo` — so a project with two tracker triggers on
   * different repos never cross-attributes a loop.
   */
  private loopBelongsToRepo(loop: ConsiliumLoopRow, repo: string): boolean {
    const src = loop.triggerProvenance?.spec?.source;
    if (!src || src.kind !== "github") return false;
    if (this.issueNumberOf(loop) === null) return false;
    const url = src.url;
    if (typeof url === "string" && url.length > 0) {
      // Match the issue URL's owner/repo segment case-insensitively.
      return url.toLowerCase().includes(`/${repo.toLowerCase()}/issues/`);
    }
    // No url (legacy edge) — attribute to this trigger's repo by ref alone.
    return true;
  }

  /** The origin issue number from `spec.source.ref` (positive integer), else null. */
  private issueNumberOf(loop: ConsiliumLoopRow): number | null {
    const ref = loop.triggerProvenance?.spec?.source?.ref;
    if (typeof ref !== "string") return null;
    const n = Number.parseInt(ref, 10);
    return Number.isInteger(n) && n > 0 && String(n) === ref.trim() ? n : null;
  }

  /**
   * Decide which lifecycle rows to attempt, given the loop's state. START/VERDICT
   * are IN-FLIGHT rows (skipped once terminal — the terminal comment supersedes
   * them); PR-OPENED fires whenever a PR ref exists; TERMINAL fires in a terminal
   * state. Every attempt is still marker-guarded downstream (idempotent).
   */
  private planFor(loop: ConsiliumLoopRow, verdictComments: boolean): Plan {
    const terminal = TERMINAL.has(loop.state);
    return {
      // "work starting" only while in flight — announcing it on an already-done
      // loop is pure noise; the terminal row covers a first-seen finished loop.
      start: !terminal,
      prOpened: typeof loop.prRef === "string" && loop.prRef.length > 0,
      // Per-round progress: opt-in, in-flight only, and only once a verdict decided
      // (openP0 is written when a round is tallied; round>=1 means a round ran).
      verdict: verdictComments && !terminal && loop.round >= 1 && loop.openP0 !== null,
      terminal,
    };
  }

  /** Observe one matching loop: read the issue ONCE, post the missing phases. */
  private async observeLoop(
    loop: ConsiliumLoopRow,
    repo: string,
    opts: { verdictComments: boolean; reopenOnFailure: boolean },
  ): Promise<void> {
    const issueNumber = this.issueNumberOf(loop);
    if (issueNumber === null) return;

    const plan = this.planFor(loop, opts.verdictComments);
    // Nothing to do (e.g. an old converged loop already fully reported) — but we
    // still can't know without a read; so if the plan is empty, skip the read.
    if (!plan.start && !plan.prOpened && !plan.verdict && !plan.terminal) return;

    const view = await fetchIssueView(repo, issueNumber, this.deps.runGh);
    if (!view) {
      this.deps.log(`tracker write-back: issue ${repo}#${issueNumber} unreadable (gh degraded) — skip`);
      return; // cannot read ⇒ do NOT post (double-post safety).
    }

    const wb: WritebackDeps = { runGh: this.deps.runGh, log: this.deps.log };
    const existingBodies = view.commentBodies;
    const loopId = loop.id;
    const isTerminal = TERMINAL.has(loop.state);

    // CLOSED issue: the merge (Closes #N) resolved it — leave it, UNLESS opted in
    // to reopen a non-converged terminal (failed/stopped_cap/escalated).
    if (view.state !== "OPEN") {
      if (opts.reopenOnFailure && isTerminal && FAILED_TERMINAL.has(loop.state)) {
        // Idempotent: only reopen + comment if we haven't posted the terminal row.
        const already = existingBodies.some((b) => b.includes(`factory:track2:terminal:${loopId}`));
        if (!already) {
          await reopenIssue(wb, { repo, issueNumber });
          await this.postTerminal(wb, repo, issueNumber, loop, existingBodies);
        }
      }
      return;
    }

    if (plan.start) {
      await postStartComment(wb, { repo, issueNumber, loopId, existingBodies });
    }
    if (plan.prOpened) {
      await postPrOpenedComment(wb, {
        repo, issueNumber, loopId, prRef: loop.prRef as string, existingBodies,
      });
    }
    if (plan.verdict) {
      await postVerdictComment(wb, {
        repo, issueNumber, loopId, round: loop.round,
        summary: this.verdictSummary(loop), existingBodies,
      });
    }
    if (plan.terminal) {
      await this.postTerminal(wb, repo, issueNumber, loop, existingBodies);
    }
  }

  /** Post the terminal row using the shared #486 explanation (loop-status.ts). */
  private async postTerminal(
    wb: WritebackDeps,
    repo: string,
    issueNumber: number,
    loop: ConsiliumLoopRow,
    existingBodies: readonly string[],
  ): Promise<void> {
    const ex = explainLoopState({
      state: loop.state,
      round: loop.round,
      maxRounds: loop.maxRounds,
      openP0: loop.openP0,
      error: loop.error,
      prRef: loop.prRef,
    });
    await postTerminalComment(wb, {
      repo, issueNumber, loopId: loop.id,
      title: ex.title, detail: ex.detail,
      // Link the PR on a converged loop ("ready for review, PR <link>").
      prRef: loop.state === "converged" ? loop.prRef : null,
      existingBodies,
    });
  }

  /** Minimal per-round verdict line grounded in the loop's own open-P0 count. */
  private verdictSummary(loop: ConsiliumLoopRow): string {
    const p0 = loop.openP0;
    if (typeof p0 === "number") {
      return p0 > 0
        ? `${p0} P0 action point${p0 === 1 ? "" : "s"} still open.`
        : "all P0 action points resolved.";
    }
    return "verdict recorded.";
  }
}
