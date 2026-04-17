/**
 * server/routes/workspace-tools.ts
 *
 * REST endpoints for managing custom tool/skill/role sources per workspace.
 *
 * Routes:
 *   GET  /api/workspaces/:id/tools           — tools visible to this workspace
 *   GET  /api/workspaces/:id/custom-tools    — custom tool definitions only
 *   GET  /api/workspaces/:id/custom-skills   — custom skill definitions only
 *   GET  /api/workspaces/:id/custom-roles    — custom role definitions only
 *   GET  /api/workspaces/:id/tool-sources    — current source configuration
 *   PUT  /api/workspaces/:id/tool-sources    — update source configuration + load
 *   POST /api/workspaces/:id/tool-sources/reload — force-reload all sources
 */

import type { Express } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import { workspaceToolRegistry } from "../tools/index";
import { DynamicToolLoader } from "../tools/loader";
import type { WorkspaceToolSourceConfig } from "../../packages/sdk/src/types.js";

// ─── Zod schemas ───────────────────────────────────────────────────────────────

const npmSourceSchema = z.object({
  type: z.literal("npm"),
  package: z.string().min(1).max(200),
  registry: z.string().url().optional(),
});

const localSourceSchema = z.object({
  type: z.literal("local"),
  path: z.string().min(1).max(512),
});

const gitSourceSchema = z.object({
  type: z.literal("git"),
  url: z.string().url().max(512),
  ref: z.string().min(1).max(200).optional(),
  subpath: z.string().min(1).max(200).optional(),
});

const toolSourceSchema = z.discriminatedUnion("type", [
  npmSourceSchema,
  localSourceSchema,
  gitSourceSchema,
]);

const toolSourceConfigSchema = z.object({
  sources: z.array(toolSourceSchema).max(20),
  hotReload: z.boolean().optional(),
});

// ─── In-memory loader map — one DynamicToolLoader per workspace ───────────────

const activeLoaders: Map<string, DynamicToolLoader> = new Map();

function getOrCreateLoader(workspaceId: string): DynamicToolLoader {
  if (!activeLoaders.has(workspaceId)) {
    activeLoaders.set(
      workspaceId,
      new DynamicToolLoader(workspaceId, workspaceToolRegistry),
    );
  }
  return activeLoaders.get(workspaceId)!;
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerWorkspaceToolRoutes(app: Express, _storage: IStorage): void {

  /**
   * GET /api/workspaces/:id/tools
   * Returns all tools visible to the workspace (global + custom overlays).
   */
  app.get("/api/workspaces/:id/tools", (req, res) => {
    const workspaceId = req.params.id as string;
    const tools = workspaceToolRegistry.getAvailableTools(workspaceId);
    res.json(tools);
  });

  /**
   * GET /api/workspaces/:id/custom-tools
   * Returns only the custom tool definitions loaded for this workspace.
   */
  app.get("/api/workspaces/:id/custom-tools", (req, res) => {
    const workspaceId = req.params.id as string;
    const tools = workspaceToolRegistry.getCustomToolDefs(workspaceId);
    res.json(tools);
  });

  /**
   * GET /api/workspaces/:id/custom-skills
   * Returns only the custom skill definitions loaded for this workspace.
   */
  app.get("/api/workspaces/:id/custom-skills", (req, res) => {
    const workspaceId = req.params.id as string;
    const skills = workspaceToolRegistry.getCustomSkills(workspaceId);
    res.json(skills);
  });

  /**
   * GET /api/workspaces/:id/custom-roles
   * Returns only the custom role definitions loaded for this workspace.
   */
  app.get("/api/workspaces/:id/custom-roles", (req, res) => {
    const workspaceId = req.params.id as string;
    const roles = workspaceToolRegistry.getCustomRoles(workspaceId);
    res.json(roles);
  });

  /**
   * GET /api/workspaces/:id/tool-sources
   * Returns the current tool source configuration for the workspace.
   * The configuration is stored in the workspace settings JSON column.
   */
  app.get("/api/workspaces/:id/tool-sources", async (req, res) => {
    const workspaceId = req.params.id as string;
    try {
      const settings = await _storage.getWorkspaceSettings(workspaceId);
      const config = (settings?.toolSources as WorkspaceToolSourceConfig | undefined) ?? { sources: [] };
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: "Failed to retrieve tool source configuration." });
    }
  });

  /**
   * PUT /api/workspaces/:id/tool-sources
   * Updates the tool source configuration and immediately loads/reloads all sources.
   */
  app.put("/api/workspaces/:id/tool-sources", async (req, res) => {
    const workspaceId = req.params.id as string;
    const parse = toolSourceConfigSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({
        error: parse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") || "Validation failed",
      });
    }

    const config = parse.data as WorkspaceToolSourceConfig;

    try {
      // Persist configuration
      await _storage.upsertWorkspaceSettings(workspaceId, { toolSources: config });

      // Load / reload
      const loader = getOrCreateLoader(workspaceId);
      const result = await loader.load(config);

      return res.json({
        toolsRegistered: result.toolsRegistered,
        skillsRegistered: result.skillsRegistered,
        rolesRegistered: result.rolesRegistered,
        errors: result.errors,
        ok: result.errors.length === 0,
      });
    } catch (err) {
      return res.status(500).json({ error: `Failed to update tool sources: ${(err as Error).message}` });
    }
  });

  /**
   * POST /api/workspaces/:id/tool-sources/reload
   * Force-reloads all sources from the persisted configuration.
   */
  app.post("/api/workspaces/:id/tool-sources/reload", async (req, res) => {
    const workspaceId = req.params.id as string;
    try {
      const settings = await _storage.getWorkspaceSettings(workspaceId);
      const config = settings?.toolSources as WorkspaceToolSourceConfig | undefined;
      if (!config || config.sources.length === 0) {
        return res.json({ toolsRegistered: 0, skillsRegistered: 0, rolesRegistered: 0, errors: [], ok: true });
      }

      const loader = getOrCreateLoader(workspaceId);
      const result = await loader.load(config);

      return res.json({
        toolsRegistered: result.toolsRegistered,
        skillsRegistered: result.skillsRegistered,
        rolesRegistered: result.rolesRegistered,
        errors: result.errors,
        ok: result.errors.length === 0,
      });
    } catch (err) {
      return res.status(500).json({ error: `Reload failed: ${(err as Error).message}` });
    }
  });
}
