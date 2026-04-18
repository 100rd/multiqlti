/**
 * connection-applier.ts — Apply connection config entities to the DB.
 *
 * Issue #317: Config sync apply path
 *
 * Connections are scoped to a workspace via `workspaceRef` (the workspace name
 * in the YAML).  The applier resolves the workspace by name to get its ID.
 *
 * SECURITY: No secret material is written here.  The YAML only carries public
 * configuration (URLs, project keys, etc.).  Secrets must be applied separately
 * via the secrets management flow.
 */

import type { IStorage } from "../../storage.js";
import type { ConnectionConfigEntity } from "@shared/config-sync/schemas.js";
import type { DiffEntry } from "../diff-engine.js";

export interface ConnectionApplyResult {
  created: string[];
  updated: string[];
  deleted: string[];
  errors: Array<{ label: string; error: string }>;
}

/**
 * Apply connection diff entries to storage.
 *
 * @param storage   IStorage instance.
 * @param entries   Diff entries from diffConnections().
 * @param dryRun    When true, validate but write nothing.
 */
export async function applyConnections(
  storage: IStorage,
  entries: DiffEntry<ConnectionConfigEntity>[],
  dryRun = false,
): Promise<ConnectionApplyResult> {
  const result: ConnectionApplyResult = { created: [], updated: [], deleted: [], errors: [] };

  // Build workspace name → id lookup
  const workspaces = await storage.getWorkspaces();
  const workspaceByName = new Map(workspaces.map((w) => [w.name, w]));

  for (const entry of entries) {
    try {
      if (entry.kind === "create") {
        if (!entry.entity) continue;
        const entity = entry.entity;

        const workspace = workspaceByName.get(entity.workspaceRef);
        if (!workspace) {
          result.errors.push({
            label: entry.label,
            error: `Workspace "${entity.workspaceRef}" not found — create it first.`,
          });
          continue;
        }

        if (!dryRun) {
          await storage.createWorkspaceConnection({
            workspaceId: workspace.id,
            type: entity.type as import("@shared/types").ConnectionType,
            name: entity.name,
            config: entity.config ?? {},
          });
        }
        result.created.push(entry.label);

      } else if (entry.kind === "update") {
        if (!entry.entity) continue;
        const entity = entry.entity;

        const workspace = workspaceByName.get(entity.workspaceRef);
        if (!workspace) {
          result.errors.push({
            label: entry.label,
            error: `Workspace "${entity.workspaceRef}" not found`,
          });
          continue;
        }

        const connections = await storage.getWorkspaceConnections(workspace.id);
        const existing = connections.find((c) => c.name === entity.name);
        if (!existing) {
          result.errors.push({ label: entry.label, error: "Connection not found for update" });
          continue;
        }

        if (!dryRun) {
          await storage.updateWorkspaceConnection(existing.id, {
            name: entity.name,
            config: entity.config ?? {},
            status: entity.status,
          });
        }
        result.updated.push(entry.label);

      } else if (entry.kind === "delete") {
        // Find connection by name across all workspaces
        let found = false;
        for (const workspace of workspaces) {
          const connections = await storage.getWorkspaceConnections(workspace.id);
          const existing = connections.find((c) => c.name === entry.label);
          if (existing) {
            if (!dryRun) {
              await storage.deleteWorkspaceConnection(existing.id);
            }
            result.deleted.push(entry.label);
            found = true;
            break;
          }
        }
        if (!found) {
          result.deleted.push(entry.label);
        }
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
