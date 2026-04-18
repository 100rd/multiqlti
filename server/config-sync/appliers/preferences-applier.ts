/**
 * preferences-applier.ts — Apply preferences config entities to the DB.
 *
 * Issue #317: Config sync apply path
 *
 * Preferences are stored via `upsertWorkspaceSettings`.  The scope field in
 * the YAML determines how they map to storage:
 *
 *   scope: "global"   →  upsertWorkspaceSettings("__global__", patch)
 *   scope: "user"     →  upsertWorkspaceSettings(entity.userId, patch)
 *
 * Delete is OFF by default for preferences (tombstone=false).  When enabled
 * it resets the workspace settings to an empty object.
 */

import type { IStorage } from "../../storage.js";
import type { PreferencesConfigEntity } from "@shared/config-sync/schemas.js";
import type { DiffEntry } from "../diff-engine.js";

/** Sentinel workspace ID for global preferences. */
const GLOBAL_WORKSPACE_ID = "__global__";

export interface PreferencesApplyResult {
  created: string[];
  updated: string[];
  deleted: string[];
  errors: Array<{ label: string; error: string }>;
}

/**
 * Apply preferences diff entries to storage.
 *
 * @param storage   IStorage instance.
 * @param entries   Diff entries from diffPreferences().
 * @param dryRun    When true, validate but write nothing.
 */
export async function applyPreferences(
  storage: IStorage,
  entries: DiffEntry<PreferencesConfigEntity>[],
  dryRun = false,
): Promise<PreferencesApplyResult> {
  const result: PreferencesApplyResult = { created: [], updated: [], deleted: [], errors: [] };

  for (const entry of entries) {
    try {
      if (entry.kind === "create" || entry.kind === "update") {
        if (!entry.entity) continue;
        const entity = entry.entity;

        const workspaceId = resolveWorkspaceId(entity);

        if (!dryRun) {
          await storage.upsertWorkspaceSettings(workspaceId, {
            ui: entity.ui,
            ...entity.extra,
          });
        }

        if (entry.kind === "create") {
          result.created.push(entry.label);
        } else {
          result.updated.push(entry.label);
        }

      } else if (entry.kind === "delete") {
        // Reset to empty — only if tombstone mode is explicitly requested
        const workspaceId = entry.label === "global"
          ? GLOBAL_WORKSPACE_ID
          : entry.label.replace(/^user:/, "");

        if (!dryRun) {
          await storage.upsertWorkspaceSettings(workspaceId, {});
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

function resolveWorkspaceId(entity: PreferencesConfigEntity): string {
  if (entity.scope === "user" && entity.userId) return entity.userId;
  return GLOBAL_WORKSPACE_ID;
}
