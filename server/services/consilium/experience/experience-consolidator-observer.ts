/**
 * experience-consolidator-observer.ts — DREAM-3: the background, SCHEDULED consolidator
 * that keeps the accumulated Experience store honest.
 * Spec: docs/design/experience-plane-dream.md §4 (scheduled/consolidating), §6
 * (freshness/decay/self-correction), §9 (DREAM-3).
 *
 * WHY OFF THE HOT PATH (the loop controller is off-limits — §4/§5)
 *   Modelled on the DREAM-1 distiller observer (itself modelled on TRACK-2's writeback
 *   observer): this NEVER imports or mutates the consilium-loop-controller, and it never
 *   runs on a loop's critical path. It rides its OWN coarse interval, READS a bounded
 *   window of already-persisted items (`storage.listExperienceItems`), computes a PURE
 *   `ConsolidationPlan` (see consolidator.ts), and applies it by WRITING ONLY to the
 *   `experience_items` table (`updateExperienceItem` / `deleteExperienceItems`). If this
 *   observer is down, the Experience plane behaves EXACTLY as DREAM-1/DREAM-2 (the store
 *   just accumulates) — safe degrade (§4). It can never block, race, or fail a loop, and
 *   it never touches the state graph or SKILL.md (DREAM-4 owns skill feedback, §5).
 *
 * IDEMPOTENT + BOUNDED (adversarial — never OOM, never thrash)
 *   Only a bounded window (CONSOLIDATE_SCAN_LIMIT, most-recent-first) is read per pass, so
 *   a huge store can never blow memory. The pure consolidator is deterministic and emits
 *   an update ONLY when a field would actually change — so a re-run over an already-
 *   consolidated batch produces no writes (the pass converges and holds). Passes never
 *   overlap (single-flight), and a throw in one item's write is caught so it can never
 *   kill the interval.
 *
 * WHAT "REUSE" MEANS HERE (the successDelta boundary — see consolidator.ts §4)
 *   `successDelta` is recomputed from the AVAILABLE reuse signal: the same (scope, claim)
 *   RECURRING across >= 2 independent loops with grounded outcomes. The STRONGER signal —
 *   linking DREAM-2's plan-time injection of item X to the LATER loop's independent
 *   outcome — needs a persisted injection→outcome edge that DREAM-2 only LOGS today; wiring
 *   that edge is deferred (DREAM-2 emits `plan: experience injected — N item(s)` but does
 *   not persist WHICH items fed WHICH loop). That full reuse-attribution is a documented
 *   boundary; the recurrence proxy is honest (measured from outcomes, not opinion).
 *
 * KILL-SWITCH (§9)
 *   `pipeline.consiliumLoop.experiencePlane.consolidate.enabled` — default false. Off ⇒
 *   this observer is NEVER constructed (routes.ts), so no item is ever merged/decayed/
 *   updated: byte-identical to DREAM-1/DREAM-2 (the store only accumulates + is read).
 */
import { randomUUID } from "crypto";
import type { ExperienceItemRow } from "@shared/schema";
import type { AppConfig } from "../../../config/schema.js";
import { consolidate, type ExperienceItemPatch } from "./consolidator.js";

/** Max items read + consolidated per pass (bounds memory; recent-first window, §4). */
const CONSOLIDATE_SCAN_LIMIT = 2_000;
/** Default sweep interval (seconds) when config omits one — deliberately coarse. */
const DEFAULT_INTERVAL_SEC = 3_600;

