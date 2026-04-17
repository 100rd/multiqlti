/**
 * Inventory & Dependency Graph REST API (issue #275)
 *
 * 3 endpoints:
 *   GET  /api/workspaces/:id/inventory             → full dependency graph
 *   GET  /api/workspaces/:id/connections/:cid/dependents → who uses this connection
 *   GET  /api/workspaces/:id/inventory/orphans     → unused nodes
 *
 * RBAC: admin + maintainer (same as connections read access).
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import { requireRole } from "../auth/middleware";
import {
  buildInventoryGraph,
  getConnectionDependents,
  getOrphanNodes,
} from "../services/inventory";
import { log } from "../index";

// ─── Param schemas ────────────────────────────────────────────────────────────

const WorkspaceParamsSchema = z.object({
  id: z.string().min(1),
});

const ConnectionParamsSchema = z.object({
  id: z.string().min(1),
  cid: z.string().min(1),
});

// ─── Route registration ───────────────────────────────────────────────────────

export function registerInventoryRoutes(app: Express, storage: IStorage): void {
  // ── GET /api/workspaces/:id/inventory ──────────────────────────────────────
  // Returns the full dependency graph: { nodes, edges }

  app.get(
    "/api/workspaces/:id/inventory",
    requireRole("maintainer", "admin"),
    async (req: Request, res: Response) => {
      const params = WorkspaceParamsSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: params.error.message });
      }

      try {
        const graph = await buildInventoryGraph(storage, params.data.id);
        return res.json(graph);
      } catch (err) {
        log(
          `[inventory] Failed to build graph: ${err instanceof Error ? err.message : err}`,
          "inventory",
        );
        return res.status(500).json({ error: "Failed to build inventory graph" });
      }
    },
  );

  // ── GET /api/workspaces/:id/inventory/orphans ──────────────────────────────
  // Returns connection nodes with no activity in the last 30 days.
  // Note: This route MUST be registered before :cid/dependents to avoid
  // "orphans" being matched as a connection ID.

  app.get(
    "/api/workspaces/:id/inventory/orphans",
    requireRole("maintainer", "admin"),
    async (req: Request, res: Response) => {
      const params = WorkspaceParamsSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: params.error.message });
      }

      try {
        const nodes = await getOrphanNodes(storage, params.data.id);
        return res.json({ nodes });
      } catch (err) {
        log(
          `[inventory] Failed to get orphans: ${err instanceof Error ? err.message : err}`,
          "inventory",
        );
        return res.status(500).json({ error: "Failed to get orphan nodes" });
      }
    },
  );

  // ── GET /api/workspaces/:id/connections/:cid/dependents ────────────────────
  // Returns pipelines/stages that reference this connection.

  app.get(
    "/api/workspaces/:id/connections/:cid/dependents",
    requireRole("maintainer", "admin"),
    async (req: Request, res: Response) => {
      const params = ConnectionParamsSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: params.error.message });
      }

      try {
        const connection = await storage.getWorkspaceConnection(params.data.cid);
        if (!connection) {
          return res.status(404).json({ error: "Connection not found" });
        }
        if (connection.workspaceId !== params.data.id) {
          return res.status(404).json({ error: "Connection not found" });
        }

        const dependents = await getConnectionDependents(storage, params.data.cid);
        return res.json({ connectionId: params.data.cid, dependents });
      } catch (err) {
        log(
          `[inventory] Failed to get dependents: ${err instanceof Error ? err.message : err}`,
          "inventory",
        );
        return res.status(500).json({ error: "Failed to get dependents" });
      }
    },
  );
}
