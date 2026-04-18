/**
 * prompt-exporter.ts — Export prompt configurations from DB to YAML files.
 *
 * Output path: <repoPath>/prompts/<skill-name>.yaml
 *
 * Schema: PromptConfigEntitySchema (shared/config-sync/schemas.ts)
 *
 * Prompts are derived from Skill records that have a systemPromptOverride.
 * Each skill with a non-empty systemPromptOverride gets a prompt YAML
 * capturing its per-stage override as a stageOverride entry.
 */

import path from "path";
import type { IStorage } from "../../storage.js";
import type { Skill } from "@shared/schema";
import type { PromptConfigEntity } from "@shared/config-sync/schemas.js";
import { PromptConfigEntitySchema } from "@shared/config-sync/schemas.js";
import { writeYaml } from "./yaml-writer.js";
import { sanitizeSlug, buildAuditComment } from "./pipeline-exporter.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const API_VERSION = "1.0.0";
const PROMPTS_DIR = "prompts";

// ─── Public API ───────────────────────────────────────────────────────────────

export interface PromptExportResult {
  exported: string[];
  errors: Array<{ id: string; name: string; error: string }>;
}

/**
 * Export prompt configurations from all skills that carry a systemPromptOverride.
 *
 * Skills without a systemPromptOverride are skipped (they have no prompt
 * content to export).
 */
export async function exportPrompts(
  storage: IStorage,
  repoPath: string,
): Promise<PromptExportResult> {
  const skills = await storage.getSkills();
  const outDir = path.join(repoPath, PROMPTS_DIR);

  const exported: string[] = [];
  const errors: PromptExportResult["errors"] = [];

  for (const skill of skills) {
    // Only export skills with meaningful prompt content
    if (!skill.systemPromptOverride) continue;

    try {
      const entity = skillToPromptEntity(skill);
      const validated = PromptConfigEntitySchema.parse(entity);

      const slug = sanitizeSlug(skill.name, skill.id);
      const filePath = path.join(outDir, `${slug}.yaml`);

      const comment = buildAuditComment({
        kind: "prompt",
        id: skill.id,
        createdAt: skill.createdAt,
        updatedAt: skill.updatedAt,
      });

      await writeYaml(filePath, validated, { comment });
      exported.push(filePath);
    } catch (err: unknown) {
      errors.push({
        id: skill.id,
        name: skill.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { exported, errors };
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function skillToPromptEntity(skill: Skill): PromptConfigEntity {
  const tags = Array.isArray(skill.tags) ? (skill.tags as string[]) : [];

  return {
    kind: "prompt",
    apiVersion: API_VERSION,
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    ...(skill.systemPromptOverride
      ? { defaultPrompt: skill.systemPromptOverride }
      : {}),
    stageOverrides: [
      {
        teamId: skill.teamId,
        systemPrompt: skill.systemPromptOverride ?? "",
      },
    ],
    tags: tags.slice(0, 50), // guard against extremely long tag lists
  };
}
