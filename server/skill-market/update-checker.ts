/**
 * SkillUpdateChecker — Phase 9.8
 *
 * Background service that periodically checks installed external skills
 * for available updates. When an update is found it is stored in a
 * pending-updates cache. If the skill has `auto_update` enabled the
 * update is applied automatically.
 *
 * The checker is DB-aware but gracefully degrades when no database is
 * available (MemStorage mode) — it simply becomes a no-op.
 */

import type { RegistryManager } from "./registry-manager.js";
import type { SkillUpdateInfo } from "./types.js";

// ─── DB access (optional) ────────────────────────────────────────────────────
// We import lazily so that the module can be loaded even without a running
// Postgres instance (MemStorage / test environments).

let _db: any = null;
let _schema: any = null;

async function getDb(): Promise<{ db: any; schema: any } | null> {
  if (_db && _schema) return { db: _db, schema: _schema };
  try {
    const dbMod = await import("../db.js");
    const schemaMod = await import("../../shared/schema.js");
    _db = dbMod.db;
    _schema = schemaMod;
    return { db: _db, schema: _schema };
  } catch {
    return null;
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PendingUpdate {
  skillId: string;
  currentVersion: string;
  latestVersion: string;
  source: string;
  changelog?: string;
  breaking?: boolean;
}

export interface UpdateCheckResult {
  checked: number;
  updatesFound: number;
  autoApplied: number;
  errors: string[];
}

export interface ApplyAllResult {
  updated: number;
  errors: number;
}

// ─── Main class ──────────────────────────────────────────────────────────────

export class SkillUpdateChecker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private pendingUpdates: Map<string, PendingUpdate> = new Map();
  private lastCheckAt: Date | null = null;
  private _running = false;

  constructor(
    private readonly registryManager: RegistryManager,
    private readonly checkIntervalMs: number = getDefaultInterval(),
  ) {}

  /** Whether the periodic check loop is active. */
  get running(): boolean {
    return this._running;
  }

  /** Timestamp of the last completed check, or null if none. */
  get lastCheck(): Date | null {
    return this.lastCheckAt;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start the periodic check loop. Runs an immediate check followed by
   * recurring checks at `checkIntervalMs`.
   */
  start(): void {
    if (this._running) return;
    this._running = true;
    // Fire-and-forget first check
    this.check().catch(() => {});
    this.interval = setInterval(() => {
      this.check().catch(() => {});
    }, this.checkIntervalMs);
  }

  /** Stop the periodic check loop. */
  stop(): void {
    this._running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // ─── Core check ────────────────────────────────────────────────────────────

  /**
   * Query all installed external skills, ask each source adapter for
   * available updates, cache results, and auto-apply where enabled.
   */
  async check(): Promise<UpdateCheckResult> {
    const result: UpdateCheckResult = {
      checked: 0,
      updatesFound: 0,
      autoApplied: 0,
      errors: [],
    };

    const conn = await getDb();
    if (!conn) {
      // No DB available — nothing to check
      this.lastCheckAt = new Date();
      return result;
    }

    const { db, schema } = conn;

    // Fetch installed external skills (where external_source is not null)
    let installedSkills: any[];
    try {
      const { isNotNull } = await import("drizzle-orm");
      installedSkills = await db
        .select()
        .from(schema.skills)
        .where(isNotNull(schema.skills.externalSource));
    } catch (err) {
      result.errors.push(`Failed to query installed skills: ${(err as Error).message}`);
      this.lastCheckAt = new Date();
      return result;
    }

    if (installedSkills.length === 0) {
      this.lastCheckAt = new Date();
      return result;
    }

    result.checked = installedSkills.length;

    // Group skills by source adapter
    const bySource = new Map<string, Array<{ id: string; externalId: string; externalVersion: string; autoUpdate: boolean }>>();
    for (const skill of installedSkills) {
      const source = skill.externalSource as string;
      if (!bySource.has(source)) bySource.set(source, []);
      bySource.get(source)!.push({
        id: skill.id,
        externalId: skill.externalId ?? "",
        externalVersion: skill.externalVersion ?? "0.0.0",
        autoUpdate: skill.autoUpdate ?? false,
      });
    }

    // Check each source adapter for updates
    for (const [source, skills] of bySource) {
      const adapter = this.registryManager.getAdapter(source);
      if (!adapter || !adapter.enabled) {
        result.errors.push(`Adapter not available for source: ${source}`);
        continue;
      }

      let updates: SkillUpdateInfo[];
      try {
        updates = await adapter.checkUpdates(
          skills.map((s) => ({
            externalId: s.externalId,
            externalVersion: s.externalVersion,
          })),
        );
      } catch (err) {
        result.errors.push(`checkUpdates failed for ${source}: ${(err as Error).message}`);
        continue;
      }

      // Build a quick lookup: externalId -> update info
      const updateMap = new Map<string, SkillUpdateInfo>();
      for (const u of updates) {
        updateMap.set(u.externalId, u);
      }

      // Store pending updates and auto-apply where enabled
      for (const skill of skills) {
        const update = updateMap.get(skill.externalId);
        if (!update) continue;

        result.updatesFound++;
        this.pendingUpdates.set(skill.id, {
          skillId: skill.id,
          currentVersion: update.currentVersion,
          latestVersion: update.latestVersion,
          source,
          changelog: update.changelog,
          breaking: update.breaking,
        });

        if (skill.autoUpdate) {
          try {
            await this.applyUpdate(skill.id);
            result.autoApplied++;
          } catch (err) {
            result.errors.push(`Auto-update failed for ${skill.id}: ${(err as Error).message}`);
          }
        }
      }
    }

    this.lastCheckAt = new Date();
    return result;
  }

  // ─── Pending updates ──────────────────────────────────────────────────────

  /** Return all cached pending updates. */
  getPendingUpdates(): PendingUpdate[] {
    return Array.from(this.pendingUpdates.values());
  }

  /** Check whether a specific skill has a pending update. */
  hasPendingUpdate(skillId: string): boolean {
    return this.pendingUpdates.has(skillId);
  }

  // ─── Apply updates ────────────────────────────────────────────────────────

  /**
   * Apply a pending update for a single skill by re-installing from the
   * external source and logging the action.
   */
  async applyUpdate(skillId: string): Promise<void> {
    const pending = this.pendingUpdates.get(skillId);
    if (!pending) {
      throw new Error(`No pending update for skill ${skillId}`);
    }

    const adapter = this.registryManager.getAdapter(pending.source);
    if (!adapter) {
      throw new Error(`Adapter not found for source: ${pending.source}`);
    }

    // Re-install to get the latest version
    await adapter.install(
      `${pending.source}:${skillId}`,
      "system-auto-update",
    );

    // Update the skill record in DB
    const conn = await getDb();
    if (conn) {
      const { db, schema } = conn;
      const { eq } = await import("drizzle-orm");
      try {
        await db
          .update(schema.skills)
          .set({
            externalVersion: pending.latestVersion,
            updatedAt: new Date(),
          })
          .where(eq(schema.skills.id, skillId));

        // Log the update action
        await db.insert(schema.skillInstallLog).values({
          skillId,
          externalSource: pending.source,
          externalId: skillId,
          action: "update",
          fromVersion: pending.currentVersion,
          toVersion: pending.latestVersion,
          userId: "system-auto-update",
        });
      } catch {
        // DB write failed — update was still applied via adapter
      }
    }

    // Remove from pending
    this.pendingUpdates.delete(skillId);
  }

  /**
   * Apply all pending updates. Returns counts of successes and failures.
   */
  async applyAllUpdates(): Promise<ApplyAllResult> {
    let updated = 0;
    let errors = 0;

    const skillIds = Array.from(this.pendingUpdates.keys());
    for (const skillId of skillIds) {
      try {
        await this.applyUpdate(skillId);
        updated++;
      } catch {
        errors++;
      }
    }

    return { updated, errors };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read the check interval from environment, defaulting to 6 hours.
 */
function getDefaultInterval(): number {
  const envVal = process.env.SKILL_MARKET_UPDATE_CHECK_INTERVAL;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 6 * 60 * 60 * 1000; // 6 hours
}
