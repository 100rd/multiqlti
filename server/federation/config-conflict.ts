/**
 * config-conflict.ts — Config-sync conflict detection + per-entity resolution.
 *
 * Issue #323: Config sync — conflict resolution per entity type
 *
 * Architecture:
 *
 *  When an incoming config event arrives (via `handleIncoming` in config-sync.ts)
 *  the subscriber calls `ConflictDetector.check()` before applying the event.
 *
 *  Detection:
 *    entity was already modified locally (localVersion > lastSyncedVersion)
 *    AND the incoming remoteVersion differs from localVersion.
 *
 *  Resolution strategies per entity kind:
 *    lww          — last-write-wins (remote wins if remoteVersion > localVersion).
 *                   Sets the "contested" UI flag so users can see the override.
 *    human        — event is blocked; a `pending_human` conflict row is created.
 *                   Used for connection / provider-key (secrets).
 *    auto_merge   — automatic merge (skill-state: union installed, max version).
 *    approval_voting — LWW by default with approval-voting extension (future).
 *
 *  Notification:
 *    `ConflictNotifier.checkStale()` is called on a timer to alert when
 *    unresolved conflicts are older than N hours (per-entity configurable).
 *
 *  Audit:
 *    Every conflict detection and resolution writes a row to `config_conflict_audit`.
 */

import crypto from "crypto";
import type { ConfigEventOperation } from "@shared/schema";
import type {
  ConfigConflictRow,
  ConfigConflictStatus,
  ConfigConflictStrategy,
  ConfigConflictStrategyRow,
  InsertConfigConflict,
  InsertConfigConflictAudit,
} from "@shared/schema";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default staleness alert threshold in hours (used when strategy table is not seeded). */
const DEFAULT_ALERT_AFTER_H = 24;

/** Maximum in-memory conflicts to keep when no DB store is wired. */
const MAX_IN_MEMORY_CONFLICTS = 1_000;

// ─── Default per-entity strategies (mirrors the SQL seed data) ──────────────

const DEFAULT_STRATEGIES: Readonly<Record<string, ConfigConflictStrategy>> = {
  pipeline: "lww",
  trigger: "lww",
  prompt: "lww",
  connection: "human",
  "provider-key": "human",
  preferences: "lww",
  "skill-state": "auto_merge",
};

const DEFAULT_MARK_CONTESTED: Readonly<Record<string, boolean>> = {
  pipeline: true,
  trigger: true,
  prompt: true,
  connection: false,
  "provider-key": false,
  preferences: false,
  "skill-state": false,
};

// ─── Public types ─────────────────────────────────────────────────────────────

/** Summary returned by `ConflictDetector.check()`. */
export type ConflictCheckResult =
  | { conflicted: false }
  | {
      conflicted: true;
      /** The newly created conflict row. */
      conflict: ConfigConflictRow;
      /**
       * Whether the caller should continue applying the event.
       * `true`  → apply (LWW or auto-merge applied the winner already)
       * `false` → block (human-in-the-loop required)
       */
      applyEvent: boolean;
      /**
       * When auto-merge produces a merged payload the caller should use this
       * instead of the raw remote payload.  Undefined for other strategies.
       */
      mergedPayload?: Record<string, unknown>;
    };

/** Callback invoked when an unresolved conflict is stale (older than alert threshold). */
export type StaleConflictAlertFn = (conflict: ConfigConflictRow) => void;

// ─── Storage interface ────────────────────────────────────────────────────────

/**
 * Minimal persistence interface for the conflict service.
 * Implemented by IStorage in storage.ts; in-memory stub used in tests.
 */
export interface IConflictStore {
  /** Insert a new conflict row; returns the persisted row. */
  insertConflict(row: InsertConfigConflict): Promise<ConfigConflictRow>;

