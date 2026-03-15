import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createTestApp } from "../helpers/test-app.js";
import type { PipelineRun, StageExecution } from "../../shared/schema.js";

// Wait for a run to reach a terminal state.
async function waitForRunCompletion(
  app: Express,
  runId: string,
  maxWaitMs = 15_000,
): Promise<PipelineRun & { stages: StageExecution[] }> {
  const terminalStatuses = new Set(["completed", "failed", "cancelled", "rejected"]);
  const startAt = Date.now();

  while (Date.now() - startAt < maxWaitMs) {
    const res = await request(app).get(`/api/runs/${runId}`);
    if (res.status === 200) {
      const run = res.body as PipelineRun & { stages: StageExecution[] };
      if (terminalStatuses.has(run.status)) {
        return run;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Return final state even if not terminal (test will fail on assertion)
  const res = await request(app).get(`/api/runs/${runId}`);
  return res.body as PipelineRun & { stages: StageExecution[] };
}

describe("Pipeline Controller — integration", () => {
  let app: Express;
  let closeApp: () => Promise<void>;
  let pipelineId: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    closeApp = testApp.close;

    // Create a minimal single-stage pipeline to keep tests fast
    const res = await request(app)
      .post("/api/pipelines")
      .send({
        name: "Integration Test Pipeline",
        description: "Single stage pipeline for integration tests",
        stages: [
          { teamId: "planning", modelSlug: "mock", enabled: true },
        ],
      });

    expect(res.status).toBe(201);
    pipelineId = (res.body as { id: string }).id;
  }, 30_000);

  afterAll(async () => {
    await closeApp();
  });

  // ─── Pipeline CRUD ────────────────────────────────────────────────────────

  describe("POST /api/pipelines", () => {
    it("creates a pipeline and returns 201 with id", async () => {
      const res = await request(app)
        .post("/api/pipelines")
        .send({ name: "New Pipeline", stages: [] });

      expect(res.status).toBe(201);
      expect((res.body as { id: string }).id).toBeTruthy();
      expect((res.body as { name: string }).name).toBe("New Pipeline");
    });

    it("returns 400 when name is empty", async () => {
      const res = await request(app)
        .post("/api/pipelines")
        .send({ name: "", stages: [] });

      expect(res.status).toBe(400);
    });

    it("returns 400 when name is missing", async () => {
      const res = await request(app)
        .post("/api/pipelines")
        .send({ stages: [] });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/pipelines", () => {
    it("returns an array of pipelines", async () => {
      const res = await request(app).get("/api/pipelines");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("GET /api/pipelines/:id", () => {
    it("returns the pipeline by id", async () => {
      const res = await request(app).get(`/api/pipelines/${pipelineId}`);

      expect(res.status).toBe(200);
      expect((res.body as { id: string }).id).toBe(pipelineId);
    });

    it("returns 404 for unknown id", async () => {
      const res = await request(app).get("/api/pipelines/nonexistent-id");
      expect(res.status).toBe(404);
    });
  });

  // ─── Run lifecycle ────────────────────────────────────────────────────────

  describe("POST /api/runs", () => {
    it("starts a run and returns 201 with run id", async () => {
      const res = await request(app)
        .post("/api/runs")
        .send({ pipelineId, input: "Build a REST API" });

      expect(res.status).toBe(201);
      expect((res.body as { id: string }).id).toBeTruthy();
    });

    it("returns 400 when input is empty", async () => {
      const res = await request(app)
        .post("/api/runs")
        .send({ pipelineId, input: "" });

      expect(res.status).toBe(400);
    });

    it("returns 400 when pipelineId is missing", async () => {
      const res = await request(app)
        .post("/api/runs")
        .send({ input: "test" });

      expect(res.status).toBe(400);
    });

    it("returns 400 when pipeline does not exist", async () => {
      const res = await request(app)
        .post("/api/runs")
        .send({ pipelineId: "nonexistent", input: "test" });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/runs/:id", () => {
    it("returns run with stages", async () => {
      const startRes = await request(app)
        .post("/api/runs")
        .send({ pipelineId, input: "Build an app" });

      expect(startRes.status).toBe(201);
      const runId = (startRes.body as { id: string }).id;

      const getRes = await request(app).get(`/api/runs/${runId}`);
      expect(getRes.status).toBe(200);
      expect((getRes.body as { id: string }).id).toBe(runId);
      expect(Array.isArray((getRes.body as { stages: unknown[] }).stages)).toBe(true);
    });

    it("returns 404 for unknown run id", async () => {
      const res = await request(app).get("/api/runs/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("Run execution — end to end", () => {
    it("completes a run and creates stage executions", async () => {
      const startRes = await request(app)
        .post("/api/runs")
        .send({ pipelineId, input: "Build a simple REST API" });

      expect(startRes.status).toBe(201);
      const runId = (startRes.body as { id: string }).id;

      // Wait for run to complete (mock provider is fast)
      const completedRun = await waitForRunCompletion(app, runId);

      expect(completedRun.status).toBe("completed");
      expect(completedRun.stages).toHaveLength(1);
      expect(completedRun.stages[0].status).toBe("completed");
      expect(completedRun.stages[0].teamId).toBe("planning");
    }, 20_000);

    it("creates stage_executions with planning team output", async () => {
      const startRes = await request(app)
        .post("/api/runs")
        .send({ pipelineId, input: "Create a blog engine" });

      expect(startRes.status).toBe(201);
      const runId = (startRes.body as { id: string }).id;

      const completedRun = await waitForRunCompletion(app, runId);
      expect(completedRun.status).toBe("completed");

      const stagesRes = await request(app).get(`/api/runs/${runId}/stages`);
      expect(stagesRes.status).toBe(200);

      const stages = stagesRes.body as StageExecution[];
      expect(stages).toHaveLength(1);

      const planningStage = stages.find((s) => s.teamId === "planning");
      expect(planningStage).toBeDefined();
      expect(planningStage?.status).toBe("completed");
      expect(planningStage?.output).toBeDefined();
    }, 20_000);
  });
});
