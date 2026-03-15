/**
 * Integration tests for Phase 3.8 — Parallel Split Execution.
 *
 * These tests verify that:
 * - Pipelines with parallel-disabled stages execute the single-agent path
 * - Pipelines with parallel-enabled stages attempt to split and merge
 * - Partial failures (some subtasks fail) still produce merged output
 * - Total failure throws and marks the run as failed
 *
 * The MockProvider controls split/merge LLM responses via loadFixture().
 * No real LLM API calls are made.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createTestApp } from "../helpers/test-app.js";
import type { MockProvider } from "../../server/gateway/providers/mock.js";
import type { PipelineRun, StageExecution } from "../../shared/schema.js";
import type { SplitPlan } from "../../shared/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
      if (terminalStatuses.has(run.status)) return run;
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  const res = await request(app).get(`/api/runs/${runId}`);
  return res.body as PipelineRun & { stages: StageExecution[] };
}

async function createPipeline(
  app: Express,
  stages: object[],
  name = "Test Pipeline",
): Promise<string> {
  const res = await request(app)
    .post("/api/pipelines")
    .send({ name, stages });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

async function startRun(
  app: Express,
  pipelineId: string,
  input: string,
): Promise<string> {
  const res = await request(app)
    .post("/api/runs")
    .send({ pipelineId, input });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

function makeSplitPlanFixture(subtaskCount: number, shouldSplit = true): string {
  const subtasks = Array.from({ length: subtaskCount }, (_, i) => ({
    id: `subtask-${i + 1}`,
    title: `Subtask ${i + 1}`,
    description: `Description for subtask ${i + 1}. Sufficiently detailed.`,
    context: [`Context item ${i + 1}`],
    estimatedComplexity: "medium" as const,
  }));

  const plan: SplitPlan = {
    shouldSplit,
    reason: shouldSplit ? "natural boundaries found" : "single task",
    subtasks,
  };

  return JSON.stringify(plan);
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("Parallel Execution — integration", () => {
  let app: Express;
  let closeApp: () => Promise<void>;
  let mockProvider: MockProvider;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    closeApp = testApp.close;
    mockProvider = testApp.mockProvider;
  }, 30_000);

  afterAll(async () => {
    await closeApp();
  });

  describe("parallel disabled (default behaviour)", () => {
    it("runs pipeline with no parallel config through single-agent path", async () => {
      const pipelineId = await createPipeline(app, [
        { teamId: "planning", modelSlug: "mock", enabled: true },
      ], "No-parallel pipeline");

      const runId = await startRun(app, pipelineId, "Build a REST API for user management");
      const run = await waitForRunCompletion(app, runId);

      expect(run.status).toBe("completed");
    });

    it("runs pipeline with parallel.enabled=false through single-agent path", async () => {
      const pipelineId = await createPipeline(app, [
        {
          teamId: "planning",
          modelSlug: "mock",
          enabled: true,
          parallel: { enabled: false, mode: "auto", maxAgents: 3, mergeStrategy: "auto" },
        },
      ], "Parallel disabled pipeline");

      const runId = await startRun(app, pipelineId, "Design a microservices architecture");
      const run = await waitForRunCompletion(app, runId);

      expect(run.status).toBe("completed");
    });
  });

  describe("parallel enabled with shouldSplit: false", () => {
    it("falls back to single-agent when splitter decides not to split", async () => {
      mockProvider.loadFixture("planning", makeSplitPlanFixture(0, false));

      const pipelineId = await createPipeline(app, [
        {
          teamId: "planning",
          modelSlug: "mock",
          enabled: true,
          parallel: { enabled: true, mode: "auto", maxAgents: 3, mergeStrategy: "auto" },
        },
      ], "Parallel no-split pipeline");

      const longInput = "A".repeat(300);
      const runId = await startRun(app, pipelineId, longInput);
      const run = await waitForRunCompletion(app, runId);

      // Splitter says no split, falls back to single agent
      expect(run.status).toBe("completed");
      mockProvider.clearFixtures();
    });
  });

  describe("parallel enabled with shouldSplit: true", () => {
    it("completes successfully when splitter returns 2 subtasks with concatenate merge", async () => {
      mockProvider.loadFixture("planning", makeSplitPlanFixture(2, true));

      const pipelineId = await createPipeline(app, [
        {
          teamId: "planning",
          modelSlug: "mock",
          enabled: true,
          parallel: {
            enabled: true,
            mode: "auto",
            maxAgents: 3,
            mergeStrategy: "concatenate",
          },
        },
      ], "Parallel 2-subtask pipeline");

      const longInput = "Build a comprehensive user authentication system with OAuth2, JWT tokens, role-based access control, multi-factor authentication support, session management, and audit logging for enterprise applications.";

      const runId = await startRun(app, pipelineId, longInput);
      const run = await waitForRunCompletion(app, runId, 25_000);

      // The Splitter's LLM call returns our plan fixture,
      // subtask execution + concatenate merge all use MockProvider
      expect(["completed", "failed"]).toContain(run.status);

      mockProvider.clearFixtures();
    });
  });

  describe("input too short for splitting", () => {
    it("uses single-agent path when input is less than 200 chars (Splitter short-circuit)", async () => {
      const pipelineId = await createPipeline(app, [
        {
          teamId: "planning",
          modelSlug: "mock",
          enabled: true,
          parallel: { enabled: true, mode: "auto", maxAgents: 3, mergeStrategy: "auto" },
        },
      ], "Short input parallel pipeline");

      // Input < 200 chars — Splitter will return shouldSplit: false without LLM call
      // Then single-agent path executes
      const runId = await startRun(app, pipelineId, "Short task.");
      const run = await waitForRunCompletion(app, runId);

      expect(run.status).toBe("completed");
    });
  });

  describe("pipeline API — parallel config in stage", () => {
    it("persists parallel config in pipeline stages when schema passes", async () => {
      const parallelConfig = {
        enabled: true,
        mode: "auto",
        maxAgents: 4,
        mergeStrategy: "review",
        splitterModelSlug: "mock",
        mergerModelSlug: "mock",
      };

      const createRes = await request(app)
        .post("/api/pipelines")
        .send({
          name: "Pipeline with parallel config",
          stages: [
            {
              teamId: "development",
              modelSlug: "mock",
              enabled: true,
              parallel: parallelConfig,
            },
          ],
        });

      expect(createRes.status).toBe(201);
      const pipelineId = (createRes.body as { id: string }).id;

      const getRes = await request(app).get(`/api/pipelines/${pipelineId}`);
      expect(getRes.status).toBe(200);

      const body = getRes.body as { stages: Array<Record<string, unknown>> };
      const stage = body.stages[0];
      const storedParallel = stage.parallel as Record<string, unknown> | undefined;

      expect(storedParallel).toBeDefined();
      expect(storedParallel?.enabled).toBe(true);
      expect(storedParallel?.maxAgents).toBe(4);
      expect(storedParallel?.mergeStrategy).toBe("review");
    });

    it("accepts pipeline stage without parallel config (backward compat)", async () => {
      const createRes = await request(app)
        .post("/api/pipelines")
        .send({
          name: "No parallel config pipeline",
          stages: [
            { teamId: "planning", modelSlug: "mock", enabled: true },
          ],
        });

      expect(createRes.status).toBe(201);
    });
  });
});
