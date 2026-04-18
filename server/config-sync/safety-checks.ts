/**
 * safety-checks.ts — Pre-apply safety checks for config-sync.
 *
 * Issue #319: Config sync safety layer
 *
 * Checks:
 *  1. Git conflict markers — aborts if any YAML file contains <<<<<<< / >>>>>>>
 *  2. Uncommitted local DB changes — warns if DB was modified after last_exported_at
 *  3. Active pipeline runs — warns if apply would delete pipelines that have
 *     running/pending pipeline runs
 *  4. Bulk-delete sanity — warns if apply would delete >20% of entities of any type
 */

import fs from "fs/promises";
import path from "path";
import type { IStorage } from "../storage.js";
import type { EntityDiff } from "./diff-engine.js";
import type { EntityType } from "./apply-orchestrator.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export type SafetyLevel = "abort" | "warn";

export interface SafetyIssue {
  level: SafetyLevel;
  code: string;
  message: string;
  details?: string[];
}

export interface SafetyCheckResult {
  /** True when apply may proceed (no abort-level issues). */
  safe: boolean;
  issues: SafetyIssue[];
}

/** Statuses considered "active" for pipeline run blocking. */
const ACTIVE_RUN_STATUSES = new Set(["pending", "running"]);

/** Fraction threshold above which bulk-delete triggers a warning. */
const BULK_DELETE_THRESHOLD = 0.2;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run all pre-apply safety checks.
 *
 * @param repoPath   Absolute path to the config-sync repo root.
 * @param storage    IStorage instance (used to query active runs, entity counts).
 * @param diffs      Per-entity-type diffs already computed by the orchestrator.
 * @param lastExportAt  ISO-8601 timestamp of the last export (for DB drift check).
 * @returns          Combined result — `safe = false` means apply must abort.
 */
export async function runSafetyChecks(
  repoPath: string,
  storage: IStorage,
  diffs: EntityDiff[],
  lastExportAt: string | null,
): Promise<SafetyCheckResult> {
  const issues: SafetyIssue[] = [];

  const conflictIssue = await checkGitConflictMarkers(repoPath);
  if (conflictIssue) issues.push(conflictIssue);

  const driftIssue = await checkUncommittedDbChanges(storage, lastExportAt);
  if (driftIssue) issues.push(driftIssue);

  const activeRunIssues = await checkActiveRunsForDeletedPipelines(storage, diffs);
  issues.push(...activeRunIssues);

  const bulkDeleteIssues = checkBulkDeleteSanity(diffs);
  issues.push(...bulkDeleteIssues);

  const safe = issues.every((i) => i.level !== "abort");

  return { safe, issues };
}

// ─── Check 1: Git conflict markers ───────────────────────────────────────────

/**
 * Walk all YAML files under repoPath and abort if any contain raw git conflict
 * markers (`<<<<<<<` or `>>>>>>>`).
 */
async function checkGitConflictMarkers(
  repoPath: string,
): Promise<SafetyIssue | null> {
  const conflictedFiles: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
        const content = await fs.readFile(full, "utf-8").catch(() => "");
        if (hasConflictMarkers(content)) {
          conflictedFiles.push(path.relative(repoPath, full));
        }
      }
    }
  }

  await walk(repoPath);

  if (conflictedFiles.length === 0) return null;

  return {
    level: "abort",
    code: "GIT_CONFLICT_MARKERS",
    message: `${conflictedFiles.length} YAML file(s) contain unresolved git conflict markers — resolve before applying`,
    details: conflictedFiles,
  };
}

/** Returns true if the text contains git conflict marker lines. */
export function hasConflictMarkers(content: string): boolean {
  const lines = content.split("\n");
  return lines.some(
    (l) => l.startsWith("<<<<<<<") || l.startsWith(">>>>>>>") || l.startsWith("======="),
  );
}

// ─── Check 2: Uncommitted DB changes ─────────────────────────────────────────

/**
 * Warn when DB records were modified after the last export timestamp.
 * This does NOT abort — it is a warning to the operator.
 */
