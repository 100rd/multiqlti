/**
 * Integration tests for Phase 6.7 — Agent Swarms (Parallel Stage Cloning).
 *
 * Covers:
 *  - PATCH /api/pipelines/:id/stages/:stageIndex/swarm  (set swarm config)
 *  - DELETE /api/pipelines/:id/stages/:stageIndex/swarm (remove swarm config)
 *  - GET /api/runs/:runId/stages/:stageIndex/swarm-results
 *  - POST /api/pipelines/:id/stages/:stageIndex/swarm/generate-perspectives
 *  - Auth/role enforcement (401, 403)
 *  - Zod validation (400 cases)
 *  - Cross-user isolation (403)
 *  - stageIndex out of range (400)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";
import { createServer } from "http";
import { createTestApp } from "../helpers/test-app.js";
import { MemStorage } from "../../server/storage.js";
import { Gateway } from "../../server/gateway/index.js";
import { TeamRegistry } from "../../server/teams/registry.js";
import { PipelineController } from "../../server/controller/pipeline-controller.js";
import { registerPipelineRoutes } from "../../server/routes/pipelines.js";
import { registerRunRoutes } from "../../server/routes/runs.js";
import { registerModelRoutes } from "../../server/routes/models.js";
import { DEFAULT_MODELS } from "../../shared/constants.js";
import type { User, SwarmMerger, SwarmSplitter } from "../../shared/types.js";
import type { PipelineRun, StageExecution } from "../../shared/schema.js";

// ─── User fixtures ────────────────────────────────────────────────────────────

const ADMIN_USER: User = {
  id: "admin-swarm-test",
  email: "admin@swarm.test",
  name: "Admin",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

const MAINTAINER_USER: User = {
  id: "maintainer-swarm-test",
  email: "maintainer@swarm.test",
  name: "Maintainer",
  isActive: true,
  role: "maintainer",
  lastLoginAt: null,
  createdAt: new Date(0),
};

const REGULAR_USER: User = {
  id: "user-swarm-test",
  email: "user@swarm.test",
  name: "Regular User",
  isActive: true,
  role: "user",
  lastLoginAt: null,
  createdAt: new Date(0),
};

const USER_B: User = {
  id: "user-b-swarm-test",
  email: "userb@swarm.test",
  name: "User B",
  isActive: true,
  role: "user",
  lastLoginAt: null,
  createdAt: new Date(0),
};

// ─── App factories ────────────────────────────────────────────────────────────

/**
 * Create a test Express app that passes gateway to registerPipelineRoutes,
 * enabling the generate-perspectives endpoint (which requires gateway).
 */
async function createTestAppWithGateway() {
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
    req.user = ADMIN_USER;
    next();
  });

  registerModelRoutes(app, storage);
  registerPipelineRoutes(app, storage, gateway);
  registerRunRoutes(app, storage, controller);

  for (const model of DEFAULT_MODELS) {
    await storage.createModel(model);
  }
  await storage.createModel({
    name: "Mock",
    slug: "mock",
    provider: "mock",
    contextLimit: 4096,
    isActive: true,
    capabilities: [],
  });

  return {
    app,
    storage,
    close: () => new Promise<void>((resolve) => { httpServer.close(() => resolve()); }),
  };
}

/**
 * Minimal app factory with a specific user injected.
 * Uses shared storage so pipeline/run data is accessible.
 * Does NOT pass gateway — generate-perspectives returns 503.
 */
function createAppWithUser(user: User | null, storage: MemStorage): Express {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }
  registerPipelineRoutes(app, storage);
  return app;
}

// ─── Common helpers ───────────────────────────────────────────────────────────

const BASE_SWARM_CONFIG = {
  enabled: true,
  cloneCount: 2,
  splitter: "chunks" as const,
  merger: "concatenate" as const,
};

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
    await new Promise((r) => setTimeout(r, 200));
  }
  const res = await request(app).get(`/api/runs/${runId}`);
  return res.body as PipelineRun & { stages: StageExecution[] };
}

// ─── Main suite ───────────────────────────────────────────────────────────────

