/**
 * trigger-exporter.ts — Export triggers from DB to YAML config files.
 *
 * Output path: <repoPath>/triggers/<pipeline-name>__<trigger-id>.yaml
 *
 * Schema: TriggerConfigEntitySchema (shared/config-sync/schemas.ts)
 * Note: `secretEncrypted` (webhook secret) is exported to a separate
 *       `.secret` file reference — never embedded in the public YAML.
 */

import path from "path";
import fs from "fs/promises";
import type { IStorage } from "../../storage.js";
import type { Pipeline } from "@shared/schema";
import type { TriggerRow } from "@shared/schema";
import type { TriggerConfigEntity } from "@shared/config-sync/schemas.js";
import { TriggerConfigEntitySchema } from "@shared/config-sync/schemas.js";
import { writeYaml } from "./yaml-writer.js";
import { sanitizeSlug, buildAuditComment } from "./pipeline-exporter.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const API_VERSION = "1.0.0";
const TRIGGERS_DIR = "triggers";

// ─── Public API ───────────────────────────────────────────────────────────────

export interface TriggerExportResult {
  exported: string[];
  errors: Array<{ id: string; pipelineId: string; error: string }>;
}

/**
 * Export all triggers from all pipelines to YAML files.
 *
 * Secrets (webhook secrets stored as `secretEncrypted`) are written to a
 * separate `.raw-secret` text file alongside the YAML so the `secrets add`
 * command can encrypt them.  A `${file:./filename.raw-secret.secret}` reference
 * is NOT injected here — that requires the operator to run `secrets add` after
 * export.  The YAML just notes that a secret exists as a comment.
 */
export async function exportTriggers(
  storage: IStorage,
  repoPath: string,
): Promise<TriggerExportResult> {
  const pipelines = await storage.getPipelines();
  const outDir = path.join(repoPath, TRIGGERS_DIR);

  const exported: string[] = [];
  const errors: TriggerExportResult["errors"] = [];

  for (const pipeline of pipelines) {
    const triggers = await storage.getTriggers(pipeline.id);
    for (const trigger of triggers) {
      try {
        const entity = triggerToEntity(trigger, pipeline);
        const validated = TriggerConfigEntitySchema.parse(entity);

        const slug = buildTriggerSlug(pipeline, trigger);
        const filePath = path.join(outDir, `${slug}.yaml`);

        const comment = buildAuditComment({
          kind: "trigger",
          id: trigger.id,
          createdAt: trigger.createdAt,
          updatedAt: trigger.updatedAt,
        });

        await writeYaml(filePath, validated, { comment });
        exported.push(filePath);

        // If the trigger has an encrypted secret, write a marker file so
        // operators know to decrypt + re-encrypt it via `secrets add`.
        if (trigger.secretEncrypted) {
          const markerPath = path.join(outDir, `${slug}.has-secret`);
          await fs.writeFile(
            markerPath,
            `This trigger has a secretEncrypted value stored in the DB.\n` +
              `Decrypt it and run: mqlti config secrets add triggers/${slug}.raw-secret\n`,
            "utf-8",
          );
        }
      } catch (err: unknown) {
        errors.push({
          id: trigger.id,
          pipelineId: trigger.pipelineId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { exported, errors };
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function triggerToEntity(
  trigger: TriggerRow,
  pipeline: Pipeline,
): TriggerConfigEntity {
  // The config stored in the DB is the TriggerConfig discriminated union.
  // Cast it to the schema shape — the Zod schema validates it.
  const config = (trigger.config ?? {}) as Record<string, unknown>;

  return {
    kind: "trigger",
    apiVersion: API_VERSION,
    pipelineRef: pipeline.name,
    enabled: trigger.enabled ?? true,
    config: config as TriggerConfigEntity["config"],
  };
}

function buildTriggerSlug(pipeline: Pipeline, trigger: TriggerRow): string {
  const pipelineSlug = sanitizeSlug(pipeline.name, pipeline.id);
  const triggerType = String((trigger.config as Record<string, unknown>)?.["type"] ?? "trigger");
  return `${pipelineSlug}__${triggerType}__${trigger.id.slice(0, 8)}`;
}
