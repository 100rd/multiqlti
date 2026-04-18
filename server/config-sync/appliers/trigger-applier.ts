/**
 * trigger-applier.ts — Apply trigger config entities to the DB.
 *
 * Issue #317: Config sync apply path
 *
 * Triggers are identified by a slug `pipelineName__type__id8` (derived from the
 * YAML filename).  On create, the pipeline must already exist in the DB so we
 * can resolve its ID.  On delete, we look up by the 8-char id prefix embedded
 * in the slug.
 */

import type { IStorage } from "../../storage.js";
import type { TriggerRow } from "@shared/schema";
import type { TriggerConfigEntity } from "@shared/config-sync/schemas.js";
import type { DiffEntry } from "../diff-engine.js";

export interface TriggerApplyResult {
  created: string[];
  updated: string[];
  deleted: string[];
  errors: Array<{ label: string; error: string }>;
}

/**
 * Apply trigger diff entries to storage.
 *
 * @param storage   IStorage instance.
 * @param entries   Diff entries from diffTriggers().
 * @param dryRun    When true, validate but write nothing.
 */
export async function applyTriggers(
  storage: IStorage,
  entries: DiffEntry<TriggerConfigEntity>[],
  dryRun = false,
): Promise<TriggerApplyResult> {
  const result: TriggerApplyResult = { created: [], updated: [], deleted: [], errors: [] };

  // Build pipeline name → id lookup once
  const pipelines = await storage.getPipelines();
  const pipelineByName = new Map(pipelines.map((p) => [p.name, p]));

  for (const entry of entries) {
    try {
      if (entry.kind === "create") {
        if (!entry.entity) continue;
        const entity = entry.entity;

        const pipeline = pipelineByName.get(entity.pipelineRef);
        if (!pipeline) {
          result.errors.push({
            label: entry.label,
            error: `Pipeline "${entity.pipelineRef}" not found — create the pipeline first.`,
          });
          continue;
        }

        const triggerType = entity.config.type;
        if (!dryRun) {
          // createTrigger requires the full TriggerRow minus id/timestamps,
          // plus optional secretEncrypted.  We pass null for secretEncrypted
          // since the YAML never carries secret material.
          const createData: Omit<TriggerRow, "id" | "createdAt" | "updatedAt" | "lastTriggeredAt"> & { secretEncrypted?: string | null } = {
            pipelineId: pipeline.id,
            type: triggerType as TriggerRow["type"],
            config: entity.config as TriggerRow["config"],
            enabled: entity.enabled ?? true,
            secretEncrypted: null,
          };
          await storage.createTrigger(createData);
        }
        result.created.push(entry.label);

      } else if (entry.kind === "update") {
        if (!entry.entity) continue;
        const entity = entry.entity;

        // Extract id from the slug (last 8 chars of last segment)
        const triggerId = extractIdFromSlug(entry.label);
        if (!triggerId) {
          result.errors.push({ label: entry.label, error: "Cannot parse trigger ID from slug" });
          continue;
        }

        const trigger = await storage.getTrigger(triggerId);
        if (!trigger) {
          result.errors.push({ label: entry.label, error: `Trigger ${triggerId} not found` });
          continue;
        }

        if (!dryRun) {
          await storage.updateTrigger(trigger.id, {
            config: entity.config as TriggerRow["config"],
            enabled: entity.enabled ?? true,
          });
        }
        result.updated.push(entry.label);

      } else if (entry.kind === "delete") {
        const triggerId = extractIdFromSlug(entry.label);
        if (!triggerId) {
          result.errors.push({ label: entry.label, error: "Cannot parse trigger ID from slug" });
          continue;
        }

        const trigger = await storage.getTrigger(triggerId);
        if (!trigger) {
          // Already gone — count as deleted
          result.deleted.push(entry.label);
          continue;
        }

        if (!dryRun) {
          await storage.deleteTrigger(trigger.id);
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

/**
 * Extract the 8-char trigger ID from a slug like
 * `my-pipeline__webhook__ab12cd34`.
 */
function extractIdFromSlug(slug: string): string | null {
  const parts = slug.split("__");
  if (parts.length < 3) return null;
  return parts[parts.length - 1] ?? null;
}
