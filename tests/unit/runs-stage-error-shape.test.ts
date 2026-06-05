/**
 * API-shape tests for issue #342 — a failed stage's persisted `error` message
 * must be returned by the run endpoints so the UI can surface it after a
 * page reload (the live WebSocket `stage:failed` event is not replayable).
 *
 * Exercises the real route handlers from server/routes/runs.ts against
 * MemStorage, so the assertions reflect the actual JSON shape clients receive.
 */
import { describe, it, expect, beforeEach } from "vitest";
import express, { Router, type Express } from "express";
import request from "supertest";
import { registerRunRoutes } from "../../server/routes/runs.js";
import { MemStorage } from "../../server/storage.js";
import type { PipelineController } from "../../server/controller/pipeline-controller.js";

const FAILURE_MESSAGE =
  "http://host.docker.internal:1234 error 400: Failed to load model: insufficient system resources";

// The read endpoints under test never touch the controller; a typed no-op
// stub keeps the test hermetic (no queue / ioredis import chain).
const stubController = {} as PipelineController;

async function seedFailedRun(storage: MemStorage): Promise<string> {
  const pipeline = await storage.createPipeline({ name: "P", stages: [] });
  const run = await storage.createPipelineRun({
    pipelineId: pipeline.id,
    status: "running",
    input: "i",
    currentStageIndex: 0,
  });
  const stage = await storage.createStageExecution({
    runId: run.id,
    stageIndex: 0,
    teamId: "planning",
    modelSlug: "mock",
    status: "running",
    input: {},
  });
  await storage.updateStageExecution(stage.id, {
    status: "failed",
    completedAt: new Date(),
    error: FAILURE_MESSAGE,
  });
  return run.id;
}

describe("runs API — failed stage error shape (#342)", () => {
  let app: Express;
  let storage: MemStorage;
  let runId: string;

  beforeEach(async () => {
    storage = new MemStorage();
    const router = Router();
    registerRunRoutes(router, storage, stubController);
    app = express();
    app.use(express.json());
    app.use(router);
    runId = await seedFailedRun(storage);
  });

  it("GET /api/runs/:id/stages includes the persisted error", async () => {
    const res = await request(app).get(`/api/runs/${runId}/stages`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe("failed");
    expect(res.body[0].error).toBe(FAILURE_MESSAGE);
  });

  it("GET /api/runs/:id embeds the error on the stages array", async () => {
    const res = await request(app).get(`/api/runs/${runId}`);

    expect(res.status).toBe(200);
    expect(res.body.stages).toHaveLength(1);
    expect(res.body.stages[0].error).toBe(FAILURE_MESSAGE);
  });
});