export interface ExperienceConsolidatorObserverDeps {
  /** Read a bounded, most-recent-first window of Experience items (cross-project under system). */
  listExperienceItems: (limit: number) => Promise<ExperienceItemRow[]>;
  /** Apply ONE surviving item's field-level patch (merge result / decay / successDelta / flag). */
  updateExperienceItem: (id: string, patch: ExperienceItemPatch) => Promise<unknown>;
  /** Delete merged-away duplicate items (their evidence already folded into a survivor). */
  deleteExperienceItems: (ids: string[]) => Promise<void>;
  /**
   * Establish a SYSTEM ALS context around a pass (runAsSystem) so the cross-project
   * storage reads/writes resolve. Mirrors the DREAM-1 distiller observer.
   */
  runInSystem: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Live config accessor (the kill-switch + interval + shared staleVerifiedDays). */
  config: () => AppConfig;
  /** Structured logger. */
  log: (message: string) => void;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export class ExperienceConsolidatorObserver {
  private readonly deps: ExperienceConsolidatorObserverDeps;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private consolidating = false;

  constructor(deps: ExperienceConsolidatorObserverDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Start the interval consolidator IFF the kill-switch is on. Idempotent. */
  start(): void {
    if (this.timer) return;
    const cfg = this.deps.config().pipeline.consiliumLoop.experiencePlane.consolidate;
    if (!cfg?.enabled) {
      this.deps.log("experience plane consolidation disabled — consolidator not started");
      return;
    }
    const intervalMs = (cfg.intervalSec ?? DEFAULT_INTERVAL_SEC) * 1000;
    this.timer = setInterval(() => void this.consolidateSafe(), intervalMs);
    this.timer.unref?.();
    this.deps.log(`experience consolidator started (every ${Math.round(intervalMs / 1000)}s)`);
  }

  /** Stop the interval consolidator. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One pass, fully guarded — a throw here must never kill the interval. */
  async consolidateSafe(): Promise<void> {
    if (this.consolidating) return; // never overlap passes.
    this.consolidating = true;
    try {
      await this.runPass();
    } catch (e) {
      this.deps.log(`experience consolidation pass error: ${(e as Error).message}`);
    } finally {
      this.consolidating = false;
    }
  }

  /**
   * One consolidation pass: re-check the kill-switch, read a bounded window under a SYSTEM
   * context, compute the pure plan, and apply updates then deletes. Each write is guarded
   * individually so one bad row can never abort the whole pass or crash the interval.
   */
  async runPass(): Promise<void> {
    const cfg = this.deps.config().pipeline.consiliumLoop.experiencePlane;
    if (!cfg.consolidate?.enabled) {
      this.deps.log("experience consolidation skipped — consolidate.enabled off");
      return;
    }
    const dreamRunId = randomUUID();
    // staleVerifiedDays is SHARED with the DREAM-2 reader so the durable decay agrees with
    // the read-time down-weight (§6). Falls back to a safe default if the read block is absent.
    const staleVerifiedDays = cfg.read?.staleVerifiedDays ?? 60;

    await this.deps.runInSystem(async () => {
      const items = await this.deps.listExperienceItems(CONSOLIDATE_SCAN_LIMIT);
      if (items.length === 0) return;

      const plan = consolidate(items, { dreamRunId, staleVerifiedDays, now: this.now });

      let applied = 0;
      for (const upd of plan.updates) {
        try {
          await this.deps.updateExperienceItem(upd.id, upd.patch);
          applied += 1;
        } catch (e) {
          this.deps.log(`experience consolidation: update ${upd.id} failed — ${(e as Error).message}`);
        }
      }

      // Deletes are applied AFTER updates so a survivor is never left dangling if a delete
      // fails; a failed delete just means a duplicate lingers to next pass (idempotent).
      if (plan.deletes.length > 0) {
        try {
          await this.deps.deleteExperienceItems(plan.deletes);
        } catch (e) {
          this.deps.log(`experience consolidation: delete batch failed — ${(e as Error).message}`);
        }
      }

      const s = plan.stats;
      if (applied > 0 || s.deleted > 0) {
        this.deps.log(
          `experience consolidation: scanned=${s.scanned} groups=${s.groups} ` +
            `merged=${s.merged} decayed=${s.decayed} conflicts=${s.conflicts} ` +
            `successDelta=${s.successDeltaSet} updated=${applied} deleted=${s.deleted}`,
        );
      }
    });
  }
}