  /** Update status + resolution fields on an existing conflict. */
  updateConflictStatus(
    id: string,
    status: ConfigConflictStatus,
    resolvedBy: string,
    resolvedAt: Date,
    resolutionNote?: string,
    mergedPayload?: Record<string, unknown>,
  ): Promise<void>;

  /** Find an open (detected | pending_human) conflict for a given entity. */
  findOpenConflict(entityKind: string, entityId: string): Promise<ConfigConflictRow | null>;

  /** Fetch all open conflicts (optionally filtered by entity kind). */
  listOpenConflicts(entityKind?: string): Promise<ConfigConflictRow[]>;

  /** Fetch all conflicts older than `sinceMs` epoch ms that are still open. */
  listStaleConflicts(olderThanMs: number): Promise<ConfigConflictRow[]>;

  /** Append an audit record. */
  appendConflictAudit(row: InsertConfigConflictAudit): Promise<void>;

  /** Look up the configured strategy for an entity kind. */
  getConflictStrategy(entityKind: string): Promise<ConfigConflictStrategyRow | null>;

  /** Get the last-synced version for a given entity (returns null if unknown). */
  getLastSyncedVersion(entityKind: string, entityId: string): Promise<string | null>;

  /** Record that a version was cleanly synced for an entity. */
  setLastSyncedVersion(entityKind: string, entityId: string, version: string): Promise<void>;

  /** Fetch the current local entity payload for conflict capture. */
  getLocalEntityPayload(entityKind: string, entityId: string): Promise<Record<string, unknown> | null>;

  /** Fetch the current local entity version. */
  getLocalEntityVersion(entityKind: string, entityId: string): Promise<string | null>;
}

// ─── ConflictDetector ─────────────────────────────────────────────────────────

/**
 * Checks for conflicts before each incoming event is applied and handles
 * resolution according to the configured per-entity strategy.
 *
 * The caller (config-sync subscriber) should:
 *   1. Call `check()` — receives the `ConflictCheckResult`.
 *   2. If `!result.conflicted` → apply as normal.
 *   3. If `result.conflicted && result.applyEvent` → apply (LWW winner / auto-merge).
 *      Use `result.mergedPayload` if provided (auto_merge case).
 *   4. If `result.conflicted && !result.applyEvent` → block; wait for human resolution.
 */
export class ConflictDetector {
  constructor(
    private readonly store: IConflictStore,
    private readonly strategyOverrides: Partial<Record<string, ConfigConflictStrategy>> = {},
  ) {}

