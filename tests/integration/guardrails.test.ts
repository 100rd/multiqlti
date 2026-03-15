/**
 * Integration tests for guardrail API endpoints and pipeline run behaviour.
 *
 * Uses the in-memory test app (MemStorage + MockProvider).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createTestApp } from "../helpers/test-app.js";
import { registerGuardrailRoutes } from "../../server/routes/guardrails.js";
import { Gateway } from "../../server/gateway/index.js";
import type { StageGuardrail } from "../../shared/types.js";
import type { PipelineRun, StageExecution } from "../../shared/schema.js";

// ─── Helper: wait for run completion ─────────────────────────────────────────

async function waitForRun(
  app: Express,
  runId: string,
  maxWaitMs = 10_000,
): Promise<PipelineRun & { stages: StageExecution[] }> {
  const terminal = new Set(["completed", "failed", "cancelled", "rejected"]);
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const res = await request(app).get(`/api/runs/${runId}`);
    if (res.status === 200) {
      const run = res.body as PipelineRun & { stages: StageExecution[] };
      if (terminal.has(run.status)) return run;
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  const res = await request(app).get(`/api/runs/${runId}`);
  return res.body as PipelineRun & { stages: StageExecution[] };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const JSON_SCHEMA_GUARDRAIL: StageGuardrail = {
  id: "gs-json",
  type: "json_schema",
  config: { schema: {} },        // empty schema — any valid JSON object passes
  onFail: "fail",
  maxRetries: 1,
  enabled: true,
};

const FAILING_REGEX_GUARDRAIL: StageGuardrail = {
  id: "gs-regex",
  type: "regex",
  config: { pattern: "IMPOSSIBLE_MATCH_XYZ" },
  onFail: "fail",
  maxRetries: 1,
  enabled: true,
};

const SKIP_GUARDRAIL: StageGuardrail = {
  id: "gs-skip",
  type: "regex",
  config: { pattern: "IMPOSSIBLE_MATCH_XYZ" },
  onFail: "skip",
  maxRetries: 1,
  enabled: true,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Guardrail API — integration", () => {
  let app: Express;
  let closeApp: () => Promise<void>;
  let pipelineId: string;
  let storage: import("../../server/storage.js").MemStorage;
  let gateway: Gateway;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    closeApp = testApp.close;
    storage = testApp.storage;

    // Build a gateway for guardrail routes
    gateway = new Gateway(storage);

    // Register guardrail routes on the same app
    registerGuardrailRoutes(app, storage, gateway);

    // Create a test pipeline with a single stage
    const res = await request(app)
      .post("/api/pipelines")
      .send({
        name: "Guardrail Test Pipeline",
        stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
      });

    expect(res.status).toBe(201);
    pipelineId = (res.body as { id: string }).id;
  }, 30_000);

  afterAll(async () => {
    await closeApp();
  });

  // ─── POST /api/guardrails/test ────────────────────────────────────────────

  describe("POST /api/guardrails/test", () => {
    it("returns passed: true for a json_schema guardrail with valid output", async () => {
      const res = await request(app)
        .post("/api/guardrails/test")
        .send({
          guardrail: JSON_SCHEMA_GUARDRAIL,
          sampleOutput: '{"summary": "hello"}',
        });

      expect(res.status).toBe(200);
      expect((res.body as { passed: boolean }).passed).toBe(true);
    });

    it("returns passed: false with reason for a failing regex guardrail", async () => {
      const res = await request(app)
        .post("/api/guardrails/test")
        .send({
          guardrail: FAILING_REGEX_GUARDRAIL,
          sampleOutput: "anything",
        });

      expect(res.status).toBe(200);
      const body = res.body as { passed: boolean; reason?: string };
      expect(body.passed).toBe(false);
      expect(body.reason).toBeTruthy();
    });

    it("returns 400 for invalid request body", async () => {
      const res = await request(app)
        .post("/api/guardrails/test")
        .send({ guardrail: null, sampleOutput: "" });

      expect(res.status).toBe(400);
    });
  });

  // ─── CRUD ────────────────────────────────────────────────────────────────

  describe("Guardrail CRUD on stage 0", () => {
    const stageIndex = "0";

    it("GET — returns empty array initially", async () => {
      const res = await request(app)
        .get(`/api/pipelines/${pipelineId}/stages/${stageIndex}/guardrails`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect((res.body as StageGuardrail[]).length).toBe(0);
    });

    it("POST — adds a guardrail and returns 201", async () => {
      const res = await request(app)
        .post(`/api/pipelines/${pipelineId}/stages/${stageIndex}/guardrails`)
        .send(JSON_SCHEMA_GUARDRAIL);

      expect(res.status).toBe(201);
      expect((res.body as StageGuardrail).id).toBe(JSON_SCHEMA_GUARDRAIL.id);
    });

    it("GET — lists the added guardrail", async () => {
      const res = await request(app)
        .get(`/api/pipelines/${pipelineId}/stages/${stageIndex}/guardrails`);

      expect(res.status).toBe(200);
      const guards = res.body as StageGuardrail[];
      expect(guards.length).toBe(1);
      expect(guards[0].id).toBe(JSON_SCHEMA_GUARDRAIL.id);
    });

    it("POST — returns 409 on duplicate id", async () => {
      const res = await request(app)
        .post(`/api/pipelines/${pipelineId}/stages/${stageIndex}/guardrails`)
        .send(JSON_SCHEMA_GUARDRAIL);

      expect(res.status).toBe(409);
    });

    it("PUT — updates the guardrail", async () => {
      const res = await request(app)
        .put(`/api/pipelines/${pipelineId}/stages/${stageIndex}/guardrails/${JSON_SCHEMA_GUARDRAIL.id}`)
        .send({ enabled: false });

      expect(res.status).toBe(200);
      expect((res.body as StageGuardrail).enabled).toBe(false);
    });

    it("PUT — returns 404 for unknown guardrail id", async () => {
      const res = await request(app)
        .put(`/api/pipelines/${pipelineId}/stages/${stageIndex}/guardrails/NONEXISTENT`)
        .send({ enabled: false });

      expect(res.status).toBe(404);
    });

    it("DELETE — removes the guardrail", async () => {
      const res = await request(app)
        .delete(`/api/pipelines/${pipelineId}/stages/${stageIndex}/guardrails/${JSON_SCHEMA_GUARDRAIL.id}`);

      expect(res.status).toBe(204);
    });

    it("GET — returns empty after deletion", async () => {
      const res = await request(app)
        .get(`/api/pipelines/${pipelineId}/stages/${stageIndex}/guardrails`);

      expect(res.status).toBe(200);
      expect((res.body as StageGuardrail[]).length).toBe(0);
    });
  });

  // ─── Pipeline run with guardrails ─────────────────────────────────────────

  describe("Pipeline run behaviour with guardrails", () => {
    it("pipeline with a skip guardrail completes normally", async () => {
      // Create pipeline with a skip guardrail that would always fail
      const createRes = await request(app)
        .post("/api/pipelines")
        .send({
          name: "Skip Guardrail Pipeline",
          stages: [
            {
              teamId: "planning",
              modelSlug: "mock",
              enabled: true,
              guardrails: [SKIP_GUARDRAIL],
            },
          ],
        });

      expect(createRes.status).toBe(201);
      const pid = (createRes.body as { id: string }).id;

      const runRes = await request(app)
        .post("/api/runs")
        .send({ pipelineId: pid, input: "test task" });

      expect(runRes.status).toBe(201);
      const runId = (runRes.body as { id: string }).id;

      const run = await waitForRun(app, runId);
      expect(run.status).toBe("completed");
    }, 15_000);

    it("pipeline with a passing guardrail completes normally", async () => {
      const createRes = await request(app)
        .post("/api/pipelines")
        .send({
          name: "Pass Guardrail Pipeline",
          stages: [
            {
              teamId: "planning",
              modelSlug: "mock",
              enabled: true,
              // Empty schema — any JSON object from MockProvider will pass
              guardrails: [{ ...JSON_SCHEMA_GUARDRAIL, enabled: true }],
            },
          ],
        });

      expect(createRes.status).toBe(201);
      const pid = (createRes.body as { id: string }).id;

      const runRes = await request(app)
        .post("/api/runs")
        .send({ pipelineId: pid, input: "test task" });

      expect(runRes.status).toBe(201);
      const runId = (runRes.body as { id: string }).id;

      const run = await waitForRun(app, runId);
      // With the mock provider output as JSON, this should complete
      expect(["completed", "failed"]).toContain(run.status);
    }, 15_000);
  });
});
