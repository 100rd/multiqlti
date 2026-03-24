/**
 * Integration tests for the Skill Market API (Phase 9.5).
 *
 * We mock the RegistryManager at the HTTP level and test all route behaviour
 * through supertest — same pattern as remote-agents-api.test.ts.
 */
import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import { registerSkillMarketRoutes } from "../../server/routes/skill-market.js";
import type { RegistryManager } from "../../server/skill-market/registry-manager.js";
import type {
  SkillRegistryAdapter,
  ExternalSkillSummary,
  ExternalSkillDetails,
  ExternalSkillResult,
  InstalledSkillResult,
} from "../../server/skill-market/types.js";

// ─── Mock adapter data ──────────────────────────────────────────────────────

function makeSummary(overrides: Partial<ExternalSkillSummary> = {}): ExternalSkillSummary {
  return {
    externalId: "mcp:test-skill",
    name: "Test Skill",
    description: "A test skill",
    author: "test-author",
    version: "1.0.0",
    tags: ["devops"],
    popularity: 42,
    source: "mcp",
    ...overrides,
  };
}

function makeDetails(overrides: Partial<ExternalSkillDetails> = {}): ExternalSkillDetails {
  return {
    externalId: "mcp:test-skill",
    name: "Test Skill",
    description: "A test skill",
    author: "test-author",
    version: "1.0.0",
    tags: ["devops"],
    popularity: 42,
    source: "mcp",
    readme: "# Test",
    license: "MIT",
    ...overrides,
  };
}

// ─── Mock adapter ───────────────────────────────────────────────────────────

function createMockAdapter(id = "mcp"): SkillRegistryAdapter {
  return {
    id,
    name: `${id} Registry`,
    icon: "https://example.com/icon.png",
    enabled: true,

    search: async (_query: string): Promise<ExternalSkillResult> => ({
      items: [makeSummary()],
      total: 1,
      source: id,
    }),

    getDetails: async (externalId: string): Promise<ExternalSkillDetails> =>
      makeDetails({ externalId }),

    install: async (externalId: string, userId: string): Promise<InstalledSkillResult> => ({
      localSkillId: `local-${Date.now()}`,
      externalId,
      externalVersion: "1.0.0",
      source: id,
      installedAt: new Date("2026-03-24T12:00:00Z"),
    }),

    uninstall: async () => {},

    checkUpdates: async () => [],

    healthCheck: async () => ({ ok: true, latencyMs: 50 }),
  };
}

// ─── Mock RegistryManager ───────────────────────────────────────────────────

function createMockManager(): RegistryManager {
  const adapters = new Map<string, SkillRegistryAdapter>();
  const mcpAdapter = createMockAdapter("mcp");
  adapters.set("mcp", mcpAdapter);

  return {
    register: (adapter: SkillRegistryAdapter) => {
      adapters.set(adapter.id, adapter);
    },
    unregister: (id: string) => {
      adapters.delete(id);
    },
    getAdapter: (id: string) => adapters.get(id),
    listAdapters: () => Array.from(adapters.values()),
    listEnabled: () => Array.from(adapters.values()).filter((a) => a.enabled),
    searchAll: async (query: string, options?: any) => {
      const results: ExternalSkillSummary[] = [];
      const sources: Record<string, { count: number; latencyMs: number }> = {};
      for (const adapter of adapters.values()) {
        if (!adapter.enabled) continue;
        if (options?.sources && !options.sources.includes(adapter.id)) continue;
        const r = await adapter.search(query);
        results.push(...r.items);
        sources[adapter.id] = { count: r.items.length, latencyMs: 10 };
      }
      return { results, total: results.length, sources };
    },
    healthCheckAll: async () => {
      const result: Record<string, { ok: boolean; latencyMs: number }> = {};
      for (const adapter of adapters.values()) {
        result[adapter.id] = await adapter.healthCheck();
      }
      return result;
    },
  } as unknown as RegistryManager;
}

// ─── Test App setup ─────────────────────────────────────────────────────────

