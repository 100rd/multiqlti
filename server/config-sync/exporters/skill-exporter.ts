/**
 * skill-exporter.ts — Export skill state snapshot to YAML config file.
 *
 * Output path: <repoPath>/skill-states/skill-state.yaml
 *
 * Schema: SkillStateConfigEntitySchema (shared/config-sync/schemas.ts)
 *
 * The skill-state file is a lock-file style snapshot of all installed skills
 * at a point in time.  There is one file per export (not one per skill) to
 * enable atomic "restore to known-good state" semantics.
 *
 * Workspace code (systemPromptOverride) is NOT exported here — that belongs
 * in prompt-exporter.ts.
 */

import path from "path";
import type { IStorage } from "../../storage.js";
import type { Skill } from "@shared/schema";
import type { SkillStateConfigEntity } from "@shared/config-sync/schemas.js";
import { SkillStateConfigEntitySchema } from "@shared/config-sync/schemas.js";
import { writeYaml } from "./yaml-writer.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const API_VERSION = "1.0.0";
const SKILL_STATES_DIR = "skill-states";
const SKILL_STATE_FILENAME = "skill-state.yaml";

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SkillExportResult {
  exported: string[];
  errors: Array<{ id: string; name: string; error: string }>;
}

/**
 * Export the complete skill state snapshot to a single YAML lock file.
 *
 * Builtin skills are included so the state file fully describes the installed
 * skill set.  The `generatedAt` timestamp is set to the export time.
 */
export async function exportSkills(
  storage: IStorage,
  repoPath: string,
): Promise<SkillExportResult> {
  const skills = await storage.getSkills();
  const outDir = path.join(repoPath, SKILL_STATES_DIR);

  const errors: SkillExportResult["errors"] = [];
  const validatedSkills: SkillStateConfigEntity["skills"] = [];

  for (const skill of skills) {
    try {
      validatedSkills.push(skillToEntry(skill));
    } catch (err: unknown) {
      errors.push({
        id: skill.id,
        name: skill.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Sort skills by id for deterministic output
  validatedSkills.sort((a, b) => a.id.localeCompare(b.id));

  const entity: SkillStateConfigEntity = {
    kind: "skill-state",
    apiVersion: API_VERSION,
    generatedAt: new Date().toISOString(),
    skills: validatedSkills,
  };

  const validated = SkillStateConfigEntitySchema.parse(entity);
  const filePath = path.join(outDir, SKILL_STATE_FILENAME);

  const comment = [
    "kind: skill-state",
    `generated_at: ${entity.generatedAt}`,
    `skill_count: ${validatedSkills.length}`,
    "managed-by: mqlti config export",
  ].join("\n");

  await writeYaml(filePath, validated, { comment });

  return {
    exported: [filePath],
    errors,
  };
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function skillToEntry(skill: Skill): SkillStateConfigEntity["skills"][number] {
  // Determine source: builtin skills have isBuiltin flag, git-sourced have sourceType.
  const source = determineSource(skill);

  const entry: SkillStateConfigEntity["skills"][number] = {
    id: skill.id,
    name: skill.name,
    version: normaliseVersion(skill.version),
    source,
    autoUpdate: skill.autoUpdate ?? false,
    ...(skill.externalId ? { externalId: skill.externalId } : {}),
    ...(skill.externalSource ? { registrySource: skill.externalSource } : {}),
    ...(skill.installedAt
      ? { installedAt: toIsoString(skill.installedAt) }
      : {}),
  };

  return entry;
}

function determineSource(
  skill: Skill,
): "builtin" | "market" | "git" | "local" {
  if (skill.isBuiltin) return "builtin";
  if (skill.sourceType === "git") return "git";
  if (skill.externalId) return "market";
  return "local";
}

function normaliseVersion(v: string | null | undefined): string {
  if (!v) return "1.0.0";
  // Accept semver; fall back to "1.0.0" for invalid strings
  if (/^\d+\.\d+\.\d+/.test(v)) return v;
  return "1.0.0";
}

function toIsoString(d: Date | string | null | undefined): string | undefined {
  if (!d) return undefined;
  if (d instanceof Date) return d.toISOString();
  return String(d);
}
