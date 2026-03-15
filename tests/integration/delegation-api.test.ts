/**
 * Integration tests for delegation API endpoints — Phase 6.4
 *
 * Tests: GET /api/runs/:id/delegations
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createTestApp } from "../helpers/test-app.js";
import { registerDelegationRoutes } from "../../server/routes/delegations.js";

interface TestApp {
  app: Express;
  storage: {
    createPipelineRun: (data: Record<string, unknown>) => Promise<{ id: string }>;
    createDelegationRequest: (data: Record<string, unknown>) => Promise<{ id: string }>;
  };
  close: () => Promise<void>;
}

let testApp: TestApp;

beforeAll(async () => {
  const base = await createTestApp();
  // Register delegation routes on the test app
  registerDelegationRoutes(base.app, base.storage as never);
  testApp = {
    app: base.app,
    storage: base.storage as unknown as TestApp["storage"],
    close: base.close,
  };
});

afterAll(async () => {
  await testApp.close();
});

describe("GET /api/runs/:id/delegations", () => {
  it("returns 200 with empty array for run with no delegations", async () => {
    const run = await testApp.storage.createPipelineRun({
      pipelineId: "p-1",
      status: "completed",
      input: "test",
      currentStageIndex: 0,
      startedAt: new Date(),
      triggeredBy: null,
    });

    const res = await request(testApp.app)
      .get(`/api/runs/${run.id}/delegations`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("returns 200 with delegation records for run with delegations", async () => {
    const run = await testApp.storage.createPipelineRun({
      pipelineId: "p-1",
      status: "running",
      input: "test",
      currentStageIndex: 0,
      startedAt: new Date(),
      triggeredBy: null,
    });

    await testApp.storage.createDelegationRequest({
      runId: run.id,
      fromStage: "architecture",
      toStage: "development",
      task: "Generate PoC",
      context: {},
      priority: "blocking",
      timeout: 30000,
      depth: 0,
      status: "completed",
      startedAt: new Date(),
    });

    const res = await request(testApp.app)
      .get(`/api/runs/${run.id}/delegations`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      runId: run.id,
      fromStage: "architecture",
      toStage: "development",
      status: "completed",
    });
  });

  it("returns 200 with empty array for non-existent run ID", async () => {
    const res = await request(testApp.app)
      .get("/api/runs/nonexistent-run-id/delegations")
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("returns delegations sorted by createdAt ASC", async () => {
    const run = await testApp.storage.createPipelineRun({
      pipelineId: "p-1",
      status: "running",
      input: "test",
      currentStageIndex: 0,
      startedAt: new Date(),
      triggeredBy: null,
    });

    // Create two delegations — MemStorage preserves insertion order
    await testApp.storage.createDelegationRequest({
      runId: run.id,
      fromStage: "architecture",
      toStage: "development",
      task: "First task",
      context: {},
      priority: "blocking",
      timeout: 30000,
      depth: 0,
      status: "completed",
      startedAt: new Date(Date.now() - 1000),
    });

    await testApp.storage.createDelegationRequest({
      runId: run.id,
      fromStage: "development",
      toStage: "testing",
      task: "Second task",
      context: {},
      priority: "async",
      timeout: 30000,
      depth: 1,
      status: "running",
      startedAt: new Date(),
    });

    const res = await request(testApp.app)
      .get(`/api/runs/${run.id}/delegations`)
      .expect(200);

    expect(res.body).toHaveLength(2);
    expect(res.body[0].task).toBe("First task");
    expect(res.body[1].task).toBe("Second task");
  });
});
