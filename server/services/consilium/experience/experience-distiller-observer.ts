/**
 * experience-distiller-observer.ts — DREAM-1: the background, READ-ONLY observer that
 * turns terminal consilium loops into Experience items.
 * Spec: docs/design/experience-plane-dream.md §2 / §4 / §5 / §9.
 *
 * WHY READ-ONLY (the loop controller is off-limits — §4/§5)
 *   Modelled on TRACK-2's writeback-observer: this NEVER imports or mutates the
 *   consilium-loop-controller. It only READS already-persisted rows — loops via
 *   `storage.getLoops`, their rounds via `storage.getLoopRounds` — and WRITES only to
 *   the `experience_items` table via `storage.createExperienceItems`. A running loop is
 *   never touched, never blocked; if this observer is down, loops run EXACTLY as today
 *   (safe-degrade, §4). It rides its own interval, off the hot path.
 *
 * IDEMPOTENCY (§9 — "a loop distilled once; re-observe ⇒ skip")
 *   Before distilling a loop it checks `getExperienceItemsBySourceLoop(loopId)`: if the
 *   loop already produced items, it is SKIPPED — no duplicate. All of a loop's items are
 *   written in ONE batch insert so a re-observe sees "already distilled" atomically. A
 *   loop that yields ZERO gradeable items (e.g. a cancelled loop with no trace) writes
 *   nothing and is simply re-checked on later cycles until it ages out of the window —
 *   bounded, read-only, and never a duplicate.
 *
 * BOUNDS (adversarial — never hammer the DB, never OOM)
 *   Only TERMINAL loops updated within OBSERVE_MAX_AGE_MS are considered, capped at
 *   OBSERVE_MAX_PER_CYCLE (most-recently-updated first). The distiller itself bounds
 *   rounds/workers/criteria/items per loop (see distiller.ts).
 *
 * KILL-SWITCH (§9)
 *   `pipeline.consiliumLoop.experiencePlane.enabled` — default false. Off ⇒ this observer
 *   is NEVER constructed (routes.ts), so the system is byte-identical to today: no
 *   distiller, no rows. There is NO read path yet (DREAM-2) — items only accumulate.
 */
import { randomUUID } from "crypto";
import type { ConsiliumLoopRow, InsertExperienceItem } from "@shared/schema";
import { CONSILIUM_LOOP_TERMINAL_STATES } from "@shared/schema";
import type { AppConfig } from "../../../config/schema.js";
import { computeTrustTelemetry, type TelemetryLoopInput } from "../trust-telemetry.js";
import { distillLoop, type DistilledRoundInput } from "./distiller.js";

const TERMINAL = new Set<string>(CONSILIUM_LOOP_TERMINAL_STATES);

/** Max terminal loops inspected per cycle (bounds DB reads). */
const OBSERVE_MAX_PER_CYCLE = 100;
/** Only observe loops updated within this window — an old loop is settled. */
const OBSERVE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
/** Default observe interval when config omits one. */
const DEFAULT_INTERVAL_MS = 60_000;

/** The subset of a `ConsiliumLoopRoundRow` the distiller + grounding computation read. */
export interface DistillerRound {
  round: number;
  executionTrace: TelemetryLoopInput["rounds"][number]["executionTrace"];
  openActionPoints: TelemetryLoopInput["rounds"][number]["openActionPoints"];
  headCommit: string | null;
  createdAt: Date | string;
}

export interface ExperienceDistillerObserverDeps {
  /** Cross-project system read of ALL loops (runAsSystem is applied by the caller shim). */
  getLoops: () => Promise<ConsiliumLoopRow[]>;
  /** Read a loop's persisted rounds (execution traces / verdicts). */
  getLoopRounds: (loopId: string) => Promise<DistillerRound[]>;
  /** Idempotency probe: items already distilled from this loop (dedup). */
  getExperienceItemsBySourceLoop: (loopId: string) => Promise<unknown[]>;
  /** Batch write of a loop's item candidates (ONE insert — atomic per loop). */
  createExperienceItems: (items: InsertExperienceItem[]) => Promise<unknown[]>;
  /**
   * Establish a SYSTEM ALS context around a pass (runAsSystem) so the cross-project
   * storage reads/writes above resolve. Mirrors TRACK-2's runAsSystem bootstrap.
   */
  runInSystem: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Live config accessor (the kill-switch + interval). */
  config: () => AppConfig;
  /** Structured logger. */
  log: (message: string) => void;
  /** Injectable clock (tests). */
  now?: () => number;
}

