/**
 * audit-log.ts — Persistent audit log for config-sync apply operations.
 *
 * Issue #319: Config sync safety layer
 *
 * Writes one row to `config_applies` per apply attempt (success or failure).
 * Falls back to a no-op when the table is not available (MemStorage / test
 * environments).
 */

import type { Pool } from "pg";
import type { ConfigApplySummary } from "@shared/schema";
import type { ApplyResult } from "./apply-orchestrator.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  id: string;
  appliedAt: Date;
  appliedBy: string;
  gitCommitSha: string | null;
  summaryJson: ConfigApplySummary;
  success: boolean;
  error: string | null;
}

export interface WriteAuditEntryOptions {
  appliedBy: string;
  gitCommitSha?: string | null;
  result: ApplyResult;
  error?: string | null;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Persist a config-sync apply result to `config_applies`.
 *
 * Non-throwing — any DB errors are silently ignored to avoid masking the
 * original apply result.
 *
 * @param pool  Postgres pool (may be null in MemStorage environments).
 * @param opts  Apply metadata.
 */
export async function writeAuditEntry(
  pool: Pool | null,
  opts: WriteAuditEntryOptions,
): Promise<void> {
  if (!pool) return;

  const summary: ConfigApplySummary = {
    dryRun: opts.result.dryRun,
    repoPath: opts.result.repoPath,
    totalCreated: opts.result.totalCreated,
    totalUpdated: opts.result.totalUpdated,
    totalDeleted: opts.result.totalDeleted,
    totalErrors: opts.result.totalErrors,
    entityTypes: opts.result.summaries.map((s) => s.entityType),
  };

  const success =
    !opts.result.abortedDueToConflicts &&
    opts.result.totalErrors === 0 &&
    !opts.error;

  try {
    await pool.query(
      `INSERT INTO config_applies
         (applied_by, git_commit_sha, summary_json, success, error)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        opts.appliedBy,
        opts.gitCommitSha ?? null,
        JSON.stringify(summary),
        success,
        opts.error ?? null,
      ],
    );
  } catch {
    // Non-fatal — audit log failure must not break the apply path
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Return the most recent `limit` audit entries ordered newest-first.
 *
 * @param pool   Postgres pool.
 * @param limit  Max rows to return (default 20).
 */
export async function readAuditHistory(
  pool: Pool,
  limit = 20,
): Promise<AuditLogEntry[]> {
  const result = await pool.query<{
    id: string;
    applied_at: Date;
    applied_by: string;
    git_commit_sha: string | null;
    summary_json: ConfigApplySummary;
    success: boolean;
    error: string | null;
  }>(
    `SELECT id, applied_at, applied_by, git_commit_sha, summary_json, success, error
     FROM config_applies
     ORDER BY applied_at DESC
     LIMIT $1`,
    [limit],
  );

  return result.rows.map((r) => ({
    id: r.id,
    appliedAt: r.applied_at,
    appliedBy: r.applied_by,
    gitCommitSha: r.git_commit_sha,
    summaryJson: r.summary_json,
    success: r.success,
    error: r.error,
  }));
}
