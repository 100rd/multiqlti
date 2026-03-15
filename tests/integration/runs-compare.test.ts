/**
 * Integration tests — Run Comparison API (Phase 5)
 *
 * GET /api/runs/compare?runIds=id1,id2
 *
 * Happy path: returns both runs with stage executions.
 * Cross-pipeline: 400 when runs belong to different pipelines.
 * Missing run: 404 when either run does not exist.
 * Cross-user: 403 when a non-admin requests another user's run.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { TestApp } from "../helpers/test-app.js";
import { createTestApp } from "../helpers/test-app.js";
import request from "supertest";
import type { User } from "../../shared/types.js";
import express from "express";
import { MemStorage } from "../../server/storage.js";
import { Gateway } from "../../server/gateway/index.js";
import { createServer } from "http";
import { TeamRegistry } from "../../server/teams/registry.js";
import { PipelineController } from "../../server/controller/pipeline-controller.js";
import { registerRunRoutes } from "../../server/routes/runs.js";
import { DEFAULT_PIPELINE_STAGES } from "../../shared/constants.js";

let testApp: TestApp;

async function createTwoRunApp(userId: string) {
  const storage = new MemStorage();
  const gateway = new Gateway(storage);
  const httpServer = createServer();
  const { WsManager } = await import("../../server/ws/manager.js");
  const wsManager = new WsManager(httpServer);
  const teamRegistry = new TeamRegistry(gateway, wsManager);
  const controller = new PipelineController(storage, teamRegistry, wsManager, gateway);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: userId,
      email: "user@example.com",
      name: "User",
      isActive: true,
      role: "user",
      lastLoginAt: null,
      createdAt: new Date(),
    } as User;
    next();
  });

  registerRunRoutes(app, storage, controller);

  // Seed a pipeline
  const pipeline = await storage.createPipeline({
    name: "Test Pipeline",
    description: "",
    stages: DEFAULT_PIPELINE_STAGES,
    isTemplate: false,
  });

  // Create two runs owned by this user
  const run1 = await storage.createPipelineRun({
    pipelineId: pipeline.id,
    input: "Task one",
    status: "completed",
    currentStageIndex: 0,
    triggeredBy: userId,
  });
  const run2 = await storage.createPipelineRun({
    pipelineId: pipeline.id,
    input: "Task two",
    status: "completed",
    currentStageIndex: 0,
    triggeredBy: userId,
  });

  return { app, storage, pipeline, run1, run2 };
}

describe("GET /api/runs/compare", () => {
  it("returns both runs with their stages on happy path", async () => {
    const { app, run1, run2 } = await createTwoRunApp("user-1");
    const res = await request(app)
      .get(`/api/runs/compare?runIds=${run1.id},${run2.id}`);
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(2);
    expect(res.body.runs[0].id).toBe(run1.id);
    expect(res.body.runs[1].id).toBe(run2.id);
    expect(Array.isArray(res.body.runs[0].stages)).toBe(true);
    expect(Array.isArray(res.body.runs[1].stages)).toBe(true);
  });

  it("returns 400 when runIds param is missing", async () => {
    const { app } = await createTwoRunApp("user-1");
    const res = await request(app).get("/api/runs/compare");
    expect(res.status).toBe(400);
  });

  it("returns 400 when only one run ID is provided", async () => {
    const { app, run1 } = await createTwoRunApp("user-1");
    const res = await request(app).get(`/api/runs/compare?runIds=${run1.id}`);
    expect(res.status).toBe(400);
  });

  it("returns 400 when runs belong to different pipelines", async () => {
    const storage = new MemStorage();
    const gateway = new Gateway(storage);
    const httpServer = createServer();
    const { WsManager } = await import("../../server/ws/manager.js");
    const wsManager = new WsManager(httpServer);
    const teamRegistry = new TeamRegistry(gateway, wsManager);
    const controller = new PipelineController(storage, teamRegistry, wsManager, gateway);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: "user-1", email: "u@u.com", name: "U", isActive: true, role: "user", lastLoginAt: null, createdAt: new Date() } as User;
      next();
    });
    registerRunRoutes(app, storage, controller);

    const p1 = await storage.createPipeline({ name: "P1", description: "", stages: DEFAULT_PIPELINE_STAGES, isTemplate: false });
    const p2 = await storage.createPipeline({ name: "P2", description: "", stages: DEFAULT_PIPELINE_STAGES, isTemplate: false });
    const r1 = await storage.createPipelineRun({ pipelineId: p1.id, input: "a", status: "completed", currentStageIndex: 0, triggeredBy: "user-1" });
    const r2 = await storage.createPipelineRun({ pipelineId: p2.id, input: "b", status: "completed", currentStageIndex: 0, triggeredBy: "user-1" });

    const res = await request(app).get(`/api/runs/compare?runIds=${r1.id},${r2.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/same pipeline/i);
  });

  it("returns 404 when a run does not exist", async () => {
    const { app, run1 } = await createTwoRunApp("user-1");
    const res = await request(app).get(`/api/runs/compare?runIds=${run1.id},nonexistent-uuid`);
    expect(res.status).toBe(404);
  });

  it("returns 403 when a non-admin requests another user's run", async () => {
    // Build app as user-2 but runs are owned by user-1
    const storage = new MemStorage();
    const gateway = new Gateway(storage);
    const httpServer = createServer();
    const { WsManager } = await import("../../server/ws/manager.js");
    const wsManager = new WsManager(httpServer);
    const teamRegistry = new TeamRegistry(gateway, wsManager);
    const controller = new PipelineController(storage, teamRegistry, wsManager, gateway);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: "user-2", email: "u2@u.com", name: "U2", isActive: true, role: "user", lastLoginAt: null, createdAt: new Date() } as User;
      next();
    });
    registerRunRoutes(app, storage, controller);

    const pipeline = await storage.createPipeline({ name: "P", description: "", stages: DEFAULT_PIPELINE_STAGES, isTemplate: false });
    const r1 = await storage.createPipelineRun({ pipelineId: pipeline.id, input: "a", status: "completed", currentStageIndex: 0, triggeredBy: "user-1" });
    const r2 = await storage.createPipelineRun({ pipelineId: pipeline.id, input: "b", status: "completed", currentStageIndex: 0, triggeredBy: "user-1" });

    const res = await request(app).get(`/api/runs/compare?runIds=${r1.id},${r2.id}`);
    expect(res.status).toBe(403);
  });
});
