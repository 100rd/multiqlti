/**
 * pipeline-exporter.ts — Export all pipelines from DB to YAML config files.
 *
 * Output path: <repoPath>/pipelines/<pipeline-name>.yaml
 *
 * Schema: PipelineConfigEntitySchema (shared/config-sync/schemas.ts)
 * Note: Pipeline runs are ephemeral and NOT exported.
 */

import path from "path";
import type { IStorage } from "../../storage.js";
import type { Pipeline } from "@shared/schema";
import type { PipelineConfigEntity } from "@shared/config-sync/schemas.js";
import { PipelineConfigEntitySchema } from "@shared/config-sync/schemas.js";
import { writeYaml } from "./yaml-writer.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const API_VERSION = "1.0.0";
const PIPELINES_DIR = "pipelines";

// Valid execution strategies as per the schema
const VALID_STRATEGIES = ["single", "moa", "debate", "voting"] as const;
type ExecutionStrategy = typeof VALID_STRATEGIES[number];

// ─── Public API ───────────────────────────────────────────────────────────────

export interface PipelineExportResult {
  exported: string[];
  errors: Array<{ id: string; name: string; error: string }>;
}

/**
 * Export all pipelines from storage to YAML files under `<repoPath>/pipelines/`.
 *
 * Each pipeline becomes `<slug>.yaml`.  Validation against the schema is
 * performed before writing — entities that fail are recorded in `errors`
 * without aborting the rest of the export.
 *
 * The export preserves `created_at` and `updated_at` in a metadata comment
 * at the top of each file for audit purposes.
 */
export async function exportPipelines(
  storage: IStorage,
  repoPath: string,
): Promise<PipelineExportResult> {
  const pipelines = await storage.getPipelines();
  const outDir = path.join(repoPath, PIPELINES_DIR);

  const exported: string[] = [];
  const errors: PipelineExportResult["errors"] = [];

  for (const pipeline of pipelines) {
    try {
      const entity = pipelineToEntity(pipeline);
      const validated = PipelineConfigEntitySchema.parse(entity);

      const slug = sanitizeSlug(pipeline.name, pipeline.id);
      const filePath = path.join(outDir, `${slug}.yaml`);

      const comment = buildAuditComment({
        kind: "pipeline",
        id: pipeline.id,
        createdAt: pipeline.createdAt,
        updatedAt: pipeline.updatedAt,
      });

      await writeYaml(filePath, validated, { comment });
      exported.push(filePath);
    } catch (err: unknown) {
      errors.push({
        id: pipeline.id,
        name: pipeline.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { exported, errors };
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function pipelineToEntity(pipeline: Pipeline): PipelineConfigEntity {
  // Extract stage configs — strip runtime/internal fields, keeping only what
  // the schema declares.
  const stageArray = Array.isArray(pipeline.stages) ? pipeline.stages : [];
  const stages = (stageArray as Array<Record<string, unknown>>).map((s) => {
    const rawStrategy = s["executionStrategy"] as string | undefined;
    const executionStrategy = VALID_STRATEGIES.includes(rawStrategy as ExecutionStrategy)
      ? (rawStrategy as ExecutionStrategy)
      : undefined;

    return {
      teamId: s["teamId"] as string,
      modelSlug: s["modelSlug"] as string,
      ...(s["systemPromptOverride"] !== undefined
        ? { systemPromptOverride: s["systemPromptOverride"] as string }
        : {}),
      ...(s["temperature"] !== undefined
        ? { temperature: s["temperature"] as number }
        : {}),
      ...(s["maxTokens"] !== undefined
        ? { maxTokens: s["maxTokens"] as number }
        : {}),
      enabled: (s["enabled"] as boolean | undefined) ?? true,
      ...(s["approvalRequired"] !== undefined
        ? { approvalRequired: s["approvalRequired"] as boolean }
        : {}),
      ...(executionStrategy !== undefined ? { executionStrategy } : {}),
      ...(s["skillId"] !== undefined ? { skillId: s["skillId"] as string } : {}),
      ...(s["delegationEnabled"] !== undefined
        ? { delegationEnabled: s["delegationEnabled"] as boolean }
        : {}),
      ...(s["allowedConnections"] !== undefined
        ? { allowedConnections: s["allowedConnections"] as string[] }
        : {}),
    };
  });

  return {
    kind: "pipeline",
    apiVersion: API_VERSION,
    name: pipeline.name,
    ...(pipeline.description ? { description: pipeline.description } : {}),
    stages,
    ...(pipeline.dag ? { dag: pipeline.dag as PipelineConfigEntity["dag"] } : {}),
    isTemplate: pipeline.isTemplate ?? false,
  };
}

// ─── Shared utilities (exported for reuse in other exporters) ─────────────────

/**
 * Derive a filesystem-safe slug from an entity name, falling back to the
 * first 8 chars of the ID to guarantee uniqueness.
 */
export function sanitizeSlug(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

  return base || id.slice(0, 8);
}

/** Build a YAML header comment with audit timestamps. */
export function buildAuditComment(opts: {
  kind: string;
  id: string;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}): string {
  const lines = [
    `kind: ${opts.kind}`,
    `id: ${opts.id}`,
  ];
  if (opts.createdAt) {
    lines.push(`created_at: ${opts.createdAt.toISOString()}`);
  }
  if (opts.updatedAt) {
    lines.push(`updated_at: ${opts.updatedAt.toISOString()}`);
  }
  lines.push("managed-by: mqlti config export");
  return lines.join("\n");
}