  /**
   * Examine an incoming event and decide how to handle it.
   *
   * @param peerId       The originating peer instance ID.
   * @param entityKind   Entity type (e.g. "pipeline", "connection").
   * @param entityId     Stable entity identifier.
   * @param remoteVersion Version string from the incoming event.
   * @param remotePayload Full payload from the incoming event.
   * @param operation    create | update | delete
   */
  async check(
    peerId: string,
    entityKind: string,
    entityId: string,
    remoteVersion: string,
    remotePayload: Record<string, unknown>,
    operation: ConfigEventOperation,
  ): Promise<ConflictCheckResult> {
    // Deletes never conflict — tombstones always win.
    if (operation === "delete") {
      await this.store.setLastSyncedVersion(entityKind, entityId, remoteVersion);
      return { conflicted: false };
    }

    const localVersion = await this.store.getLocalEntityVersion(entityKind, entityId);

    // No local entity → no conflict.
    if (localVersion === null) {
      await this.store.setLastSyncedVersion(entityKind, entityId, remoteVersion);
      return { conflicted: false };
    }

    const lastSyncedVersion = await this.store.getLastSyncedVersion(entityKind, entityId);

    // Conflict condition: local was modified after last sync (localVersion differs
    // from lastSyncedVersion) AND the remote version also differs from local.
    const localModifiedAfterSync =
      lastSyncedVersion === null || localVersion !== lastSyncedVersion;
    const remoteVersionDiffersFromLocal = remoteVersion !== localVersion;

    if (!localModifiedAfterSync || !remoteVersionDiffersFromLocal) {
      // No conflict — apply cleanly and record the synced version.
      await this.store.setLastSyncedVersion(entityKind, entityId, remoteVersion);
      return { conflicted: false };
    }

    // ── Conflict detected ───────────────────────────────────────────────────
    const strategy = await this.resolveStrategy(entityKind);
    const localPayload =
      (await this.store.getLocalEntityPayload(entityKind, entityId)) ?? {};

    const conflictRow = await this.store.insertConflict({
      entityKind,
      entityId,
      peerId,
      remoteVersion,
      localVersion,
      remotePayload,
      localPayload,
      strategy,
      status: strategy === "human" ? "pending_human" : "detected",
      isContested: false,
      mergedPayload: undefined,
    } satisfies InsertConfigConflict);

    await this.store.appendConflictAudit({
      conflictId: conflictRow.id,
      entityKind,
      entityId,
      peerId,
      strategy,
      action: "detected",
      resolvedBy: undefined,
      resolutionNote: undefined,
      payloadBefore: localPayload,
      payloadAfter: remotePayload,
    });

    // ── Resolve by strategy ────────────────────────────────────────────────
    switch (strategy) {
      case "lww":
      case "approval_voting":
        return this.handleLww(conflictRow, remoteVersion, localVersion, remotePayload, strategy);

      case "human":
        return this.handleHuman(conflictRow);

      case "auto_merge":
        return this.handleAutoMerge(conflictRow, entityKind, remotePayload, localPayload);

      default: {
        // Unknown strategy — treat as LWW.
        return this.handleLww(conflictRow, remoteVersion, localVersion, remotePayload, "lww");
      }
    }
  }

  // ── Strategy handlers ─────────────────────────────────────────────────────

  private async handleLww(
    conflict: ConfigConflictRow,
    remoteVersion: string,
    localVersion: string,
    remotePayload: Record<string, unknown>,
    strategy: ConfigConflictStrategy,
  ): Promise<ConflictCheckResult> {
    const strategyConfig = await this.store.getConflictStrategy(conflict.entityKind);
    const markContested =
      strategyConfig?.markContested ?? DEFAULT_MARK_CONTESTED[conflict.entityKind] ?? true;

    // LWW: compare versions as ISO timestamp strings; higher = newer.
    const remoteWins = remoteVersion >= localVersion;

    const resolvedBy = remoteWins ? "lww_auto:remote" : "lww_auto:local";
    const resolutionNote = remoteWins
      ? `Remote version ${remoteVersion} is newer; remote wins.`
      : `Local version ${localVersion} is newer; local wins (remote event discarded).`;

    await this.store.updateConflictStatus(
      conflict.id,
      "auto_resolved",
      resolvedBy,
      new Date(),
      resolutionNote,
      undefined,
    );

    await this.store.appendConflictAudit({
      conflictId: conflict.id,
      entityKind: conflict.entityKind,
      entityId: conflict.entityId,
      peerId: conflict.peerId,
      strategy,
      action: "auto_resolved",
      resolvedBy,
      resolutionNote,
      payloadBefore: conflict.localPayload as Record<string, unknown>,
      payloadAfter: remoteWins ? remotePayload : conflict.localPayload as Record<string, unknown>,
    });

    if (remoteWins) {
      // Remote wins → apply the event; mark contested if configured.
      if (markContested) {
        await this.store.updateConflictStatus(
          conflict.id,
          "auto_resolved",
          resolvedBy,
          new Date(),
          resolutionNote + " [contested]",
          undefined,
        );
      }
      await this.store.setLastSyncedVersion(
        conflict.entityKind,
        conflict.entityId,
        remoteVersion,
      );
      return {
        conflicted: true,
        conflict: { ...conflict, status: "auto_resolved", isContested: markContested },
        applyEvent: true,
      };
    }

    // Local wins → discard remote event.
    return {
      conflicted: true,
      conflict: { ...conflict, status: "auto_resolved" },
      applyEvent: false,
    };
  }

