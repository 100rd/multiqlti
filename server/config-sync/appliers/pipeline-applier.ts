/**
 * pipeline-applier.ts — Apply pipeline config entities to the DB.
 *
 * Issue #317: Config sync apply path
 *
 * Receives a list of DiffEntry<PipelineConfigEntity> from the diff-engine and
 * writes the changes to storage inside the caller's transaction.
 *
 * Pre-apply check:
 *   Pipelines that have active runs (status !== "completed" / "failed") cannot
 *   be deleted.  The caller is responsible for surfacing this before applying.
 */

import type { IStorage } from "../../storage.js";
import type { PipelineConfigEntity } from "@shared/config-sync/schemas.js";
import type { DiffEntry } from "../diff-engine.js";

export interface PipelineApplyResult {
  created: string[];
  updated: string[];
  deleted: string[];
  errors: Array<{ label: string; error: string }>;
}

/**
 * Apply pipeline diff entries to storage.
 *
 * @param storage     IStorage instance (operates inside a transaction if the
 *                    caller wraps this in one).
 * @param entries     Diff entries from diffPipelines().
 * @param dryRun      When true, validate and compute results but write nothing.
 */
export async function applyPipelines(
  storage: IStorage,
  entries: DiffEntry<PipelineConfigEntity>[],
  dryRun = false,
): Promise<PipelineApplyResult> {
  const result: PipelineApplyResult = { created: [], updated: [], deleted: [], errors: [] };

  // Pre-apply check: collect all pipeline IDs that have active runs
  const activePipelineIds = await getActivePipelineIds(storage);

  for (const entry of entries) {
    try {
      if (entry.kind === "create") {
        if (!entry.entity) continue;
        const entity = entry.entity;
        if (!dryRun) {
          await storage.createPipeline({
            name: entity.name,
            description: entity.description ?? null,
            stages: (entity.stages ?? []) as import("@shared/schema").InsertPipeline["stages"],
            dag: entity.dag as import("@shared/schema").InsertPipeline["dag"] ?? null,
            isTemplate: entity.isTemplate ?? false,
          });
        }
        result.created.push(entry.label);

      } else if (entry.kind === "update") {
        if (!entry.entity) continue;
        const entity = entry.entity;
        // Find the pipeline by name to get its id
        const pipelines = await storage.getPipelines();
        const existing = pipelines.find((p) => p.name === entity.name);
        if (!existing) {
          result.errors.push({ label: entry.label, error: "Pipeline not found for update" });
          continue;
        }
        if (!dryRun) {
          await storage.updatePipeline(existing.id, {
            name: entity.name,
            description: entity.description ?? null,
            stages: (entity.stages ?? []) as import("@shared/schema").InsertPipeline["stages"],
            dag: entity.dag as import("@shared/schema").InsertPipeline["dag"] ?? null,
            isTemplate: entity.isTemplate ?? false,
          });
        }
        result.updated.push(entry.label);

      } else if (entry.kind === "delete") {
        const pipelines = await storage.getPipelines();
        const existing = pipelines.find((p) => p.name === entry.label);
        if (!existing) {
          // Already deleted — not an error
          result.deleted.push(entry.label);
          continue;
        }
        if (activePipelineIds.has(existing.id)) {
          result.errors.push({
            label: entry.label,
            error: "Cannot delete pipeline with active runs. Stop runs first.",
          });
          continue;
        }
        if (!dryRun) {
          await storage.deletePipeline(existing.id);
        }
        result.deleted.push(entry.label);
      }
    } catch (err: unknown) {
      result.errors.push({
        label: entry.label,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getActivePipelineIds(storage: IStorage): Promise<Set<string>> {
  const active = new Set<string>();
  try {
    const runs = await storage.getPipelineRuns();
    const TERMINAL = new Set(["completed", "failed", "cancelled"]);
    for (const run of runs) {
      if (!TERMINAL.has(run.status)) {
        active.add(run.pipelineId);
      }
    }
  } catch {
    // If we can't query runs, proceed conservatively (empty set = no protection)
  }
  return active;
}
