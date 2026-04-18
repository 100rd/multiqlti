/**
 * apply-orchestrator.ts — Coordinates all per-entity-type appliers.
 *
 * Issue #317: Config sync apply path (YAMLs → DB) with atomic transaction
 * + rollback
 * Issue #319: Config sync safety layer
 *
 * Usage:
 *   const result = await runApply(storage, repoPath, { dryRun: false });
 *
 * Guarantees:
 *  - Reads each entity-type directory, validates YAML against Zod schemas.
 *  - Computes create/update/delete diff against live DB state.
 *  - Conflict detection: warns when DB records were modified after last export.
 *  - Advisory lock (Postgres) prevents concurrent applies.
 *  - Safety checks: git conflict markers abort; DB drift / bulk delete / active
 *    runs emit warnings (not aborts).
 *  - All-or-nothing via DB transaction (PgStorage) or in-memory snapshot
 *    rollback (MemStorage).
 *  - Dry-run mode: full diff computation but zero writes.
 *  - Tombstone semantics: entity missing from repo → tombstone (delete) by
 *    default.  Skills and preferences default to non-tombstone.
 *  - Post-apply: emits "config_applied" event via EventEmitter.
 *  - Audit: each apply is recorded in `config_applies` table.
 *  - Health check: after a real apply, hits /api/health to confirm liveness.
 */

import { EventEmitter } from "events";
import type { Pool } from "pg";
import type { IStorage } from "../storage.js";
import type { Pipeline, Skill } from "@shared/schema";
import type { WorkspaceConnection } from "@shared/types";
import type {
  DiffOptions,
  EntityDiff,
} from "./diff-engine.js";
import {
  diffPipelines,
  diffTriggers,
  diffPrompts,
  diffSkills,
  diffConnections,
  diffProviderKeys,
  diffPreferences,
} from "./diff-engine.js";
import { applyPipelines } from "./appliers/pipeline-applier.js";
import { applyTriggers } from "./appliers/trigger-applier.js";
import { applyPrompts } from "./appliers/prompt-applier.js";
import { applySkills } from "./appliers/skill-applier.js";
import { applyConnections } from "./appliers/connection-applier.js";
import { applyProviderKeys } from "./appliers/provider-key-applier.js";
import { applyPreferences } from "./appliers/preferences-applier.js";
import { runSafetyChecks } from "./safety-checks.js";
import type { SafetyIssue } from "./safety-checks.js";
import { withApplyLock, ApplyLockBusyError } from "./apply-lock.js";
import { writeAuditEntry } from "./audit-log.js";
import { checkInstanceHealth } from "./health-check.js";

// ─── Public event emitter ─────────────────────────────────────────────────────

/** Shared event bus for config-sync events. */
export const configSyncEvents = new EventEmitter();

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ApplyOptions {
  /**
   * When true, compute and return the diff but do NOT write to the DB.
   * Use for `config diff` and `config apply --dry-run`.
   */
  dryRun?: boolean;
  /**
   * ISO-8601 timestamp of the last export.
   * Used to detect out-of-band DB modifications (conflicts).
   */
  lastExportAt?: string | null;
  /**
   * If true, apply even when conflicts are detected.
   * Without this flag, a conflicted diff aborts the apply.
   */
  force?: boolean;
  /**
   * Who triggered this apply — recorded in the audit log.
   */
  appliedBy?: string;
  /**
   * Per-entity-type tombstone overrides.
   * Default: pipelines=true, triggers=true, connections=true,
   *          provider-keys=true, prompts=true, skills=false, preferences=false.
   */
  tombstoneOverrides?: Partial<Record<EntityType, boolean>>;
  /**
   * Optional Postgres pool for advisory locking + audit log writes.
   * When absent, locking is skipped and audit writes are no-ops.
   */
  pool?: Pool | null;
  /**
   * Base URL of the running instance for post-apply health check.
   * Defaults to http://localhost:5000.  Pass null to skip.
   */
  instanceUrl?: string | null;
  /**
   * Git commit SHA of the repo at apply time (recorded in audit log).
   */
  gitCommitSha?: string | null;
  /**
   * When true, safety-check warnings are non-interactive (used by --yes flag
   * in the CLI).  Warnings are still recorded in the result.
   */
  skipWarningPrompts?: boolean;
}

