/**
 * skill-proposer-observer.ts — DREAM-4: the background, SCHEDULED proposer that turns
 * REPEATEDLY-VERIFIED Experience patterns into PROPOSED SKILL.md patches.
 * Spec: docs/design/experience-plane-dream.md §5 (Experience ≠ Skill), §9 (DREAM-4).
 *
 * WHY PROPOSE-ONLY, AND WHY OFF THE HOT PATH (the §5 boundary, enforced)
 *   Modelled on the DREAM-3 consolidator observer (itself modelled on the DREAM-1 distiller
 *   observer / TRACK-2's writeback observer): this NEVER imports or mutates the consilium-
 *   loop-controller, NEVER runs on a loop's critical path, and — the load-bearing DREAM-4
 *   rule — it writes ONLY the `skill_proposals` table. It READS `experience_items`
 *   (read-only) and READS the skill registry (`getSkillIdByName`, to LINK a proposal to a
 *   known skill row); it NEVER writes `experience_items`, NEVER edits a SKILL.md in place,
 *   NEVER graduates a patch, NEVER touches the state graph. Auto-apply / auto-graduate is
 *   IMPOSSIBLE by construction: the only write is `createSkillProposals`, which always
 *   inserts `status: 'unverified'` — the ADR-0002 trust-envelope ENTRY. Every forward move
 *   (`unverified`→`verified`/`rejected`/`deprecated`) is a human/CODEOWNERS decision made
 *   through the review endpoint (requireRole maintainer/admin), never here.
 *
 * BOUNDED + DEDUPED (adversarial — never OOM, never spam the envelope)
 *   Only a bounded, most-recent-first window (SCAN_LIMIT) is read per pass. Before proposing,
 *   the pass reads the dedup keys ALREADY in the table and the pure proposer skips any pattern
 *   whose (project, skill, pattern) key is present — so a proven pattern yields ONE proposal,
 *   never a duplicate (the DB unique index is the backstop against a race). Passes never
 *   overlap (single-flight); a throw in one insert is caught so it can never kill the interval.
 *
 * KILL-SWITCH (§9)
 *   `pipeline.consiliumLoop.experiencePlane.skillFeedback.enabled` — default false. Off ⇒
 *   this observer is NEVER constructed (routes.ts) AND the review routes are not mounted, so
 *   no proposal is ever opened: byte-identical to DREAM-1/2/3 (the store only accumulates,
 *   is read, and is consolidated).
 */
import { randomUUID } from "crypto";
import type { InsertSkillProposal, ExperienceItemRow } from "@shared/schema";
import type { AppConfig } from "../../../config/schema.js";
import { proposeSkillPatches } from "./skill-proposer.js";

/** Max items read + scanned per pass (bounds memory; recent-first window). */
const SCAN_LIMIT = 2_000;
/** Default sweep interval (seconds) when config omits one — deliberately coarse. */
const DEFAULT_INTERVAL_SEC = 3_600;