export class ExperienceDistillerObserver {
  private readonly deps: ExperienceDistillerObserverDeps;
  private readonly nowMs: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private observing = false;

  constructor(deps: ExperienceDistillerObserverDeps) {
    this.deps = deps;
    this.nowMs = deps.now ?? Date.now;
  }

  /** Start the interval observer IFF the kill-switch is on. Idempotent. */
  start(): void {
    if (this.timer) return;
    const cfg = this.deps.config().pipeline.consiliumLoop.experiencePlane;
    if (!cfg.enabled) {
      this.deps.log("experience plane disabled — distiller observer not started");
      return;
    }
    const intervalMs = cfg.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => void this.observeAllSafe(), intervalMs);
    this.timer.unref?.();
    this.deps.log(`experience distiller observer started (every ${Math.round(intervalMs / 1000)}s)`);
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
      this.deps.log(`experience distiller pass error: ${(e as Error).message}`);
    } finally {
      this.observing = false;
    }
  }

  /**
   * Observe every terminal, not-yet-distilled loop across all projects. Re-checks the
   * kill-switch each pass (a live config flip to off ⇒ the pass no-ops). Reads run under
   * a SYSTEM context so cross-project loop reads resolve.
   */
  async observeAll(): Promise<void> {
    const cfg = this.deps.config().pipeline.consiliumLoop.experiencePlane;
    if (!cfg.enabled) {
      this.deps.log("experience distiller skipped — experiencePlane.enabled off");
      return;
    }
    const dreamRunId = randomUUID();
    await this.deps.runInSystem(async () => {
      const loops = await this.deps.getLoops();
      const nowMs = this.nowMs();
      const terminal = loops
        .filter((l) => TERMINAL.has(l.state))
        .filter((l) => nowMs - new Date(l.updatedAt).getTime() <= OBSERVE_MAX_AGE_MS)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, OBSERVE_MAX_PER_CYCLE);

      for (const loop of terminal) {
        try {
          await this.observeLoop(loop, dreamRunId);
        } catch (e) {
          this.deps.log(`experience distiller loop ${loop.id} error: ${(e as Error).message}`);
        }
      }
    });
  }

  /** Distil ONE terminal loop, idempotently. */
  private async observeLoop(loop: ConsiliumLoopRow, dreamRunId: string): Promise<void> {
    // Idempotency: a loop that already produced items is done — never re-distil.
    const existing = await this.deps.getExperienceItemsBySourceLoop(loop.id);
    if (Array.isArray(existing) && existing.length > 0) return;

    const rawRounds = await this.deps.getLoopRounds(loop.id);
    const groundingRatioAtTime = this.computeGroundingRatio(loop, rawRounds);
    const rounds: DistilledRoundInput[] = rawRounds.map((r) => ({
      round: r.round,
      executionTrace: r.executionTrace,
      headCommit: r.headCommit ?? null,
    }));
    const items = distillLoop(loop, rounds, { dreamRunId, groundingRatioAtTime });
    if (items.length === 0) return; // nothing gradeable — write nothing.

    await this.deps.createExperienceItems(items);
    this.deps.log(`experience distiller: loop ${loop.id} → ${items.length} item(s)`);
  }

  /**
   * The loop's grounding ratio at distill time (mechanical / total criteria), reusing the
   * EXACT trust-telemetry computation. null when the loop has no criteria (not "0.0",
   * which would read as "totally ungrounded" — an honest absence, §6).
   */
  private computeGroundingRatio(loop: ConsiliumLoopRow, rounds: DistillerRound[]): number | null {
    try {
      const input: TelemetryLoopInput = {
        archetype: loop.archetype ?? null,
        archetypeSource: loop.archetypeSource ?? null,
        createdAt: loop.createdAt,
        rounds: rounds.map((r) => ({
          createdAt: r.createdAt,
          executionTrace: r.executionTrace,
          openActionPoints: r.openActionPoints,
        })),
      };
      const t = computeTrustTelemetry([input]);
      return t.grounding.totalCriteria > 0 ? t.grounding.groundingRatio : null;
    } catch {
      return null;
    }
  }
}