  private handleHuman(conflict: ConfigConflictRow): ConflictCheckResult {
    // Block application — human must resolve via API.
    return {
      conflicted: true,
      conflict: { ...conflict, status: "pending_human" },
      applyEvent: false,
    };
  }

  private async handleAutoMerge(
    conflict: ConfigConflictRow,
    entityKind: string,
    remotePayload: Record<string, unknown>,
    localPayload: Record<string, unknown>,
  ): Promise<ConflictCheckResult> {
    const merged = autoMergeByKind(entityKind, remotePayload, localPayload);

    const resolvedBy = "auto_merge";
    const resolutionNote = `Automatic merge applied for entity kind "${entityKind}".`;

    await this.store.updateConflictStatus(
      conflict.id,
      "auto_resolved",
      resolvedBy,
      new Date(),
      resolutionNote,
      merged,
    );

    await this.store.appendConflictAudit({
      conflictId: conflict.id,
      entityKind: conflict.entityKind,
      entityId: conflict.entityId,
      peerId: conflict.peerId,
      strategy: "auto_merge",
      action: "auto_resolved",
      resolvedBy,
      resolutionNote,
      payloadBefore: localPayload,
      payloadAfter: merged,
    });

    await this.store.setLastSyncedVersion(
      conflict.entityKind,
      conflict.entityId,
      conflict.remoteVersion,
    );

    return {
      conflicted: true,
      conflict: { ...conflict, status: "auto_resolved", mergedPayload: merged },
      applyEvent: true,
      mergedPayload: merged,
    };
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async resolveStrategy(entityKind: string): Promise<ConfigConflictStrategy> {
    // 1. Constructor overrides (highest priority — useful in tests).
    if (this.strategyOverrides[entityKind]) {
      return this.strategyOverrides[entityKind]!;
    }
    // 2. DB-configured strategy.
    const row = await this.store.getConflictStrategy(entityKind);
    if (row) return row.strategy;
    // 3. Built-in defaults.
    return DEFAULT_STRATEGIES[entityKind] ?? "lww";
  }
}

// ─── Auto-merge implementations ───────────────────────────────────────────────

/**
 * Dispatch to the appropriate merge function for the entity kind.
 * Currently only "skill-state" has a specialised merge; all others fall back to
 * the generic field-level LWW merge.
 */
export function autoMergeByKind(
  entityKind: string,
  remote: Record<string, unknown>,
  local: Record<string, unknown>,
): Record<string, unknown> {
  if (entityKind === "skill-state") {
    return mergeSkillState(remote, local);
  }
  // Generic: merge all keys, newer version wins per-field (remote takes precedence).
  return { ...local, ...remote };
}

/**
 * Merge two skill-state payloads.
 *
 * Rules (from issue spec):
 *   - `installed`: union of both arrays (de-duplicated by skill id).
 *   - `version`: take the maximum of the two semver strings.
 *   - All other fields: remote wins (LWW).
 */
export function mergeSkillState(
  remote: Record<string, unknown>,
  local: Record<string, unknown>,
): Record<string, unknown> {
  const remoteInstalled = normaliseInstalled(remote["installed"]);
  const localInstalled = normaliseInstalled(local["installed"]);

  // Union installed arrays — deduplicate by id.
  const merged = new Map<string, Record<string, unknown>>();
  for (const item of [...localInstalled, ...remoteInstalled]) {
    const key = String(item["id"] ?? item["name"] ?? JSON.stringify(item));
    // Remote entry wins if duplicate id exists (latest metadata).
    merged.set(key, item);
  }

  const remoteVersion = typeof remote["version"] === "string" ? remote["version"] : "0.0.0";
  const localVersion = typeof local["version"] === "string" ? local["version"] : "0.0.0";
  const maxVersion = semverMax(remoteVersion, localVersion);

  return {
    ...local,
    ...remote,
    installed: Array.from(merged.values()),
    version: maxVersion,
  };
}

// ─── Conflict API helpers ─────────────────────────────────────────────────────

/**
 * Resolve a human-required conflict via the API.
 * `resolvedBy` should include a userId prefix: "human:<userId>".
 */
export async function resolveHumanConflict(
  store: IConflictStore,
  conflictId: string,
  resolvedBy: string,
  applyRemote: boolean,
  resolutionNote?: string,
): Promise<{ conflict: ConfigConflictRow; applyEvent: boolean }> {
  const conflicts = await store.listOpenConflicts();
  const conflict = conflicts.find((c) => c.id === conflictId);
  if (!conflict) {
    throw new Error(`Conflict ${conflictId} not found or not open.`);
  }
  if (conflict.strategy !== "human") {
    throw new Error(`Conflict ${conflictId} uses strategy "${conflict.strategy}", not "human".`);
  }

  const note = resolutionNote ?? (applyRemote ? "Human approved remote version." : "Human kept local version.");

  await store.updateConflictStatus(
    conflictId,
    "human_resolved",
    resolvedBy,
    new Date(),
    note,
    undefined,
  );

  await store.appendConflictAudit({
    conflictId,
    entityKind: conflict.entityKind,
    entityId: conflict.entityId,
    peerId: conflict.peerId,
    strategy: conflict.strategy,
    action: "human_resolved",
    resolvedBy,
    resolutionNote: note,
    payloadBefore: conflict.localPayload as Record<string, unknown>,
    payloadAfter: applyRemote
      ? conflict.remotePayload as Record<string, unknown>
      : conflict.localPayload as Record<string, unknown>,
  });

  if (applyRemote) {
    await store.setLastSyncedVersion(conflict.entityKind, conflict.entityId, conflict.remoteVersion);
  }

  return {
    conflict: {
      ...conflict,
      status: "human_resolved",
      resolvedBy,
      resolvedAt: new Date(),
      resolutionNote: note,
    },
    applyEvent: applyRemote,
  };
}

/**
 * Dismiss a conflict (mark it resolved without applying either side).
 * Only valid for LWW / approval_voting conflicts where the user wants to
 * discard both versions.
 */
export async function dismissConflict(
  store: IConflictStore,
  conflictId: string,
  resolvedBy: string,
  resolutionNote?: string,
): Promise<ConfigConflictRow> {
  const conflicts = await store.listOpenConflicts();
  const conflict = conflicts.find((c) => c.id === conflictId);
  if (!conflict) {
    throw new Error(`Conflict ${conflictId} not found or not open.`);
  }

  const note = resolutionNote ?? "Conflict dismissed without applying changes.";

  await store.updateConflictStatus(
    conflictId,
    "dismissed",
    resolvedBy,
    new Date(),
    note,
    undefined,
  );

  await store.appendConflictAudit({
    conflictId,
    entityKind: conflict.entityKind,
    entityId: conflict.entityId,
    peerId: conflict.peerId,
    strategy: conflict.strategy,
    action: "dismissed",
    resolvedBy,
    resolutionNote: note,
    payloadBefore: conflict.localPayload as Record<string, unknown>,
    payloadAfter: undefined,
  });

  return { ...conflict, status: "dismissed", resolvedBy, resolvedAt: new Date() };
}

// ─── Stale conflict notifier ──────────────────────────────────────────────────

/**
 * Checks for conflicts that have been open longer than their entity's
 * `alert_after_h` threshold and invokes the alert callback for each.
 *
 * Call this on a background timer (e.g. every 15 minutes).
 */
export async function notifyStaleConflicts(
  store: IConflictStore,
  alertFn: StaleConflictAlertFn,
  defaultAlertAfterH: number = DEFAULT_ALERT_AFTER_H,
): Promise<number> {
  const nowMs = Date.now();
  const defaultThresholdMs = defaultAlertAfterH * 60 * 60 * 1_000;

  // Fetch conflicts older than the default threshold (over-fetches slightly; we
  // re-check per-entity config below to avoid extra DB round-trips).
  const stale = await store.listStaleConflicts(nowMs - defaultThresholdMs);
  if (stale.length === 0) return 0;

  let alerted = 0;
  for (const conflict of stale) {
    const strategyRow = await store.getConflictStrategy(conflict.entityKind);
    const alertAfterH = strategyRow?.alertAfterH ?? defaultAlertAfterH;
    const thresholdMs = alertAfterH * 60 * 60 * 1_000;

    if (alertAfterH === 0) continue; // Notifications disabled for this kind.

    const ageMs = nowMs - conflict.detectedAt.getTime();
    if (ageMs >= thresholdMs) {
      alertFn(conflict);
      alerted++;
    }
  }
  return alerted;
}

// ─── In-memory store (tests + MemStorage environments) ───────────────────────

/**
 * In-memory implementation of `IConflictStore`.
 * Suitable for unit tests and non-Postgres environments.
 */
export class InMemoryConflictStore implements IConflictStore {
  private conflicts = new Map<string, ConfigConflictRow>();
  private auditLog: Array<InsertConfigConflictAudit & { id: string; recordedAt: Date }> = [];
  private strategies = new Map<string, ConfigConflictStrategyRow>();
  private lastSyncedVersions = new Map<string, string>();
  private localEntityPayloads = new Map<string, Record<string, unknown>>();
  private localEntityVersions = new Map<string, string>();

