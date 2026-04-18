/**
 * skill-applier.ts — Apply skill-state snapshot to the DB.
 *
 * Issue #317: Config sync apply path
 *
 * The skill-state YAML is a lock-file: it records which skills should be
 * installed and at what version.  The applier updates skill metadata for
 * existing skills and creates stubs for new ones.
 *
 * Tombstone is OFF by default — skills are not deleted unless the caller
 * explicitly passes tombstone=true to the diff engine.  Deleting a skill
 * that is actively used in pipelines would break those pipelines.
 */

import type { IStorage } from "../../storage.js";
import type { SkillStateConfigEntity } from "@shared/config-sync/schemas.js";
import type { DiffEntry } from "../diff-engine.js";

export interface SkillApplyResult {
  created: string[];
  updated: string[];
  deleted: string[];
  errors: Array<{ label: string; error: string }>;
}

/**
 * Apply skill-state diff entries to storage.
 *
 * Each diff entry refers to a single skill within the skill-state snapshot.
 *
 * @param storage   IStorage instance.
 * @param entries   Diff entries from diffSkills().
 * @param dryRun    When true, validate but write nothing.
 */
export async function applySkills(
  storage: IStorage,
  entries: DiffEntry<SkillStateConfigEntity>[],
  dryRun = false,
): Promise<SkillApplyResult> {
  const result: SkillApplyResult = { created: [], updated: [], deleted: [], errors: [] };

  // Build current skills map by id
  const allSkills = await storage.getSkills();
  const skillById = new Map(allSkills.map((s) => [s.id, s]));
  const skillByName = new Map(allSkills.map((s) => [s.name, s]));

  for (const entry of entries) {
    try {
      const entity = entry.entity;

      if (entry.kind === "create") {
        if (!entity) continue;

        // Find the specific skill in the snapshot by label (name)
        const skillEntry = entity.skills.find((s) => s.name === entry.label);
        if (!skillEntry) {
          result.errors.push({ label: entry.label, error: "Skill entry not found in snapshot" });
          continue;
        }

        // Don't recreate if it already exists (race condition guard)
        if (skillByName.has(skillEntry.name)) {
          result.errors.push({ label: entry.label, error: "Skill already exists — possibly a name collision" });
          continue;
        }

        if (!dryRun) {
          await storage.createSkill({
            id: skillEntry.id,
            name: skillEntry.name,
            description: "",
            teamId: "default",
            systemPromptOverride: "",
            tools: [],
            tags: [],
            isBuiltin: skillEntry.source === "builtin",
            isPublic: true,
            createdBy: "config-sync",
            version: skillEntry.version,
            sharing: "public",
            sourceType: skillEntry.source === "git" ? "git" : "manual",
            externalSource: skillEntry.registrySource ?? undefined,
            externalId: skillEntry.externalId ?? undefined,
            autoUpdate: skillEntry.autoUpdate ?? false,
          });
        }
        result.created.push(entry.label);

      } else if (entry.kind === "update") {
        if (!entity) continue;

        const skillEntry = entity.skills.find((s) => s.name === entry.label);
        if (!skillEntry) {
          result.errors.push({ label: entry.label, error: "Skill entry not found in snapshot" });
          continue;
        }

        const existing = skillById.get(skillEntry.id) ?? skillByName.get(skillEntry.name);
        if (!existing) {
          result.errors.push({ label: entry.label, error: "Skill not found for update" });
          continue;
        }

        if (!dryRun) {
          await storage.updateSkill(existing.id, {
            version: skillEntry.version,
            autoUpdate: skillEntry.autoUpdate ?? false,
            externalSource: skillEntry.registrySource ?? undefined,
            externalId: skillEntry.externalId ?? undefined,
          });
        }
        result.updated.push(entry.label);

      } else if (entry.kind === "delete") {
        // Tombstone: remove the skill
        const existing = skillByName.get(entry.label);
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
