/**
 * provider-key-applier.ts — Apply provider-key config entities.
 *
 * Issue #317: Config sync apply path
 *
 * Provider keys require special handling because:
 *  1. IStorage does not expose a generic getProviderKeys/upsertProviderKey API.
 *  2. The YAML only records a `secretRef` pointer — the actual key material must
 *     be decrypted separately via the age-crypto / secrets workflow.
 *
 * This applier therefore accepts an optional `writeProviderKey` callback that
 * the orchestrator (or CLI) can supply to perform the actual DB write.  Without
 * the callback, the applier records operations as dry-run observations.
 *
 * This design keeps the applier testable without a full DB setup and avoids
 * tying it to a specific DB schema that may not be in IStorage.
 */

import type { ProviderKeyConfigEntity } from "@shared/config-sync/schemas.js";
import type { DiffEntry } from "../diff-engine.js";

export type ProviderKeyWriter = (
  provider: string,
  secretRef: string,
  description: string | undefined,
  enabled: boolean,
) => Promise<void>;

export type ProviderKeyDeleter = (provider: string) => Promise<void>;

export interface ProviderKeyApplyOptions {
  /**
   * Callback to write a provider key record.  Must be supplied if dryRun is
   * false, otherwise changes are not persisted.
   */
  onWrite?: ProviderKeyWriter;
  /**
   * Callback to delete a provider key record.
   */
  onDelete?: ProviderKeyDeleter;
}

export interface ProviderKeyApplyResult {
  created: string[];
  updated: string[];
  deleted: string[];
  errors: Array<{ label: string; error: string }>;
}

/**
 * Apply provider-key diff entries.
 *
 * @param entries   Diff entries from diffProviderKeys().
 * @param dryRun    When true, validate but write nothing.
 * @param options   Optional callbacks for persistence.
 */
export async function applyProviderKeys(
  entries: DiffEntry<ProviderKeyConfigEntity>[],
  dryRun = false,
  options: ProviderKeyApplyOptions = {},
): Promise<ProviderKeyApplyResult> {
  const result: ProviderKeyApplyResult = { created: [], updated: [], deleted: [], errors: [] };

  for (const entry of entries) {
    try {
      if (entry.kind === "create" || entry.kind === "update") {
        if (!entry.entity) continue;
        const entity = entry.entity;

        if (!dryRun && options.onWrite) {
          await options.onWrite(
            entity.provider,
            entity.secretRef,
            entity.description,
            entity.enabled ?? true,
          );
        }

        if (entry.kind === "create") {
          result.created.push(entry.label);
        } else {
          result.updated.push(entry.label);
        }

      } else if (entry.kind === "delete") {
        if (!dryRun && options.onDelete) {
          await options.onDelete(entry.label);
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