export interface SkillProposerObserverDeps {
  /** Read a bounded, most-recent-first window of Experience items (cross-project under system). */
  listExperienceItems: (limit: number) => Promise<ExperienceItemRow[]>;
  /** The dedup keys already proposed — the pure proposer skips a pattern already present. */
  listSkillProposalDedupKeys: () => Promise<string[]>;
  /** Insert the pass's new PROPOSED patches, ALWAYS as `unverified` (the envelope entry). */
  createSkillProposals: (items: InsertSkillProposal[]) => Promise<unknown[]>;
  /**
   * A READ of the skill registry: resolve a skill name → its `skills`-table row id (or null
   * when the registry does not know it). Best-effort — a failure just leaves `skillId` null;
   * the proposal still references the SKILL.md by name. NEVER a write.
   */
  getSkillIdByName: (name: string) => Promise<string | null>;
  /**
   * Establish a SYSTEM ALS context around a pass (runAsSystem) so the cross-project storage
   * reads/writes resolve. Mirrors the DREAM-1/3 observers.
   */
  runInSystem: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Live config accessor (the kill-switch + interval + thresholds). */
  config: () => AppConfig;
  /** Structured logger. */
  log: (message: string) => void;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export class SkillProposerObserver {
  private readonly deps: SkillProposerObserverDeps;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private proposing = false;

  constructor(deps: SkillProposerObserverDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Start the interval proposer IFF the kill-switch is on. Idempotent. */
  start(): void {
    if (this.timer) return;
    const cfg = this.deps.config().pipeline.consiliumLoop.experiencePlane.skillFeedback;
    if (!cfg?.enabled) {
      this.deps.log("experience skill feedback disabled — proposer not started");
      return;
    }
    const intervalMs = (cfg.intervalSec ?? DEFAULT_INTERVAL_SEC) * 1000;
    this.timer = setInterval(() => void this.proposeSafe(), intervalMs);
    this.timer.unref?.();
    this.deps.log(`experience skill proposer started (every ${Math.round(intervalMs / 1000)}s)`);
  }

  /** Stop the interval proposer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One pass, fully guarded — a throw here must never kill the interval. */
  async proposeSafe(): Promise<void> {
    if (this.proposing) return; // never overlap passes.
    this.proposing = true;
    try {
      await this.runPass();
    } catch (e) {
      this.deps.log(`experience skill proposal pass error: ${(e as Error).message}`);
    } finally {
      this.proposing = false;
    }
  }

  /**
   * One proposal pass: re-check the kill-switch, read a bounded window + the existing dedup
   * keys under a SYSTEM context, compute the PURE candidates, resolve each skill's registry
   * id (a READ), and insert each as an `unverified` proposal. Each insert is guarded
   * individually so one bad candidate can never abort the whole pass or crash the interval.
   */
  async runPass(): Promise<void> {
    const cfg = this.deps.config().pipeline.consiliumLoop.experiencePlane.skillFeedback;
    if (!cfg?.enabled) {
      this.deps.log("experience skill proposal skipped — skillFeedback.enabled off");
      return;
    }
    const dreamRunId = randomUUID();

    await this.deps.runInSystem(async () => {
      const items = await this.deps.listExperienceItems(SCAN_LIMIT);
      if (items.length === 0) return;

      const existing = new Set(await this.deps.listSkillProposalDedupKeys());
      const candidates = proposeSkillPatches(items, existing, {
        dreamRunId,
        minVerifiedLoops: cfg.minVerifiedLoops,
        minSuccessDelta: cfg.minSuccessDelta,
        now: this.now,
      });
      if (candidates.length === 0) return;

      let proposed = 0;
      for (const c of candidates) {
        // Resolve the skill-registry id (a READ; best-effort). A failure ⇒ skillId null.
        let skillId: string | null = null;
        try {
          skillId = await this.deps.getSkillIdByName(c.skillName);
        } catch {
          skillId = null;
        }
        // ALWAYS `unverified` — the trust-envelope ENTRY. DREAM-4 never opens a proposal in
        // any other status; graduation is a human/CODEOWNERS decision.
        const insert: InsertSkillProposal = {
          projectId: c.projectId,
          skillName: c.skillName,
          skillId,
          dedupKey: c.dedupKey,
          patternKey: c.patternKey,
          scope: c.scope,
          patchText: c.patchText,
          status: "unverified",
          evidence: c.evidence,
          provenance: c.provenance,
          reviewNote: null,
        };
        try {
          const created = await this.deps.createSkillProposals([insert]);
          proposed += Array.isArray(created) ? created.length : 0;
        } catch (e) {
          this.deps.log(
            `experience skill proposal: insert for ${c.skillName} failed — ${(e as Error).message}`,
          );
        }
      }

      if (proposed > 0) {
        this.deps.log(
          `experience skill feedback: scanned=${items.length} candidates=${candidates.length} ` +
            `proposed=${proposed} unverified patch(es)`,
        );
      }
    });
  }
}
