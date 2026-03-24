/**
 * Skill Market Routes — Phase 9.5
 *
 * Endpoints:
 *   GET    /api/skill-market/search               — unified search across all sources
 *   GET    /api/skill-market/sources               — list registries + health
 *   GET    /api/skill-market/details/:source/*id   — full details for a skill
 *   POST   /api/skill-market/install               — install external skill
 *   DELETE /api/skill-market/installed/:skillId     — uninstall external skill
 *   GET    /api/skill-market/installed              — list installed external skills
 *   GET    /api/skill-market/categories             — aggregated category list
 *
 * All routes require authentication (covered by upstream requireAuth middleware).
 */
import type { Router } from "express";
import { z } from "zod";
import type { RegistryManager } from "../skill-market/registry-manager.js";

// ─── Validation schemas ───────────────────────────────────────────────────────

const SearchQuerySchema = z.object({
  q: z.string().default(""),
  sources: z.string().optional(), // comma-separated adapter IDs
  tags: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(["relevance", "popularity", "newest"]).default("relevance"),
});

const InstallSchema = z.object({
  externalId: z.string().min(1),
  config: z.record(z.string()).optional(),
});

// ─── Route registration ───────────────────────────────────────────────────────

export function registerSkillMarketRoutes(
  router: Router,
  manager: RegistryManager | null,
): void {
  // ── GET /api/skill-market/search ──────────────────────────────────────────

  router.get("/api/skill-market/search", async (req, res) => {
    if (!manager) {
      return res
        .status(503)
        .json({ error: "Skill market not available" });
    }
    const parsed = SearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { q, sources, limit, offset, sort } = parsed.data;
    try {
      const result = await manager.searchAll(q, {
        sources: sources?.split(",").filter(Boolean),
        limit,
        offset,
        sort,
      });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── GET /api/skill-market/sources ─────────────────────────────────────────

  router.get("/api/skill-market/sources", async (_req, res) => {
    if (!manager) {
      return res
        .status(503)
        .json({ error: "Skill market not available" });
    }
    try {
      const adapters = manager.listAdapters();
      const health = await manager.healthCheckAll();
      const sources = adapters.map((a) => ({
        id: a.id,
        name: a.name,
        icon: a.icon,
        enabled: a.enabled,
        health: health[a.id],
      }));
      return res.json({ sources });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── GET /api/skill-market/details/:source/*externalId ─────────────────────
  // Uses Express 5 wildcard syntax so externalId can contain slashes.

  router.get("/api/skill-market/details/:source/*externalId", async (req, res) => {
    if (!manager) {
      return res
        .status(503)
        .json({ error: "Skill market not available" });
    }
    const adapter = manager.getAdapter(req.params.source);
    if (!adapter) {
      return res
        .status(404)
        .json({ error: `Unknown source: ${req.params.source}` });
    }
    try {
      const details = await adapter.getDetails(
        `${req.params.source}:${req.params.externalId}`,
      );
      return res.json(details);
    } catch (err) {
      return res.status(502).json({ error: (err as Error).message });
    }
  });

  // ── POST /api/skill-market/install ────────────────────────────────────────

  router.post("/api/skill-market/install", async (req, res) => {
    if (!manager) {
      return res
        .status(503)
        .json({ error: "Skill market not available" });
    }
    const parsed = InstallSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const [source] = parsed.data.externalId.split(":");
    const adapter = manager.getAdapter(source);
    if (!adapter) {
      return res
        .status(404)
        .json({ error: `Unknown source: ${source}` });
    }

    try {
      const userId = (req as any).user?.id ?? "unknown";
      const result = await adapter.install(parsed.data.externalId, userId);
      return res.status(201).json(result);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── DELETE /api/skill-market/installed/:skillId ───────────────────────────

  router.delete("/api/skill-market/installed/:skillId", async (req, res) => {
    if (!manager) {
      return res
        .status(503)
        .json({ error: "Skill market not available" });
    }
    // Future: look up which adapter owns the skill and call adapter.uninstall()
    return res.status(204).send();
  });

  // ── GET /api/skill-market/installed ───────────────────────────────────────

  router.get("/api/skill-market/installed", async (_req, res) => {
    if (!manager) {
      return res
        .status(503)
        .json({ error: "Skill market not available" });
    }
    // Future: query skills table where external_source IS NOT NULL
    return res.json({ installed: [] });
  });

  // ── GET /api/skill-market/categories ──────────────────────────────────────

  router.get("/api/skill-market/categories", async (_req, res) => {
    if (!manager) {
      return res
        .status(503)
        .json({ error: "Skill market not available" });
    }
    return res.json({
      categories: [
        "devops",
        "ai",
        "data",
        "monitoring",
        "security",
        "communication",
      ],
    });
  });
}
