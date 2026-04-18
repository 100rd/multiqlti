/**
 * prompt-applier.ts — Apply prompt config entities to the DB.
 *
 * Issue #317: Config sync apply path
 *
 * Prompts are stored as Skill records with a `systemPromptOverride`.  The
 * applier maps the PromptConfigEntity back to the Skill shape that the
 * existing storage API understands.
 *
 * Delete (tombstone) removes the skill record entirely.  Active-run check
 * is NOT applied to prompts — prompts are template data, not running state.
 */

import type { IStorage } from "../../storage.js";
import type { PromptConfigEntity } from "@shared/config-sync/schemas.js";
import type { DiffEntry } from "../diff-engine.js";

export interface PromptApplyResult {
  created: string[];
  updated: string[];
  deleted: string[];
  errors: Array<{ label: string; error: string }>;
}

/**
 * Apply prompt diff entries to storage.
 *
 * @param storage   IStorage instance.
 * @param entries   Diff entries from diffPrompts().
 * @param dryRun    When true, validate but write nothing.
 */
export async function applyPrompts(
  storage: IStorage,
  entries: DiffEntry<PromptConfigEntity>[],
  dryRun = false,
): Promise<PromptApplyResult> {
  const result: PromptApplyResult = { created: [], updated: [], deleted: [], errors: [] };

  for (const entry of entries) {
    try {
      if (entry.kind === "create") {
        if (!entry.entity) continue;
        const entity = entry.entity;

        if (!dryRun) {
          await storage.createSkill({
            name: entity.name,
            description: entity.description ?? "",
            teamId: pickTeamId(entity),
            systemPromptOverride: entity.defaultPrompt ?? "",
            tools: [],
            tags: entity.tags ?? [],
            isBuiltin: false,
            isPublic: true,
            createdBy: "config-sync",
            version: "1.0.0",
            sharing: "public",
            sourceType: "manual",
          });
        }
        result.created.push(entry.label);

      } else if (entry.kind === "update") {
        if (!entry.entity) continue;
        const entity = entry.entity;

        const skills = await storage.getSkills();
        const existing = skills.find((s) => s.name === entity.name);
        if (!existing) {
          result.errors.push({ label: entry.label, error: "Skill not found for prompt update" });
          continue;
        }

        if (!dryRun) {
          await storage.updateSkill(existing.id, {
            description: entity.description ?? "",
            systemPromptOverride: entity.defaultPrompt ?? "",
            tags: entity.tags ?? [],
          });
        }
        result.updated.push(entry.label);

      } else if (entry.kind === "delete") {
        const skills = await storage.getSkills();
        const existing = skills.find((s) => s.name === entry.label);
        if (!existing) {
          result.deleted.push(entry.label);
          continue;
        }

        if (!dryRun) {
          await storage.deleteSkill(existing.id);
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

/** Extract teamId from the first stage override, or fall back to "default". */
function pickTeamId(entity: PromptConfigEntity): string {
  return entity.stageOverrides?.[0]?.teamId ?? "default";
}