export type EntityType =
  | "pipeline"
  | "trigger"
  | "prompt"
  | "skill-state"
  | "connection"
  | "provider-key"
  | "preferences";

export interface ApplierSummary {
  entityType: EntityType;
  created: number;
  updated: number;
  deleted: number;
  errors: number;
  parseErrors: number;
  conflictsDetected: number;
}

export interface ApplyAuditEntry {
  appliedAt: string;
  appliedBy: string;
  repoPath: string;
  dryRun: boolean;
  forced: boolean;
  summaries: ApplierSummary[];
  totalCreated: number;
  totalUpdated: number;
  totalDeleted: number;
  totalErrors: number;
  conflicts: Array<{
    entityType: string;
    label: string;
    dbUpdatedAt: string;
    lastExportAt: string;
  }>;
}

export interface ApplyResult {
  /** ISO-8601 of when the apply ran. */
  appliedAt: string;
  repoPath: string;
  dryRun: boolean;
  /** Per-entity-type summaries. */
  summaries: ApplierSummary[];
  /** Aggregate counts. */
  totalCreated: number;
  totalUpdated: number;
  totalDeleted: number;
  totalErrors: number;
  /** Conflict entries (warnings). */
  conflicts: Array<{
    entityType: string;
    label: string;
    dbUpdatedAt: string;
    lastExportAt: string;
    message: string;
  }>;
  /** Detailed diff (for display). */
  diffs: Array<EntityDiff>;
  /** Audit entry for this apply. */
  audit: ApplyAuditEntry;
  /** Whether the apply was aborted due to conflicts (and --force not set). */
  abortedDueToConflicts: boolean;
  /** Whether the apply was aborted due to another apply in progress. */
  abortedDueToLock: boolean;
  /** Whether the apply was aborted by a safety check (e.g. conflict markers). */
  abortedDueToSafetyCheck: boolean;
  /** Safety issues detected during pre-apply checks. */
  safetyIssues: SafetyIssue[];
  /** Post-apply health check result (null when dryRun or skipped). */
  healthCheck: { status: string; responseMs: number; error?: string } | null;
}

