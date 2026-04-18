/**
 * provider-key-exporter.ts — Export provider key references to YAML config.
 *
 * Output path: <repoPath>/provider-keys/<provider>.yaml
 *
 * Schema: ProviderKeyConfigEntitySchema (shared/config-sync/schemas.ts)
 *
 * SECURITY CRITICAL: The actual key material (`apiKeyEncrypted`) is NEVER
 * written to the public YAML.  The YAML only records a `secretRef` pointing
 * to where the key material should be resolved at apply time.
 *
 * The exported `secretRef` uses the `${file:./provider-keys/<provider>.secret}`
 * convention so operators can place the encrypted key file next to the YAML
 * and `mqlti config apply` will resolve it.
 */

import path from "path";
import fs from "fs/promises";
import type { ProviderKeyConfigEntity } from "@shared/config-sync/schemas.js";
import { ProviderKeyConfigEntitySchema } from "@shared/config-sync/schemas.js";
import { writeYaml } from "./yaml-writer.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const API_VERSION = "1.0.0";
const PROVIDER_KEYS_DIR = "provider-keys";

// Providers supported by the config-sync schema
const KNOWN_PROVIDERS = new Set([
  "anthropic",
  "google",
  "openai",
  "xai",
  "mistral",
  "groq",
  "vllm",
  "ollama",
  "lmstudio",
] as const);

type KnownProvider = typeof KNOWN_PROVIDERS extends Set<infer T> ? T : never;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Minimal shape of a provider key row as exposed by the DB.
 * IStorage does not have a generic getProviderKeys() — we accept rows directly.
 */
export interface ProviderKeyRow {
  id: string;
  provider: string;
  /** The encrypted API key — must NOT be written to YAML. */
  apiKeyEncrypted: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface ProviderKeyExportResult {
  exported: string[];
  errors: Array<{ provider: string; error: string }>;
  skipped: Array<{ provider: string; reason: string }>;
}

/**
 * Export provider key entries to YAML files.
 *
 * Each file contains only a `secretRef` — a pointer to the encrypted key file.
 * The `apiKeyEncrypted` field is exported as a separate `.secret` placeholder
 * file so operators can encrypt it with `mqlti config secrets add`.
 *
 * @param rows      Provider key rows from the database.
 * @param repoPath  Root of the config-sync repository.
 */
export async function exportProviderKeys(
  rows: ProviderKeyRow[],
  repoPath: string,
): Promise<ProviderKeyExportResult> {
  const outDir = path.join(repoPath, PROVIDER_KEYS_DIR);

  const exported: string[] = [];
  const errors: ProviderKeyExportResult["errors"] = [];
  const skipped: ProviderKeyExportResult["skipped"] = [];

  for (const row of rows) {
    if (!KNOWN_PROVIDERS.has(row.provider as KnownProvider)) {
      skipped.push({
        provider: row.provider,
        reason: `Unknown provider: ${row.provider}`,
      });
      continue;
    }

    try {
      const secretRefPath = `./provider-keys/${row.provider}.secret`;
      const entity: ProviderKeyConfigEntity = {
        kind: "provider-key",
        apiVersion: API_VERSION,
        provider: row.provider as KnownProvider,
        secretRef: `\${file:${secretRefPath}}`,
        description: `${row.provider} API key — managed by mqlti config export`,
        enabled: true,
      };

      const validated = ProviderKeyConfigEntitySchema.parse(entity);
      const filePath = path.join(outDir, `${row.provider}.yaml`);

      const comment = [
        `kind: provider-key`,
        `provider: ${row.provider}`,
        ...(row.createdAt ? [`created_at: ${row.createdAt.toISOString()}`] : []),
        ...(row.updatedAt ? [`updated_at: ${row.updatedAt.toISOString()}`] : []),
        `managed-by: mqlti config export`,
        `SECURITY: The secret ref points to an encrypted .secret file.`,
        `Run: mqlti config secrets add provider-keys/${row.provider}.raw-secret`,
      ].join("\n");

      await writeYaml(filePath, validated, { comment });
      exported.push(filePath);

      // Write a .has-secret marker so operators know to handle key material
      const markerPath = path.join(outDir, `${row.provider}.has-secret`);
      await fs.writeFile(
        markerPath,
        `Provider key for "${row.provider}" has encrypted material in the DB.\n` +
          `Decrypt it, save to ${row.provider}.raw-secret, then run:\n` +
          `  mqlti config secrets add provider-keys/${row.provider}.raw-secret\n`,
        "utf-8",
      );
    } catch (err: unknown) {
      errors.push({
        provider: row.provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { exported, errors, skipped };
}