  async insertConflict(row: InsertConfigConflict): Promise<ConfigConflictRow> {
    const id = crypto.randomUUID();
    const now = new Date();
    const full: ConfigConflictRow = {
      id,
      entityKind: row.entityKind,
      entityId: row.entityId,
      peerId: row.peerId,
      remoteVersion: row.remoteVersion,
      localVersion: row.localVersion,
      remotePayload: row.remotePayload ?? {},
      localPayload: row.localPayload ?? {},
      strategy: row.strategy,
      status: row.status ?? "detected",
      detectedAt: now,
      resolvedAt: null,
      resolvedBy: null,
      resolutionNote: null,
      isContested: row.isContested ?? false,
      mergedPayload: row.mergedPayload ?? null,
    };
    this.conflicts.set(id, full);
    return full;
  }

  async updateConflictStatus(
    id: string,
    status: ConfigConflictStatus,
    resolvedBy: string,
    resolvedAt: Date,
    resolutionNote?: string,
    mergedPayload?: Record<string, unknown>,
  ): Promise<void> {
    const row = this.conflicts.get(id);
    if (!row) return;
    this.conflicts.set(id, {
      ...row,
      status,
      resolvedBy,
      resolvedAt,
      resolutionNote: resolutionNote ?? row.resolutionNote,
      mergedPayload: mergedPayload !== undefined ? mergedPayload : row.mergedPayload,
    });
  }