async function checkUncommittedDbChanges(
  storage: IStorage,
  lastExportAt: string | null,
): Promise<SafetyIssue | null> {
  if (!lastExportAt) return null;

  const threshold = new Date(lastExportAt);
  if (isNaN(threshold.getTime())) return null;

  const dirtyCounts: string[] = [];

  try {
    const pipelines = await storage.getPipelines();
    const dirtyPipelines = pipelines.filter(
      (p) => p.updatedAt && new Date(p.updatedAt) > threshold,
    );
    if (dirtyPipelines.length > 0) {
      dirtyCounts.push(`${dirtyPipelines.length} pipeline(s) modified after last export`);
    }
  } catch {
    // If storage can't query, skip gracefully
  }

  try {
    const skills = await storage.getSkills();
    const dirtySkills = skills.filter(
      (s) => s.updatedAt && new Date(s.updatedAt) > threshold,
    );
    if (dirtySkills.length > 0) {
      dirtyCounts.push(`${dirtySkills.length} skill(s) modified after last export`);
    }
  } catch {
    // skip
  }

  if (dirtyCounts.length === 0) return null;

  return {
    level: "warn",
    code: "DB_DRIFT",
    message: "DB has local changes not yet captured in the repo — consider re-exporting first",
    details: dirtyCounts,
  };
}

// ─── Check 3: Active pipeline runs for deleted pipelines ─────────────────────

/**
 * Warn (not abort) when the apply would delete pipelines that currently have
 * active (pending/running) pipeline runs.
 */
async function checkActiveRunsForDeletedPipelines(
  storage: IStorage,
  diffs: EntityDiff[],
): Promise<SafetyIssue[]> {
  const issues: SafetyIssue[] = [];

  const pipelineDiff = diffs.find((d) => d.entityType === "pipeline");
  if (!pipelineDiff) return issues;

  const deletedPipelineLabels = pipelineDiff.entries
    .filter((e) => e.kind === "delete")
    .map((e) => e.label);

  if (deletedPipelineLabels.length === 0) return issues;

  try {
    const allRuns = await storage.getPipelineRuns();
    const activeRuns = allRuns.filter((r) => ACTIVE_RUN_STATUSES.has(r.status));

    if (activeRuns.length === 0) return issues;

    // Map pipeline id → name for lookup
    const pipelines = await storage.getPipelines();
    const idToName = new Map(pipelines.map((p) => [p.id, p.name]));

    const blockedBy: string[] = [];
    for (const run of activeRuns) {
      const name = idToName.get(run.pipelineId);
      if (name && deletedPipelineLabels.includes(name)) {
        blockedBy.push(
          `Pipeline "${name}" has an active run (id=${run.id}, status=${run.status})`,
        );
      }
    }

    if (blockedBy.length > 0) {
      issues.push({
        level: "warn",
        code: "ACTIVE_RUNS_ON_DELETED_PIPELINES",
        message: `${blockedBy.length} pipeline(s) scheduled for deletion have active runs`,
        details: blockedBy,
      });
    }
  } catch {
    // Storage query failure — skip check gracefully
  }

  return issues;
}

// ─── Check 4: Bulk-delete sanity ──────────────────────────────────────────────

/**
 * Warn when the apply would delete more than 20% of entities of any type.
 * This catches accidental mass-deletions.
 */
function checkBulkDeleteSanity(diffs: EntityDiff[]): SafetyIssue[] {
  const issues: SafetyIssue[] = [];

  for (const diff of diffs) {
    const total = diff.entries.length;
    if (total === 0) continue;

    const deleting = diff.entries.filter((e) => e.kind === "delete").length;
    if (deleting === 0) continue;

    const fraction = deleting / total;
    if (fraction > BULK_DELETE_THRESHOLD) {
      const pct = Math.round(fraction * 100);
      issues.push({
        level: "warn",
        code: "BULK_DELETE",
        message: `Apply would delete ${pct}% of ${diff.entityType as EntityType} entities (${deleting}/${total}) — sanity check`,
        details: [
          `Deleting ${deleting} of ${total} ${diff.entityType as EntityType} entities`,
          `Threshold: >${Math.round(BULK_DELETE_THRESHOLD * 100)}% triggers this warning`,
        ],
      });
    }
  }

  return issues;
}