function createApp(manager: RegistryManager | null) {
  const app = express();
  app.use(express.json());
  registerSkillMarketRoutes(app as any, manager);
  return app;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Skill Market API", () => {
  let app: express.Express;
  let mockManager: RegistryManager;

  beforeAll(() => {
    mockManager = createMockManager();
    app = createApp(mockManager);
  });

  // ── Search ──────────────────────────────────────────────────────────────

  describe("GET /api/skill-market/search", () => {
    it("returns results with default params", async () => {
      const res = await request(app).get("/api/skill-market/search");
      expect(res.status).toBe(200);
      expect(res.body.results).toBeInstanceOf(Array);
      expect(res.body.results.length).toBeGreaterThan(0);
      expect(res.body.total).toBeGreaterThanOrEqual(1);
      expect(res.body.sources).toBeDefined();
      expect(res.body.sources.mcp).toBeDefined();
    });

    it("passes query param to search", async () => {
      const res = await request(app)
        .get("/api/skill-market/search")
        .query({ q: "kubernetes" });
      expect(res.status).toBe(200);
      expect(res.body.results).toBeInstanceOf(Array);
    });

    it("validates limit must be >= 1", async () => {
      const res = await request(app)
        .get("/api/skill-market/search")
        .query({ limit: 0 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it("validates limit must be <= 100", async () => {
      const res = await request(app)
        .get("/api/skill-market/search")
        .query({ limit: 200 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it("validates offset must be >= 0", async () => {
      const res = await request(app)
        .get("/api/skill-market/search")
        .query({ offset: -1 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it("validates sort enum", async () => {
      const res = await request(app)
        .get("/api/skill-market/search")
        .query({ sort: "invalid" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it("filters by sources param", async () => {
      const res = await request(app)
        .get("/api/skill-market/search")
        .query({ sources: "mcp" });
      expect(res.status).toBe(200);
      expect(res.body.sources.mcp).toBeDefined();
    });
  });

  // ── Sources ─────────────────────────────────────────────────────────────

  describe("GET /api/skill-market/sources", () => {
    it("returns adapter list with health", async () => {
      const res = await request(app).get("/api/skill-market/sources");
      expect(res.status).toBe(200);
      expect(res.body.sources).toBeInstanceOf(Array);
      expect(res.body.sources.length).toBeGreaterThan(0);

      const mcp = res.body.sources.find((s: any) => s.id === "mcp");
      expect(mcp).toBeDefined();
      expect(mcp.name).toBe("mcp Registry");
      expect(mcp.enabled).toBe(true);
      expect(mcp.health).toBeDefined();
      expect(mcp.health.ok).toBe(true);
    });
  });

  // ── Details ─────────────────────────────────────────────────────────────

  describe("GET /api/skill-market/details/:source/:externalId", () => {
    it("returns details for known source", async () => {
      const res = await request(app).get(
        "/api/skill-market/details/mcp/test-skill",
      );
      expect(res.status).toBe(200);
      expect(res.body.externalId).toBe("mcp:test-skill");
      expect(res.body.name).toBe("Test Skill");
    });

    it("returns 404 for unknown source", async () => {
      const res = await request(app).get(
        "/api/skill-market/details/unknown/test-skill",
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Unknown source");
    });
  });

  // ── Install ─────────────────────────────────────────────────────────────

  describe("POST /api/skill-market/install", () => {
    it("installs a skill and returns 201", async () => {
      const res = await request(app)
        .post("/api/skill-market/install")
        .send({ externalId: "mcp:test-skill" });
      expect(res.status).toBe(201);
      expect(res.body.externalId).toBe("mcp:test-skill");
      expect(res.body.localSkillId).toBeDefined();
      expect(res.body.source).toBe("mcp");
    });

    it("validates body — missing externalId", async () => {
      const res = await request(app)
        .post("/api/skill-market/install")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it("validates body — empty externalId", async () => {
      const res = await request(app)
        .post("/api/skill-market/install")
        .send({ externalId: "" });
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown source in externalId", async () => {
      const res = await request(app)
        .post("/api/skill-market/install")
        .send({ externalId: "unknown-source:some-skill" });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Unknown source");
    });
  });

  // ── Uninstall ───────────────────────────────────────────────────────────

  describe("DELETE /api/skill-market/installed/:skillId", () => {
    it("returns 204", async () => {
      const res = await request(app).delete(
        "/api/skill-market/installed/some-id",
      );
      expect(res.status).toBe(204);
    });
  });

  // ── Installed ───────────────────────────────────────────────────────────

  describe("GET /api/skill-market/installed", () => {
    it("returns installed list (empty for now)", async () => {
      const res = await request(app).get("/api/skill-market/installed");
      expect(res.status).toBe(200);
      expect(res.body.installed).toEqual([]);
    });
  });

  // ── Categories ──────────────────────────────────────────────────────────

  describe("GET /api/skill-market/categories", () => {
    it("returns category array", async () => {
      const res = await request(app).get("/api/skill-market/categories");
      expect(res.status).toBe(200);
      expect(res.body.categories).toBeInstanceOf(Array);
      expect(res.body.categories).toContain("devops");
      expect(res.body.categories).toContain("ai");
      expect(res.body.categories).toContain("security");
    });
  });

  // ── 503 when manager is null ──────────────────────────────────────────

  describe("503 when manager is null", () => {
    let nullApp: express.Express;

    beforeAll(() => {
      nullApp = createApp(null);
    });

    it("GET /api/skill-market/search returns 503", async () => {
      const res = await request(nullApp).get("/api/skill-market/search");
      expect(res.status).toBe(503);
      expect(res.body.error).toContain("not available");
    });

    it("GET /api/skill-market/sources returns 503", async () => {
      const res = await request(nullApp).get("/api/skill-market/sources");
      expect(res.status).toBe(503);
    });

    it("GET /api/skill-market/details/mcp/x returns 503", async () => {
      const res = await request(nullApp).get(
        "/api/skill-market/details/mcp/x",
      );
      expect(res.status).toBe(503);
    });

    it("POST /api/skill-market/install returns 503", async () => {
      const res = await request(nullApp)
        .post("/api/skill-market/install")
        .send({ externalId: "mcp:x" });
      expect(res.status).toBe(503);
    });

    it("DELETE /api/skill-market/installed/x returns 503", async () => {
      const res = await request(nullApp).delete(
        "/api/skill-market/installed/x",
      );
      expect(res.status).toBe(503);
    });

    it("GET /api/skill-market/installed returns 503", async () => {
      const res = await request(nullApp).get(
        "/api/skill-market/installed",
      );
      expect(res.status).toBe(503);
    });

    it("GET /api/skill-market/categories returns 503", async () => {
      const res = await request(nullApp).get(
        "/api/skill-market/categories",
      );
      expect(res.status).toBe(503);
    });
  });
});