  async findOpenConflict(entityKind: string, entityId: string): Promise<ConfigConflictRow | null> {
    for (const row of this.conflicts.values()) {
      if (
        row.entityKind === entityKind &&
        row.entityId === entityId &&
        (row.status === "detected" || row.status === "pending_human")
      ) {
        return row;
      }
    }
    return null;
  }

  async listOpenConflicts(entityKind?: string): Promise<ConfigConflictRow[]> {
    return Array.from(this.conflicts.values()).filter(
      (c) =>
        (c.status === "detected" || c.status === "pending_human") &&
        (entityKind === undefined || c.entityKind === entityKind),
    );
  }

  async listStaleConflicts(olderThanMs: number): Promise<ConfigConflictRow[]> {
    return Array.from(this.conflicts.values()).filter(
      (c) =>
        (c.status === "detected" || c.status === "pending_human") &&
        c.detectedAt.getTime() <= olderThanMs,
    );
  }

  async appendConflictAudit(row: InsertConfigConflictAudit): Promise<void> {
    this.auditLog.push({
      ...row,
      id: crypto.randomUUID(),
      recordedAt: new Date(),
    });
  }

  async getConflictStrategy(entityKind: string): Promise<ConfigConflictStrategyRow | null> {
    return this.strategies.get(entityKind) ?? null;
  }