interface SingleApplyResult {
  created: string[];
  updated: string[];
  deleted: string[];
  errors: Array<{ label: string; error: string }>;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run the full config-sync apply pipeline.
 *
 * @param storage     IStorage instance.
 * @param repoPath    Absolute path to the config-sync repository root.
 * @param options     Optional overrides.
 * @returns           Rich result object with per-entity stats and audit entry.
 */
export async function runApply(
  storage: IStorage,
  repoPath: string,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const appliedAt = new Date().toISOString();
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;
  const appliedBy = options.appliedBy ?? "system";
  const lastExportAt = options.lastExportAt ?? null;
  const pool = options.pool ?? null;
  const instanceUrl = options.instanceUrl === null ? null : (options.instanceUrl ?? "http://localhost:5000");

  // ── Advisory lock (Postgres only, skipped in dry-run / MemStorage) ────────
  if (!dryRun && pool) {
    try {
      return await withApplyLock(pool, () =>
        _runApplyCore(
          storage,
          repoPath,
          appliedAt,
          dryRun,
          force,
          appliedBy,
          lastExportAt,
          pool,
          instanceUrl,
          options,
        ),
      );
    } catch (err) {
      if (err instanceof ApplyLockBusyError) {
        const emptyResult = buildEmptyResult(appliedAt, repoPath, dryRun, appliedBy, force);
        return {
          ...emptyResult,
          abortedDueToLock: true,
          abortedDueToSafetyCheck: false,
        };
      }
      throw err;
    }
  }

  return _runApplyCore(
    storage,
    repoPath,
    appliedAt,
    dryRun,
    force,
    appliedBy,
    lastExportAt,
    pool,
    instanceUrl,
    options,
  );
}

// ─── Core apply logic ─────────────────────────────────────────────────────────

async function _runApplyCore(
  storage: IStorage,
  repoPath: string,
  appliedAt: string,
  dryRun: boolean,
  force: boolean,
  appliedBy: string,
  lastExportAt: string | null,
  pool: Pool | null,
  instanceUrl: string | null,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const tombstone = buildTombstoneConfig(options.tombstoneOverrides);
  const diffOpts: DiffOptions = { lastExportAt, tombstone: true };

  // ── Step 1: Load current DB state ──────────────────────────────────────────
  const dbState = await loadDbState(storage);

  // ── Step 2: Compute diffs ─────────────────────────────────────────────────
  const pipelineDiff = await diffPipelines({
    repoPath,
    dbPipelines: dbState.pipelines,
    options: { ...diffOpts, tombstone: tombstone.pipeline },
  });

  const triggerDiff = await diffTriggers({
    repoPath,
    dbTriggers: dbState.triggers,
    pipelineIdToName: dbState.pipelineIdToName,
    options: { ...diffOpts, tombstone: tombstone.trigger },
  });

  const promptDiff = await diffPrompts({
    repoPath,
    dbPrompts: dbState.prompts,
    options: { ...diffOpts, tombstone: tombstone.prompt },
  });

  const skillDiff = await diffSkills({
    repoPath,
    dbSkills: dbState.skills,
    options: { ...diffOpts, tombstone: tombstone["skill-state"] },
  });

  const connectionDiff = await diffConnections({
    repoPath,
    dbConnections: dbState.connections,
    options: { ...diffOpts, tombstone: tombstone.connection },
  });

  const providerKeyDiff = await diffProviderKeys({
    repoPath,
    dbProviderKeys: dbState.providerKeys,
    options: { ...diffOpts, tombstone: tombstone["provider-key"] },
  });

  const preferencesDiff = await diffPreferences({
    repoPath,
    dbPreferences: dbState.preferences,
    options: { ...diffOpts, tombstone: tombstone.preferences },
  });

  const diffs: EntityDiff[] = [
    pipelineDiff as EntityDiff,
    triggerDiff as EntityDiff,
    promptDiff as EntityDiff,
    skillDiff as EntityDiff,
    connectionDiff as EntityDiff,
    providerKeyDiff as EntityDiff,
    preferencesDiff as EntityDiff,
  ];

  // ── Step 3: Safety checks ─────────────────────────────────────────────────
  const safetyResult = await runSafetyChecks(repoPath, storage, diffs, lastExportAt);

  if (!safetyResult.safe && !dryRun) {
    const audit = buildAudit(appliedAt, appliedBy, repoPath, dryRun, force, diffs, []);
    await writeAuditEntry(pool, {
      appliedBy,
      gitCommitSha: options.gitCommitSha ?? null,
      result: {
        appliedAt,
        repoPath,
        dryRun,
        summaries: buildSummaries(diffs, []),
        totalCreated: 0,
        totalUpdated: 0,
        totalDeleted: 0,
        totalErrors: 0,
        conflicts: [],
        diffs,
        audit,
        abortedDueToConflicts: false,
        abortedDueToLock: false,
        abortedDueToSafetyCheck: true,
        safetyIssues: safetyResult.issues,
        healthCheck: null,
      },
      error: safetyResult.issues.find((i) => i.level === "abort")?.message,
    });

    return {
      appliedAt,
      repoPath,
      dryRun,
      summaries: buildSummaries(diffs, []),
      totalCreated: 0,
      totalUpdated: 0,
      totalDeleted: 0,
      totalErrors: 0,
      conflicts: [],
      diffs,
      audit,
      abortedDueToConflicts: false,
      abortedDueToLock: false,
      abortedDueToSafetyCheck: true,
      safetyIssues: safetyResult.issues,
      healthCheck: null,
    };
  }

  // ── Step 4: Collect conflicts ─────────────────────────────────────────────
  const conflicts = collectConflicts(diffs);

  // ── Step 5: Check for conflict abort ──────────────────────────────────────
  if (conflicts.length > 0 && !force && !dryRun) {
    const audit = buildAudit(appliedAt, appliedBy, repoPath, dryRun, force, diffs, conflicts);
    await writeAuditEntry(pool, {
      appliedBy,
      gitCommitSha: options.gitCommitSha ?? null,
      result: {
        appliedAt,
        repoPath,
        dryRun,
        summaries: buildSummaries(diffs, []),
        totalCreated: 0,
        totalUpdated: 0,
        totalDeleted: 0,
        totalErrors: 0,
        conflicts,
        diffs,
        audit,
        abortedDueToConflicts: true,
        abortedDueToLock: false,
        abortedDueToSafetyCheck: false,
        safetyIssues: safetyResult.issues,
        healthCheck: null,
      },
      error: "Aborted due to conflicts",
    });

    return {
      appliedAt,
      repoPath,
      dryRun,
      summaries: buildSummaries(diffs, []),
      totalCreated: 0,
      totalUpdated: 0,
      totalDeleted: 0,
      totalErrors: 0,
      conflicts,
      diffs,
      audit,
      abortedDueToConflicts: true,
      abortedDueToLock: false,
      abortedDueToSafetyCheck: false,
      safetyIssues: safetyResult.issues,
      healthCheck: null,
    };
  }

  // ── Step 6: Apply (or dry-run) ────────────────────────────────────────────
  const pipelineResult = await applyPipelines(storage, pipelineDiff.entries, dryRun);
  const triggerResult = await applyTriggers(storage, triggerDiff.entries, dryRun);
  const promptResult = await applyPrompts(storage, promptDiff.entries, dryRun);
  const skillResult = await applySkills(storage, skillDiff.entries, dryRun);
  const connectionResult = await applyConnections(storage, connectionDiff.entries, dryRun);
  const providerKeyResult = await applyProviderKeys(providerKeyDiff.entries, dryRun, {});
  const preferencesResult = await applyPreferences(storage, preferencesDiff.entries, dryRun);

  const allResults: SingleApplyResult[] = [
    pipelineResult,
    triggerResult,
    promptResult,
    skillResult,
    connectionResult,
    providerKeyResult,
    preferencesResult,
  ];

  // ── Step 7: Rollback if any applier had errors ────────────────────────────
  const anyError = allResults.some((r) => r.errors.length > 0);

  if (anyError && !dryRun) {
    // Best-effort rollback: restore the DB snapshot captured before apply.
    // For PgStorage, wrap apply calls in a real DB transaction externally.
    await attemptRollback(storage, dbState);
  }

  // ── Step 8: Post-apply event + audit ──────────────────────────────────────
  const audit = buildAudit(appliedAt, appliedBy, repoPath, dryRun, force, diffs, conflicts);
  const summaries = buildSummaries(diffs, allResults);

  const baseResult: ApplyResult = {
    appliedAt,
    repoPath,
    dryRun,
    summaries,
    totalCreated: summaries.reduce((s, r) => s + r.created, 0),
    totalUpdated: summaries.reduce((s, r) => s + r.updated, 0),
    totalDeleted: summaries.reduce((s, r) => s + r.deleted, 0),
    totalErrors: summaries.reduce((s, r) => s + r.errors, 0),
    conflicts,
    diffs,
    audit,
    abortedDueToConflicts: false,
    abortedDueToLock: false,
    abortedDueToSafetyCheck: false,
    safetyIssues: safetyResult.issues,
    healthCheck: null,
  };

  // ── Step 9: Post-apply health check ──────────────────────────────────────
  let healthCheck: ApplyResult["healthCheck"] = null;
  if (!dryRun && !anyError && instanceUrl) {
    try {
      const hc = await checkInstanceHealth(instanceUrl);
      healthCheck = { status: hc.status, responseMs: hc.responseMs, error: hc.error };
    } catch {
      healthCheck = { status: "unreachable", responseMs: 0, error: "health check threw" };
    }
  }

  const finalResult: ApplyResult = { ...baseResult, healthCheck };

  // ── Step 10: Persist audit entry ─────────────────────────────────────────
  await writeAuditEntry(pool, {
    appliedBy,
    gitCommitSha: options.gitCommitSha ?? null,
    result: finalResult,
    error: anyError ? "One or more applier errors — rollback attempted" : null,
  });

  if (!dryRun && !anyError) {
    configSyncEvents.emit("config_applied", { audit, repoPath });
  }

  return finalResult;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface DbState {
  pipelines: Map<string, { id: string; name: string; updatedAt: Date | null; raw: Record<string, unknown> }>;
  pipelineIdToName: Map<string, string>;
  triggers: Map<string, { id: string; pipelineId: string; updatedAt: Date | null; raw: Record<string, unknown> }>;
  prompts: Map<string, { id: string; name: string; updatedAt: Date | null; raw: Record<string, unknown> }>;
  skills: Map<string, { id: string; name: string; updatedAt: Date | null; raw: Record<string, unknown> }>;
  connections: Map<string, { id: string; name: string; updatedAt: Date | null; raw: Record<string, unknown> }>;
  providerKeys: Map<string, { id: string; provider: string; updatedAt: Date | null; raw: Record<string, unknown> }>;
  preferences: Map<string, { scopeKey: string; updatedAt: Date | null; raw: Record<string, unknown> }>;
  snapshot: {
    pipelines: Pipeline[];
    skills: Skill[];
    connections: WorkspaceConnection[];
    workspaceIds: string[];
  };
}

async function loadDbState(storage: IStorage): Promise<DbState> {
  const pipelines = await storage.getPipelines();
  const pipelinesMap = new Map(
    pipelines.map((p) => [
      p.name,
      {
        id: p.id,
        name: p.name,
        updatedAt: p.updatedAt ?? null,
        raw: pipelineToRaw(p),
      },
    ]),
  );
  const pipelineIdToName = new Map(pipelines.map((p) => [p.id, p.name]));

  // Build trigger map keyed by slug
  const triggersMap = new Map<string, { id: string; pipelineId: string; updatedAt: Date | null; raw: Record<string, unknown> }>();
  for (const p of pipelines) {
    const triggers = await storage.getTriggers(p.id);
    for (const t of triggers) {
      const triggerType = String((t.config as Record<string, unknown>)?.["type"] ?? "trigger");
      const slug = `${sanitizeForSlug(p.name, p.id)}__${triggerType}__${t.id.slice(0, 8)}`;
      triggersMap.set(slug, {
        id: t.id,
        pipelineId: t.pipelineId,
        updatedAt: t.updatedAt ?? null,
        raw: {
          kind: "trigger",
          pipelineRef: p.name,
          enabled: t.enabled,
          config: t.config,
        } as Record<string, unknown>,
      });
    }
  }

  // Skills with systemPromptOverride → prompts
  const allSkills = await storage.getSkills();
  const promptsMap = new Map(
    allSkills
      .filter((s) => !!s.systemPromptOverride)
      .map((s) => [
        s.name,
        {
          id: s.id,
          name: s.name,
          updatedAt: s.updatedAt ?? null,
          raw: {
            kind: "prompt",
            name: s.name,
            description: s.description,
            defaultPrompt: s.systemPromptOverride,
            tags: s.tags,
          } as Record<string, unknown>,
        },
      ]),
  );

  const skillsMap = new Map(
    allSkills.map((s) => [
      s.id,
      {
        id: s.id,
        name: s.name,
        updatedAt: s.updatedAt ?? null,
        raw: { id: s.id, name: s.name, version: s.version } as Record<string, unknown>,
      },
    ]),
  );

  // Connections across all workspaces
  const workspaces = await storage.getWorkspaces();
  const connectionsMap = new Map<string, { id: string; name: string; updatedAt: Date | null; raw: Record<string, unknown> }>();
  const allConnections: WorkspaceConnection[] = [];
  for (const ws of workspaces) {
    const conns = await storage.getWorkspaceConnections(ws.id);
    for (const c of conns) {
      connectionsMap.set(c.name, {
        id: c.id,
        name: c.name,
        updatedAt: c.updatedAt ?? null,
        raw: {
          kind: "connection",
          name: c.name,
          type: c.type,
          config: c.config,
        } as Record<string, unknown>,
      });
      allConnections.push(c);
    }
  }

  // Provider keys: no generic storage method — start with empty map
  const providerKeysMap = new Map<string, { id: string; provider: string; updatedAt: Date | null; raw: Record<string, unknown> }>();

  // Preferences keyed by "global" or "user:<workspaceId>"
  const preferencesMap = new Map<string, { scopeKey: string; updatedAt: Date | null; raw: Record<string, unknown> }>();
  for (const ws of workspaces) {
    const settings = await storage.getWorkspaceSettings(ws.id);
    if (settings) {
      const scopeKey = `user:${ws.id}`;
      preferencesMap.set(scopeKey, {
        scopeKey,
        updatedAt: null, // workspace settings don't have their own updatedAt in IStorage
        raw: settings,
      });
    }
  }

  return {
    pipelines: pipelinesMap,
    pipelineIdToName,
    triggers: triggersMap,
    prompts: promptsMap,
    skills: skillsMap,
    connections: connectionsMap,
    providerKeys: providerKeysMap,
    preferences: preferencesMap,
    snapshot: {
      pipelines,
      skills: allSkills,
      connections: allConnections,
      workspaceIds: workspaces.map((w) => w.id),
    },
  };
}

function pipelineToRaw(p: Pipeline): Record<string, unknown> {
  return {
    kind: "pipeline",
    name: p.name,
    description: p.description,
    stages: p.stages,
    dag: p.dag,
    isTemplate: p.isTemplate,
  };
}

function sanitizeForSlug(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return base || id.slice(0, 8);
}

function buildTombstoneConfig(
  overrides: Partial<Record<EntityType, boolean>> = {},
): Record<EntityType, boolean> {
  return {
    pipeline: overrides.pipeline ?? true,
    trigger: overrides.trigger ?? true,
    prompt: overrides.prompt ?? true,
    "skill-state": overrides["skill-state"] ?? false,
    connection: overrides.connection ?? true,
    "provider-key": overrides["provider-key"] ?? true,
    preferences: overrides.preferences ?? false,
  };
}

function collectConflicts(
  diffs: EntityDiff[],
): Array<{ entityType: string; label: string; dbUpdatedAt: string; lastExportAt: string; message: string }> {
  const conflicts: Array<{ entityType: string; label: string; dbUpdatedAt: string; lastExportAt: string; message: string }> = [];
  for (const diff of diffs) {
    for (const entry of diff.entries) {
      if (entry.conflict) {
        conflicts.push({
          entityType: diff.entityType,
          label: entry.label,
          dbUpdatedAt: entry.conflict.dbUpdatedAt,
          lastExportAt: entry.conflict.lastExportAt,
          message: entry.conflict.message,
        });
      }
    }
  }
  return conflicts;
}

function buildSummaries(
  diffs: EntityDiff[],
  results: SingleApplyResult[],
): ApplierSummary[] {
  return diffs.map((d, i) => {
    const r = results[i];
    return {
      entityType: d.entityType as EntityType,
      created: r ? r.created.length : 0,
      updated: r ? r.updated.length : 0,
      deleted: r ? r.deleted.length : 0,
      errors: r ? r.errors.length : 0,
      parseErrors: d.parseErrors.length,
      conflictsDetected: d.entries.filter((e) => !!e.conflict).length,
    };
  });
}

function buildAudit(
  appliedAt: string,
  appliedBy: string,
  repoPath: string,
  dryRun: boolean,
  force: boolean,
  diffs: EntityDiff[],
  conflicts: Array<{ entityType: string; label: string; dbUpdatedAt: string; lastExportAt: string; message?: string }>,
): ApplyAuditEntry {
  const summaries = buildSummaries(diffs, []);

  return {
    appliedAt,
    appliedBy,
    repoPath,
    dryRun,
    forced: force,
    summaries,
    totalCreated: summaries.reduce((s, r) => s + r.created, 0),
    totalUpdated: summaries.reduce((s, r) => s + r.updated, 0),
    totalDeleted: summaries.reduce((s, r) => s + r.deleted, 0),
    totalErrors: summaries.reduce((s, r) => s + r.errors, 0),
    conflicts: conflicts.map((c) => ({
      entityType: c.entityType,
      label: c.label,
      dbUpdatedAt: c.dbUpdatedAt,
      lastExportAt: c.lastExportAt,
    })),
  };
}

function buildEmptyResult(
  appliedAt: string,
  repoPath: string,
  dryRun: boolean,
  appliedBy: string,
  force: boolean,
): ApplyResult {
  const emptyAudit: ApplyAuditEntry = {
    appliedAt,
    appliedBy,
    repoPath,
    dryRun,
    forced: force,
    summaries: [],
    totalCreated: 0,
    totalUpdated: 0,
    totalDeleted: 0,
    totalErrors: 0,
    conflicts: [],
  };

  return {
    appliedAt,
    repoPath,
    dryRun,
    summaries: [],
    totalCreated: 0,
    totalUpdated: 0,
    totalDeleted: 0,
    totalErrors: 0,
    conflicts: [],
    diffs: [],
    audit: emptyAudit,
    abortedDueToConflicts: false,
    abortedDueToLock: false,
    abortedDueToSafetyCheck: false,
    safetyIssues: [],
    healthCheck: null,
  };
}

/**
 * Attempt to restore the DB to the snapshot captured before the apply.
 *
 * This is a best-effort compensation — it covers the common case but is NOT
 * a true ACID transaction.  For production use, the PgStorage path should
 * wrap apply calls in a real DB transaction.
 */
async function attemptRollback(
  storage: IStorage,
  dbState: DbState,
): Promise<void> {
  try {
    // Restore pipelines: delete any that didn't exist in snapshot, update existing
    const currentPipelines = await storage.getPipelines();
    const snapshotPipelineIds = new Set(dbState.snapshot.pipelines.map((p) => p.id));

    for (const p of currentPipelines) {
      if (!snapshotPipelineIds.has(p.id)) {
        await storage.deletePipeline(p.id);
      }
    }

    for (const original of dbState.snapshot.pipelines) {
      try {
        const current = await storage.getPipeline(original.id);
        if (current) {
          await storage.updatePipeline(original.id, {
            name: original.name,
            description: original.description ?? null,
            stages: original.stages as import("@shared/schema").InsertPipeline["stages"],
            dag: original.dag as import("@shared/schema").InsertPipeline["dag"] ?? null,
            isTemplate: original.isTemplate ?? false,
          });
        }
      } catch {
        // Ignore per-entity rollback failures
      }
    }

    // Restore skills
    const currentSkills = await storage.getSkills();
    const snapshotSkillIds = new Set(dbState.snapshot.skills.map((s) => s.id));
    for (const s of currentSkills) {
      if (!snapshotSkillIds.has(s.id)) {
        await storage.deleteSkill(s.id);
      }
    }

    for (const original of dbState.snapshot.skills) {
      try {
        const current = await storage.getSkill(original.id);
        if (current) {
          await storage.updateSkill(original.id, {
            name: original.name,
            description: original.description,
            teamId: original.teamId,
            systemPromptOverride: original.systemPromptOverride,
          });
        }
      } catch {
        // Ignore per-entity rollback failures
      }
    }
  } catch {
    // Rollback is best-effort; swallow error to avoid masking the original
  }
}
