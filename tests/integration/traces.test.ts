/**
 * Integration tests — Trace API Routes
 *
 * Tests:
 *   GET /api/runs/:runId/trace
 *   GET /api/traces
 *   GET /api/traces/:traceId
 *
 * Uses MemStorage in-memory backend (no DB, no real LLM calls).
 * Auth is tested via a separate unauthenticated app (no synthetic user injection).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";
import { createTestApp } from "../helpers/test-app.js";
import { registerTraceRoutes } from "../../server/routes/traces.js";
import type { IStorage } from "../../server/storage.js";

// ─── Authenticated App ────────────────────────────────────────────────────────

describe("Trace API Routes", () => {
  let app: Express;
  let closeApp: () => Promise<void>;
  let storage: IStorage;
  let pipelineId: string;
  let runId: string;
  let traceId: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    closeApp = testApp.close;
    storage = testApp.storage;

    // Register trace routes on the test app
    registerTraceRoutes(app, storage);

    // Seed: create a pipeline
    const pipeline = await storage.createPipeline({
      name: "Trace Test Pipeline",
      description: "For trace route tests",
      stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
    });
    pipelineId = pipeline.id;

    // Seed: create a run
    const run = await storage.createPipelineRun({
      pipelineId,
      status: "completed",
      input: "test input",
      currentStageIndex: 0,
    });
    runId = run.id;

    // Seed: create a trace
    traceId = "abcdef1234567890abcdef1234567890";
    await storage.createTrace({
      traceId,
      runId,
      spans: [
        {
          spanId: "abcd1234abcd1234",
          name: "planning.execute",
          startTime: 1000,
          endTime: 2000,
          attributes: { teamId: "planning", tokensUsed: 42 },
          events: [],
          status: "ok",
        },
      ],
    });
  }, 30_000);

  afterAll(async () => {
    await closeApp();
  });

  // ── GET /api/runs/:runId/trace ────────────────────────────────────────────

  describe("GET /api/runs/:runId/trace", () => {
    it("1. 200 — returns trace when trace exists for runId", async () => {
      const res = await request(app).get(`/api/runs/${runId}/trace`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("traceId", traceId);
      expect(res.body).toHaveProperty("runId", runId);
      expect(Array.isArray(res.body.spans)).toBe(true);
      expect(res.body.spans.length).toBeGreaterThan(0);
    });

    it("2. 404 — when no trace exists for runId", async () => {
      // Create a run with no trace
      const emptyRun = await storage.createPipelineRun({
        pipelineId,
        status: "completed",
        input: "empty",
        currentStageIndex: 0,
      });
      const res = await request(app).get(`/api/runs/${emptyRun.id}/trace`);
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("No trace found for run");
    });

    it("4. 400 — invalid UUID in runId param returns 400", async () => {
      const res = await request(app).get("/api/runs/not-a-uuid/trace");
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });
  });

  // ── GET /api/traces ───────────────────────────────────────────────────────

  describe("GET /api/traces", () => {
    it("5. 200 — returns { traces, total } structure", async () => {
      const res = await request(app).get("/api/traces");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("traces");
      expect(res.body).toHaveProperty("total");
      expect(Array.isArray(res.body.traces)).toBe(true);
    });

    it("6. 200 — returns traces after insertion", async () => {
      const res = await request(app).get("/api/traces");
      expect(res.status).toBe(200);
      expect(res.body.traces.length).toBeGreaterThan(0);
    });

    it("7. 200 — ?limit=1 returns at most 1 trace", async () => {
      // Insert a second trace
      const run2 = await storage.createPipelineRun({
        pipelineId,
        status: "completed",
        input: "second",
        currentStageIndex: 0,
      });
      await storage.createTrace({
        traceId: "1111222233334444555566667777888899990000aaaabbbb".slice(0, 32),
        runId: run2.id,
        spans: [],
      });

      const res = await request(app).get("/api/traces?limit=1");
      expect(res.status).toBe(200);
      expect(res.body.traces).toHaveLength(1);
    });

    it("8. 200 — ?offset=100 returns empty when not enough traces", async () => {
      const res = await request(app).get("/api/traces?offset=100");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.traces)).toBe(true);
      expect(res.body.traces).toHaveLength(0);
    });

    it("9. 400 — ?limit=201 returns 400 (exceeds max)", async () => {
      const res = await request(app).get("/api/traces?limit=201");
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });
  });

  // ── GET /api/traces/:traceId ──────────────────────────────────────────────

  describe("GET /api/traces/:traceId", () => {
    it("11. 200 — returns trace by traceId", async () => {
      const res = await request(app).get(`/api/traces/${traceId}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("traceId", traceId);
    });

    it("12. 404 — for unknown traceId", async () => {
      const res = await request(app).get("/api/traces/deadbeefdeadbeefdeadbeefdeadbeef");
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("Trace not found");
    });
  });
});

// ─── Unauthenticated App — 401 Tests ─────────────────────────────────────────

describe("Trace API Routes — 401 (unauthenticated)", () => {
  let unauthApp: Express;
  let unauthStorage: IStorage;
  let runId: string;
  let traceId: string;

  beforeAll(async () => {
    const { MemStorage } = await import("../../server/storage.js");
    const { requireAuth } = await import("../../server/auth/middleware.js");

    unauthStorage = new MemStorage() as unknown as IStorage;

    // Create a pipeline and run for FK integrity
    const pipeline = await unauthStorage.createPipeline({
      name: "Unauth Test Pipeline",
      stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
    });
    const run = await unauthStorage.createPipelineRun({
      pipelineId: pipeline.id,
      status: "completed",
      input: "test",
      currentStageIndex: 0,
    });
    runId = run.id;
    traceId = "ccccddddeeeeffffccccddddeeeeefff";
    await unauthStorage.createTrace({ traceId, runId, spans: [] });

    // Build an app WITHOUT synthetic user injection — requireAuth will return 401
    unauthApp = express();
    unauthApp.use(express.json());
    unauthApp.use("/api/runs", requireAuth);
    unauthApp.use("/api/traces", requireAuth);
    registerTraceRoutes(unauthApp, unauthStorage);
  }, 30_000);

  it("3. GET /api/runs/:runId/trace — 401 unauthenticated", async () => {
    const res = await request(unauthApp).get(`/api/runs/${runId}/trace`);
    expect(res.status).toBe(401);
  });

  it("10. GET /api/traces — 401 unauthenticated", async () => {
    const res = await request(unauthApp).get("/api/traces");
    expect(res.status).toBe(401);
  });

  it("13. GET /api/traces/:traceId — 401 unauthenticated", async () => {
    const res = await request(unauthApp).get(`/api/traces/${traceId}`);
    expect(res.status).toBe(401);
  });
});