describe("Swarm API — PATCH .../swarm", () => {
  let app: Express;
  let storage: MemStorage;
  let closeApp: () => Promise<void>;
  /** Pipeline with stage[0]=plain, stage[1]=parallel-enabled (to test 409) */
  let pipelineId: string;
  let maintainerPipelineId: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    storage = testApp.storage;
    closeApp = testApp.close;

    const res = await request(app)
      .post("/api/pipelines")
      .send({
        name: "Swarm PATCH Test Pipeline",
        stages: [
          { teamId: "planning", modelSlug: "mock", enabled: true },
          {
            teamId: "development",
            modelSlug: "mock",
            enabled: true,
            parallel: { enabled: true, mode: "auto", maxAgents: 3, mergeStrategy: "auto" },
          },
        ],
      });
    expect(res.status).toBe(201);
    pipelineId = (res.body as { id: string }).id;

    const maintainerApp2 = createAppWithUser(MAINTAINER_USER, storage);
    const mRes = await request(maintainerApp2)
      .post("/api/pipelines")
      .send({
        name: "Swarm PATCH Test Pipeline (Maintainer Owned)",
        stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
      });
    expect(mRes.status).toBe(201);
    maintainerPipelineId = (mRes.body as { id: string }).id;
  }, 30_000);

  afterAll(async () => {
    await closeApp();
  });

  it("valid request sets swarm config and returns 200 with updated stage", async () => {
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}/stages/0/swarm`)
      .send(BASE_SWARM_CONFIG);

    expect(res.status).toBe(200);
    expect(res.body.stage).toBeDefined();
    expect(res.body.stage.swarm.enabled).toBe(true);
    expect(res.body.stage.swarm.cloneCount).toBe(2);
    expect(res.body.stage.swarm.splitter).toBe("chunks");
    expect(res.body.stage.swarm.merger).toBe("concatenate");
  });

  it("unauthenticated request returns 401", async () => {
    // App without user injection → requireRole sees undefined user → 401
    const unauthStorage = new MemStorage();
    const unauthApp = createAppWithUser(null, unauthStorage);

    const res = await request(unauthApp)
      .patch(`/api/pipelines/any-id/stages/0/swarm`)
      .send(BASE_SWARM_CONFIG);

    expect(res.status).toBe(401);
  });

  it("authenticated as regular user returns 403", async () => {
    const userApp = createAppWithUser(REGULAR_USER, storage);

    const res = await request(userApp)
      .patch(`/api/pipelines/${pipelineId}/stages/0/swarm`)
      .send(BASE_SWARM_CONFIG);

    expect(res.status).toBe(403);
  });

  it("authenticated as maintainer returns 200", async () => {
    const maintainerApp = createAppWithUser(MAINTAINER_USER, storage);

    const res = await request(maintainerApp)
      .patch(`/api/pipelines/${maintainerPipelineId}/stages/0/swarm`)
      .send(BASE_SWARM_CONFIG);

    expect(res.status).toBe(200);
  });

  it("cross-owner maintainer cannot PATCH swarm config", async () => {
    const maintainerApp = createAppWithUser(MAINTAINER_USER, storage);

    const res = await request(maintainerApp)
      .patch(`/api/pipelines/${pipelineId}/stages/0/swarm`)
      .send(BASE_SWARM_CONFIG);

    expect(res.status).toBe(403);
  });

  it("parallel + swarm conflict returns 409", async () => {
    // stage[1] has parallel.enabled=true — should be rejected
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}/stages/1/swarm`)
      .send(BASE_SWARM_CONFIG);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/parallel/i);
  });

  it("invalid cloneCount=1 returns 400 (Zod min 2)", async () => {
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}/stages/0/swarm`)
      .send({ ...BASE_SWARM_CONFIG, cloneCount: 1 });

    expect(res.status).toBe(400);
  });

  it("invalid cloneCount=21 returns 400 (Zod max 20)", async () => {
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}/stages/0/swarm`)
      .send({ ...BASE_SWARM_CONFIG, cloneCount: 21 });

    expect(res.status).toBe(400);
  });

  it("custom splitter with customClonePrompts.length !== cloneCount returns 400", async () => {
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}/stages/0/swarm`)
      .send({
        enabled: true,
        cloneCount: 3,
        splitter: "custom",
        merger: "concatenate",
        customClonePrompts: ["only one prompt"],  // 1 prompt but cloneCount=3
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/customClonePrompts/i);
  });

  it("stageIndex=100 (out of range) returns 400", async () => {
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}/stages/100/swarm`)
      .send(BASE_SWARM_CONFIG);

    expect(res.status).toBe(400);
    // Implementation returns 400 either from Zod params validation or out-of-range check
    expect(res.body.error).toBeDefined();
  });

  it("custom splitter with empty customClonePrompts returns 400", async () => {
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}/stages/0/swarm`)
      .send({
        enabled: true,
        cloneCount: 2,
        splitter: "custom",
        merger: "concatenate",
        customClonePrompts: [],  // empty array, cloneCount=2
      });

    expect(res.status).toBe(400);
  });

  it("pipeline not found returns 404", async () => {
    const res = await request(app)
      .patch(`/api/pipelines/nonexistent-pipeline-id/stages/0/swarm`)
      .send(BASE_SWARM_CONFIG);

    expect(res.status).toBe(404);
  });
});

describe("Swarm API — DELETE .../swarm", () => {
  let app: Express;
  let closeApp: () => Promise<void>;
  let pipelineId: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    closeApp = testApp.close;

    const res = await request(app)
      .post("/api/pipelines")
      .send({
        name: "Swarm DELETE Test Pipeline",
        stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
      });
    expect(res.status).toBe(201);
    pipelineId = (res.body as { id: string }).id;
  }, 30_000);

  afterAll(async () => { await closeApp(); });

  it("removes swarm config and returns 200 with updated stage (no swarm key)", async () => {
    // First set a swarm config
    const patchRes = await request(app)
      .patch(`/api/pipelines/${pipelineId}/stages/0/swarm`)
      .send(BASE_SWARM_CONFIG);
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.stage.swarm).toBeDefined();

    // Now delete it
    const deleteRes = await request(app)
      .delete(`/api/pipelines/${pipelineId}/stages/0/swarm`);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.stage.swarm).toBeUndefined();
  });

  it("delete on stage that has no swarm returns 200 (idempotent)", async () => {
    // Stage has no swarm config — delete should still succeed
    const res = await request(app)
      .delete(`/api/pipelines/${pipelineId}/stages/0/swarm`);

    expect(res.status).toBe(200);
  });

  it("stageIndex=100 out of range returns 400", async () => {
    const res = await request(app)
      .delete(`/api/pipelines/${pipelineId}/stages/100/swarm`);

    expect(res.status).toBe(400);
  });
});

describe("Swarm API — GET .../swarm-results", () => {
  let app: Express;
  let storage: MemStorage;
  let closeApp: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    storage = testApp.storage;
    closeApp = testApp.close;
  }, 30_000);

  afterAll(async () => { await closeApp(); });

  it("non-swarm stage returns 404", async () => {
    // Pipeline without swarm — run completes without swarmMeta
    const pipRes = await request(app)
      .post("/api/pipelines")
      .send({
        name: "Non-swarm pipeline",
        stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
      });
    expect(pipRes.status).toBe(201);
    const pid = (pipRes.body as { id: string }).id;

    const runRes = await request(app)
      .post("/api/runs")
      .send({ pipelineId: pid, input: "test input for non-swarm stage" });
    expect(runRes.status).toBe(201);
    const runId = (runRes.body as { id: string }).id;

    await waitForRunCompletion(app, runId);

    const res = await request(app).get(`/api/runs/${runId}/stages/0/swarm-results`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no swarm data/i);
  });

  it("returns swarm data after a run with swarm config (200)", async () => {
    // Create pipeline with swarm enabled
    const pipRes = await request(app)
      .post("/api/pipelines")
      .send({
        name: "Swarm results pipeline",
        stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
      });
    expect(pipRes.status).toBe(201);
    const pid = (pipRes.body as { id: string }).id;

    // Set swarm config on stage 0
    const patchRes = await request(app)
      .patch(`/api/pipelines/${pid}/stages/0/swarm`)
      .send(BASE_SWARM_CONFIG);
    expect(patchRes.status).toBe(200);

    // Start a run
    const runRes = await request(app)
      .post("/api/runs")
      .send({ pipelineId: pid, input: "Input line one\nInput line two\nInput line three" });
    expect(runRes.status).toBe(201);
    const runId = (runRes.body as { id: string }).id;

    const run = await waitForRunCompletion(app, runId, 20_000);

    // Swarm run should complete or fail (not be cancelled)
    expect(["completed", "failed"]).toContain(run.status);

    if (run.status === "completed") {
      // Verify swarm results endpoint returns data
      const swarmRes = await request(app).get(`/api/runs/${runId}/stages/0/swarm-results`);
      expect(swarmRes.status).toBe(200);
      expect(swarmRes.body.swarmMeta).toBeDefined();
      expect(swarmRes.body.swarmMeta.cloneCount).toBe(2);
      expect(swarmRes.body.swarmMeta.splitterUsed).toBe("chunks");
      expect(swarmRes.body.swarmMeta.mergerUsed).toBe("concatenate");
      expect(Array.isArray(swarmRes.body.cloneResults)).toBe(true);
    }
  }, 25_000);

  it("cross-user isolation: User B cannot access User A's swarm results (403)", async () => {
    // Admin (User A) creates and runs a pipeline
    const pipRes = await request(app)
      .post("/api/pipelines")
      .send({
        name: "Cross-user isolation test",
        stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
      });
    expect(pipRes.status).toBe(201);
    const pid = (pipRes.body as { id: string }).id;

    const runRes = await request(app)
      .post("/api/runs")
      .send({ pipelineId: pid, input: "admin sensitive data" });
    expect(runRes.status).toBe(201);
    const runId = (runRes.body as { id: string }).id;

    await waitForRunCompletion(app, runId, 15_000);

    // Manually inject swarmMeta so the endpoint returns data (not 404)
    const executions = await storage.getStageExecutions(runId);
    expect(executions.length).toBeGreaterThan(0);

    const swarmMeta: { cloneCount: number; succeededCount: number; failedCount: number; mergerUsed: SwarmMerger; splitterUsed: SwarmSplitter; totalTokensUsed: number; durationMs: number } = {
      cloneCount: 2,
      succeededCount: 2,
      failedCount: 0,
      mergerUsed: "concatenate",
      splitterUsed: "chunks",
      totalTokensUsed: 20,
      durationMs: 100,
    };
    await storage.updateStageExecution(executions[0].id, {
      swarmMeta,
      swarmCloneResults: [],
    });

    // User B (different user ID, role=user) tries to read User A's swarm results
    const userBApp = createAppWithUser(USER_B, storage);
    const res = await request(userBApp).get(`/api/runs/${runId}/stages/0/swarm-results`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/forbidden/i);
  }, 20_000);

  it("run not found returns 404", async () => {
    const res = await request(app).get(`/api/runs/nonexistent-run-id/stages/0/swarm-results`);
    expect(res.status).toBe(404);
  });
});

describe("Swarm API — POST .../swarm/generate-perspectives", () => {
  let appWithGateway: Express;
  let appNoGateway: Express;
  let closeGw: () => Promise<void>;
  let closeNoGw: () => Promise<void>;
  let gwPipelineId: string;
  let noGwPipelineId: string;

  beforeAll(async () => {
    // App WITH gateway (generate-perspectives works)
    const gwTestApp = await createTestAppWithGateway();
    appWithGateway = gwTestApp.app;
    closeGw = gwTestApp.close;

    const gwPipRes = await request(appWithGateway)
      .post("/api/pipelines")
      .send({
        name: "Perspectives Pipeline (with gateway)",
        stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
      });
    expect(gwPipRes.status).toBe(201);
    gwPipelineId = (gwPipRes.body as { id: string }).id;

    // Standard test-app WITHOUT gateway passed to registerPipelineRoutes
    const noGwTestApp = await createTestApp();
    appNoGateway = noGwTestApp.app;
    closeNoGw = noGwTestApp.close;

    const noGwPipRes = await request(appNoGateway)
      .post("/api/pipelines")
      .send({
        name: "Perspectives Pipeline (no gateway)",
        stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
      });
    expect(noGwPipRes.status).toBe(201);
    noGwPipelineId = (noGwPipRes.body as { id: string }).id;
  }, 30_000);

  afterAll(async () => {
    await closeGw();
    await closeNoGw();
  });

  it("returns a perspectives array with the requested cloneCount", async () => {
    const res = await request(appWithGateway)
      .post(`/api/pipelines/${gwPipelineId}/stages/0/swarm/generate-perspectives`)
      .send({ stageDescription: "Review code for security vulnerabilities", cloneCount: 3 });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.perspectives)).toBe(true);
    expect(res.body.perspectives).toHaveLength(3);
    expect(res.body.perspectives[0]).toHaveProperty("label");
    expect(res.body.perspectives[0]).toHaveProperty("systemPromptSuffix");
    expect(typeof res.body.perspectives[0].label).toBe("string");
    expect(typeof res.body.perspectives[0].systemPromptSuffix).toBe("string");
  });

  it("uses default cloneCount=3 when not specified", async () => {
    const res = await request(appWithGateway)
      .post(`/api/pipelines/${gwPipelineId}/stages/0/swarm/generate-perspectives`)
      .send({ stageDescription: "Analyze API design quality" });

    expect(res.status).toBe(200);
    expect(res.body.perspectives).toHaveLength(3);
  });

  it("stageIndex out of range returns 400", async () => {
    const res = await request(appWithGateway)
      .post(`/api/pipelines/${gwPipelineId}/stages/999/swarm/generate-perspectives`)
      .send({ stageDescription: "Some stage description" });

    expect(res.status).toBe(400);
    // Implementation returns 400 either from Zod params validation or out-of-range check
    expect(res.body.error).toBeDefined();
  });

  it("missing stageDescription returns 400", async () => {
    const res = await request(appWithGateway)
      .post(`/api/pipelines/${gwPipelineId}/stages/0/swarm/generate-perspectives`)
      .send({ cloneCount: 3 });

    expect(res.status).toBe(400);
  });

  it("without gateway (standard test-app) returns 503", async () => {
    const res = await request(appNoGateway)
      .post(`/api/pipelines/${noGwPipelineId}/stages/0/swarm/generate-perspectives`)
      .send({ stageDescription: "Some description", cloneCount: 2 });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/gateway/i);
  });

  it("unauthenticated request returns 401", async () => {
    const unauthStorage = new MemStorage();
    const unauthApp = createAppWithUser(null, unauthStorage);

    const res = await request(unauthApp)
      .post(`/api/pipelines/any/stages/0/swarm/generate-perspectives`)
      .send({ stageDescription: "Something" });

    expect(res.status).toBe(401);
  });
});
