/**
 * Integration tests for the Statistics / LLM request log API.
 *
 * Verifies that the full recording chain works end-to-end using MemStorage
 * (no DB required): createLlmRequest → getLlmRequests → stats endpoints.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";
import type { User } from "../../shared/types.js";

const TEST_ADMIN_USER: User = {
  id: "test-user-id",
  email: "test@example.com",
  name: "Test User",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

describe("Stats API", () => {
  let app: Express;

  beforeAll(async () => {
    const { registerStatsRoutes } = await import("../../server/routes/stats.js");
    const { MemStorage } = await import("../../server/storage.js");

    const storage = new MemStorage();

    // Seed a few LLM request records
    await storage.createLlmRequest({
      runId: "run-1",
      stageExecutionId: null,
      modelSlug: "claude-3-5-sonnet",
      provider: "anthropic",
      messages: [],
      systemPrompt: null,
      temperature: null,
      maxTokens: null,
      responseContent: "Hello",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      latencyMs: 1200,
      estimatedCostUsd: 0.002,
      status: "success",
      errorMessage: null,
      teamId: "planning",
      tags: [],
    });

    await storage.createLlmRequest({
      runId: "run-2",
      stageExecutionId: null,
      modelSlug: "gpt-4o",
      provider: "openai",
      messages: [],
      systemPrompt: null,
      temperature: null,
      maxTokens: null,
      responseContent: "Error occurred",
      inputTokens: 80,
      outputTokens: 0,
      totalTokens: 80,
      latencyMs: 500,
      estimatedCostUsd: null,
      status: "error",
      errorMessage: "API timeout",
      teamId: "architecture",
      tags: [],
    });

    const serverApp = express();
    serverApp.use(express.json());
    serverApp.use((req, _res, next) => {
      req.user = TEST_ADMIN_USER;
      next();
    });
    registerStatsRoutes(serverApp, storage);
    app = serverApp;
  });

  afterAll(() => {
    // nothing to teardown — fully in-memory
  });

  describe("GET /api/stats/overview", () => {
    it("returns aggregated totals", async () => {
      const res = await request(app).get("/api/stats/overview");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        totalRequests: 2,
        totalTokens: expect.objectContaining({
          input: 180,
          output: 50,
          total: 230,
        }),
      });
    });
  });

  describe("GET /api/stats/by-model", () => {
    it("returns per-model breakdown", async () => {
      const res = await request(app).get("/api/stats/by-model");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const slugs = res.body.map((r: { modelSlug: string }) => r.modelSlug);
      expect(slugs).toContain("claude-3-5-sonnet");
      expect(slugs).toContain("gpt-4o");
    });
  });

  describe("GET /api/stats/by-provider", () => {
    it("returns per-provider breakdown", async () => {
      const res = await request(app).get("/api/stats/by-provider");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("GET /api/stats/by-team", () => {
    it("returns per-team breakdown", async () => {
      const res = await request(app).get("/api/stats/by-team");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const teams = res.body.map((r: { teamId: string }) => r.teamId);
      expect(teams).toContain("planning");
    });
  });

  describe("GET /api/stats/requests", () => {
    it("returns paginated request list", async () => {
      const res = await request(app).get("/api/stats/requests?page=1&limit=10");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 2, page: 1, limit: 10 });
      expect(res.body.rows).toHaveLength(2);
    });

    it("filters by status=error", async () => {
      const res = await request(app).get("/api/stats/requests?status=error");
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0].status).toBe("error");
    });

    it("filters by model", async () => {
      const res = await request(app).get("/api/stats/requests?model=gpt-4o");
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0].modelSlug).toBe("gpt-4o");
    });

    it("strips messages and responseContent from list view", async () => {
      const res = await request(app).get("/api/stats/requests");
      expect(res.status).toBe(200);
      for (const row of res.body.rows) {
        expect(row).not.toHaveProperty("messages");
        expect(row).not.toHaveProperty("responseContent");
      }
    });
  });

  describe("GET /api/stats/requests/:id", () => {
    it("returns full request detail including messages", async () => {
      // Get id from list first
      const list = await request(app).get("/api/stats/requests");
      const id = list.body.rows[0].id as number;

      const res = await request(app).get(`/api/stats/requests/${id}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("messages");
      expect(res.body).toHaveProperty("modelSlug");
    });

    it("returns 404 for unknown id", async () => {
      const res = await request(app).get("/api/stats/requests/99999");
      expect(res.status).toBe(404);
    });

    it("returns 400 for non-numeric id", async () => {
      const res = await request(app).get("/api/stats/requests/bad-id");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/stats/timeline", () => {
    it("returns timeline data", async () => {
      const res = await request(app).get("/api/stats/timeline?granularity=day");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("rejects invalid granularity", async () => {
      const res = await request(app).get("/api/stats/timeline?granularity=hour");
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/stats/export", () => {
    it("exports JSON by default", async () => {
      const res = await request(app)
        .post("/api/stats/export?format=json")
        .send({});
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("exports CSV with correct content-type", async () => {
      const res = await request(app)
        .post("/api/stats/export?format=csv")
        .send({});
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(typeof res.text).toBe("string");
      // first line should be the header row
      const firstLine = res.text.split("\n")[0];
      expect(firstLine).toContain("modelSlug");
    });
  });
});
