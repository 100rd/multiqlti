/**
 * Connections YAML Sync API (issue #276)
 *
 * POST /api/workspaces/:id/connections/sync
 *
 * Reads .multiqlti/connections.yaml from the workspace root, diffs against
 * DB state, optionally applies, and returns the plan + drift report.
 *
 * RBAC: admin only (same as connection mutations).
 *
 * Security invariants:
 *   - Resolved secrets are NEVER included in the response.
 *   - Secret resolution errors are reported at the key level, not value level.
 *   - Workspace root is resolved via the WorkspaceManager path helpers.
 */

import type { Express, Request, Response } from "express";
import path from "path";
import { z } from "zod";
import type { IStorage } from "../storage";
import { requireRole } from "../auth/middleware";
import { log } from "../index";
import { syncConnectionsFromYaml } from "../workspace/connections-yaml";

// ─── Zod request schemas ──────────────────────────────────────────────────────

const WorkspaceParamsSchema = z.object({
  id: z.string().min(1),
});

const SyncBodySchema = z.object({
  autoApply: z.boolean().optional().default(false),
  includeDeletes: z.boolean().optional().default(false),
});

// ─── Workspace root resolver ─────────────────────────────────────────────────

const WORKSPACE_DATA_DIR = path.resolve("data/workspaces");

function resolveWorkspaceRoot(workspace: { type: string; id: string; path: string }): string {
  if (workspace.type === "local") return workspace.path;
  return path.join(WORKSPACE_DATA_DIR, workspace.id);
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerConnectionsYamlRoutes(app: Express, storage: IStorage): void {
  /**
   * POST /api/workspaces/:id/connections/sync
   *
   * Read .multiqlti/connections.yaml, build reconciliation plan, optionally apply.
   *
   * Response shape:
   * {
   *   yamlMissing: boolean,
   *   plan: { actions, hasChanges },
   *   applied: boolean,
   *   applyResult?: { created, updated, deleted, errors },
   *   drift: [{ connectionId, connectionName, connectionType, driftedConfigKeys }]
   * }
   */
  app.post(
    "/api/workspaces/:id/connections/sync",
    requireRole("admin"),
    async (req: Request, res: Response) => {
      const params = WorkspaceParamsSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: params.error.message });
      }

      const body = SyncBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        return res.status(400).json({
          error: "Invalid request body",
          issues: body.error.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }

      try {
        const workspace = await storage.getWorkspace(params.data.id);
        if (!workspace) {
          return res.status(404).json({ error: "Workspace not found" });
        }

        const workspaceRoot = resolveWorkspaceRoot(workspace);

        const result = await syncConnectionsFromYaml(
          params.data.id,
          workspaceRoot,
          storage,
          {
            autoApply: body.data.autoApply,
            includeDeletes: body.data.includeDeletes,
            createdBy: req.user?.id ?? null,
          },
        );

        log(
          `[connections-yaml] sync workspaceId=${params.data.id} ` +
          `actions=${result.plan.actions.length} applied=${result.applied} ` +
          `drift=${result.drift.length}`,
          "connections-yaml",
        );

        // Strip internal yamlEntry details from actions (no need to expose full YAML data)
        const sanitizedActions = result.plan.actions.map((a) => ({
          type: a.type,
          connectionName: a.connectionName,
          reason: a.reason,
        }));

        return res.json({
          yamlMissing: result.yamlMissing,
          plan: {
            actions: sanitizedActions,
            hasChanges: result.plan.hasChanges,
          },
          applied: result.applied,
          ...(result.applyResult ? { applyResult: result.applyResult } : {}),
          drift: result.drift,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log(`[connections-yaml] sync error: ${message}`, "connections-yaml");

        // YAML schema violations are user errors (400), not server errors (500)
        if (
          message.includes("connections.yaml validation failed") ||
          message.includes("Plaintext secrets") ||
          message.includes("YAML parse error")
        ) {
          return res.status(400).json({ error: message });
        }

        return res.status(500).json({ error: "Connections sync failed" });
      }
    },
  );
}
