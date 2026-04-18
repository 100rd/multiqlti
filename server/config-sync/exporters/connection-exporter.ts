/**
 * connection-exporter.ts — Export workspace connections from DB to YAML files.
 *
 * Output path: <repoPath>/connections/<name>.yaml
 * Secret path: <repoPath>/connections/<name>.raw-secret  (if hasSecrets)
 *
 * Schema: ConnectionConfigEntitySchema (shared/config-sync/schemas.ts)
 *
 * SECURITY: `secretsEncrypted` / `hasSecrets` flag is NEVER written to the
 * public YAML.  Only the non-secret `config` fields are exported.  If a
 * connection has secrets, a `.has-secret` marker file is written to prompt
 * the operator to run `secrets add` after export.
 */

import path from "path";
import fs from "fs/promises";
import type { IStorage } from "../../storage.js";
import type { WorkspaceConnection } from "@shared/types";
import type { ConnectionConfigEntity } from "@shared/config-sync/schemas.js";
import { ConnectionConfigEntitySchema } from "@shared/config-sync/schemas.js";
import { writeYaml } from "./yaml-writer.js";
import { sanitizeSlug, buildAuditComment } from "./pipeline-exporter.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const API_VERSION = "1.0.0";
const CONNECTIONS_DIR = "connections";

// Map WorkspaceConnection.type to the connection kinds known to the schema.
// Types that do not map to a recognised schema kind are skipped.
const KNOWN_TYPES = new Set([
  "gitlab",
  "github",
  "kubernetes",
  "aws",
  "jira",
  "grafana",
  "generic_mcp",
] as const);

type KnownConnectionKind = typeof KNOWN_TYPES extends Set<infer T> ? T : never;

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ConnectionExportResult {
  exported: string[];
  errors: Array<{ id: string; name: string; error: string }>;
  skipped: Array<{ id: string; name: string; reason: string }>;
}

/**
 * Export all workspace connections to YAML files.
 *
 * Connections with unknown types are skipped rather than failing.
 * Secret material is never written to YAML — only a marker file is written
 * so operators know to apply encryption separately.
 */
export async function exportConnections(
  storage: IStorage,
  repoPath: string,
): Promise<ConnectionExportResult> {
  // Get all workspaces, then all connections per workspace
  const workspaces = await storage.getWorkspaces();
  const outDir = path.join(repoPath, CONNECTIONS_DIR);

  const exported: string[] = [];
  const errors: ConnectionExportResult["errors"] = [];
  const skipped: ConnectionExportResult["skipped"] = [];

  const seenSlugs = new Set<string>();

  for (const workspace of workspaces) {
    const connections = await storage.getWorkspaceConnections(workspace.id);

    for (const conn of connections) {
      if (!KNOWN_TYPES.has(conn.type as KnownConnectionKind)) {
        skipped.push({
          id: conn.id,
          name: conn.name,
          reason: `Unknown connection type: ${conn.type}`,
        });
        continue;
      }

      try {
        const entity = connectionToEntity(conn, workspace.name);
        const validated = ConnectionConfigEntitySchema.parse(entity);

        const slug = uniqueSlug(conn.name, conn.id, seenSlugs);
        seenSlugs.add(slug);

        const filePath = path.join(outDir, `${slug}.yaml`);

        const comment = buildAuditComment({
          kind: "connection",
          id: conn.id,
          createdAt: conn.createdAt,
          updatedAt: conn.updatedAt,
        });

        await writeYaml(filePath, validated, { comment });
        exported.push(filePath);

        // Write secret marker file if secrets exist
        if (conn.hasSecrets) {
          const markerPath = path.join(outDir, `${slug}.has-secret`);
          await fs.writeFile(
            markerPath,
            `Connection "${conn.name}" has encrypted secrets in the DB.\n` +
              `After decrypting them, run:\n` +
              `  mqlti config secrets add connections/${slug}.raw-secret\n`,
            "utf-8",
          );
        }
      } catch (err: unknown) {
        errors.push({
          id: conn.id,
          name: conn.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { exported, errors, skipped };
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function connectionToEntity(
  conn: WorkspaceConnection,
  workspaceName: string,
): ConnectionConfigEntity {
  return {
    kind: "connection",
    apiVersion: API_VERSION,
    name: conn.name,
    type: conn.type as KnownConnectionKind,
    workspaceRef: workspaceName,
    config: conn.config ?? {},
    status: (conn.status ?? "active") as "active" | "inactive",
  };
}

/** Build a slug that is unique within the current export run. */
function uniqueSlug(
  name: string,
  id: string,
  seen: Set<string>,
): string {
  let base = sanitizeSlug(name, id);
  if (!seen.has(base)) return base;
  // Append short id suffix to disambiguate
  base = `${base}__${id.slice(0, 8)}`;
  return base;
}