  async getLastSyncedVersion(entityKind: string, entityId: string): Promise<string | null> {
    return this.lastSyncedVersions.get(`${entityKind}:${entityId}`) ?? null;
  }

  async setLastSyncedVersion(entityKind: string, entityId: string, version: string): Promise<void> {
    this.lastSyncedVersions.set(`${entityKind}:${entityId}`, version);
  }

  async getLocalEntityPayload(entityKind: string, entityId: string): Promise<Record<string, unknown> | null> {
    return this.localEntityPayloads.get(`${entityKind}:${entityId}`) ?? null;
  }

  async getLocalEntityVersion(entityKind: string, entityId: string): Promise<string | null> {
    return this.localEntityVersions.get(`${entityKind}:${entityId}`) ?? null;
  }

  // ── Test helpers ─────────────────────────────────────────────────────────

  /** Seed a strategy override for a given entity kind. */
  seedStrategy(entityKind: string, strategy: ConfigConflictStrategy, alertAfterH = 24): void {
    this.strategies.set(entityKind, {
      entityKind,
      strategy,
      markContested: strategy === "lww" || strategy === "approval_voting",
      alertAfterH,
      updatedAt: new Date(),
    });
  }

  /** Seed a local entity (simulates an entity that exists locally). */
  seedLocalEntity(
    entityKind: string,
    entityId: string,
    version: string,
    payload: Record<string, unknown>,
  ): void {
    this.localEntityVersions.set(`${entityKind}:${entityId}`, version);
    this.localEntityPayloads.set(`${entityKind}:${entityId}`, payload);
  }

  /** Get all audit records. */
  getAuditLog() {
    return [...this.auditLog];
  }

  /** Get all conflicts (including resolved). */
  getAllConflicts(): ConfigConflictRow[] {
    return Array.from(this.conflicts.values());
  }

  /** Clear all state. */
  reset(): void {
    this.conflicts = new Map();
    this.auditLog = [];
    this.strategies = new Map();
    this.lastSyncedVersions = new Map();
    this.localEntityPayloads = new Map();
    this.localEntityVersions = new Map();
  }

  /** Enforce in-memory capacity limit (oldest resolved first). */
  enforceCapacity(): void {
    if (this.conflicts.size <= MAX_IN_MEMORY_CONFLICTS) return;
    for (const [id, c] of this.conflicts) {
      if (c.status !== "detected" && c.status !== "pending_human") {
        this.conflicts.delete(id);
        if (this.conflicts.size <= MAX_IN_MEMORY_CONFLICTS) break;
      }
    }
  }

  /** Test helper — backdate a conflict's detectedAt for staleness testing. */
  _backdateConflict(id: string, detectedAt: Date): void {
    const row = this.conflicts.get(id);
    if (row) {
      this.conflicts.set(id, { ...row, detectedAt });
    }
  }
}

// ─── Pure utility helpers ─────────────────────────────────────────────────────

function normaliseInstalled(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === "object" && v !== null) as Array<Record<string, unknown>>;
}

/**
 * Compare two semver strings and return the greater one.
 * Falls back to lexicographic comparison for non-standard version strings.
 */
export function semverMax(a: string, b: string): string {
  const parse = (s: string) =>
    s
      .split(".")
      .map((n) => parseInt(n, 10))
      .filter((n) => !isNaN(n));

  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return a;
    if (nb > na) return b;
  }
  return a; // Equal — return a.
}
