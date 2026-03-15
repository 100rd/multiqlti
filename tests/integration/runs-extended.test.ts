/**
 * Integration tests for extended runs API endpoints.
 *
 * Covers the 8 endpoints in routes/runs.ts that had no integration test:
 *   GET    /api/runs
 *   GET    /api/runs/:id/variables
 *   DELETE /api/runs/:id/variables
 *   POST   /api/runs/:id/cancel
 *   GET    /api/runs/:id/stages
 *   GET    /api/runs/:id/questions
 *   POST   /api/runs/:id/questions/:qid/answer
 *   POST   /api/runs/:id/questions/:qid/dismiss
 *
 * Auth pattern:
 *   - authenticated app: req.user injected synthetically (no real JWT)
 *   - unauthenticated app: requireAuth middleware applied, no token → 401
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";
import type { User } from "../../shared/types.js";
import type { MemStorage } from "../../server/storage.js";

// ─── Mock configLoader before any server module import ───────────────────────

const TEST_JWT_SECRET = "test-secret-minimum-32-chars-longxx";

vi.mock("../../server/config/loader.js", () => ({
  configLoader: {
    get: () => ({
      auth: { jwtSecret: TEST_JWT_SECRET, bcryptRounds: 4, sessionTtlDays: 1 },
      server: { nodeEnv: "test", port: 3000 },
      database: { url: undefined },
      providers: { anthropic: {}, google: {}, xai: {}, vllm: { endpoint: undefined }, ollama: { endpoint: undefined }, tavily: {} },
      features: {
        sandbox: { enabled: false },
        privacy: { enabled: true },
        maintenance: { enabled: false, cronSchedule: "0 2 * * *" },
      },
      encryption: {},
    }),
  },
}));

// ─── Mock authService for 401 tests ──────────────────────────────────────────

const VALID_TOKEN = "valid-test-bearer-token";

const TEST_ADMIN_USER: User = {
  id: "test-user-id",
  email: "test@example.com",
  name: "Test User",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

vi.mock("../../server/auth/service.js", () => ({
  authService: {
    validateToken: vi.fn(async (token: string) =>
      token === VALID_TOKEN ? TEST_ADMIN_USER : null,
    ),
  },
}));

// ─── App factories ────────────────────────────────────────────────────────────

async function createAuthenticatedApp() {
  const { MemStorage } = await import("../../server/storage.js");
  const { Gateway } = await import("../../server/gateway/index.js");
  const { WsManager } = await import("../../server/ws/manager.js");
  const { TeamRegistry } = await import("../../server/teams/registry.js");
  const { PipelineController } = await import(
    "../../server/controller/pipeline-controller.js"
  );
  const { registerRunRoutes } = await import("../../server/routes/runs.js");
  const { createServer } = await import("http");

  const storage = new MemStorage();
  const httpServer = createServer();
  const gateway = new Gateway(storage);
  const wsManager = new WsManager(httpServer);
  const teamRegistry = new TeamRegistry(gateway, wsManager);
  const controller = new PipelineController(
    storage,
    teamRegistry,
    wsManager,
    gateway,
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = TEST_ADMIN_USER;
    next();
  });
  registerRunRoutes(app, storage, controller);

  return {
    app,
    storage,
    controller,
    close: () =>
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

async function createUnauthenticatedApp() {
  const { MemStorage } = await import("../../server/storage.js");
  const { Gateway } = await import("../../server/gateway/index.js");
  const { WsManager } = await import("../../server/ws/manager.js");
  const { TeamRegistry } = await import("../../server/teams/registry.js");
  const { PipelineController } = await import(
    "../../server/controller/pipeline-controller.js"
  );
  const { registerRunRoutes } = await import("../../server/routes/runs.js");
  const { requireAuth } = await import("../../server/auth/middleware.js");
  const { createServer } = await import("http");

  const storage = new MemStorage();
  const httpServer = createServer();
  const gateway = new Gateway(storage);
  const wsManager = new WsManager(httpServer);
  const teamRegistry = new TeamRegistry(gateway, wsManager);
  const controller = new PipelineController(
    storage,
    teamRegistry,
    wsManager,
    gateway,
  );

  const app = express();
  app.use(express.json());
  app.use("/api/runs", requireAuth);
  registerRunRoutes(app, storage, controller);

  return {
    app,
    close: () =>
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

// ─── GET /api/runs ────────────────────────────────────────────────────────────

describe("GET /api/runs", () => {
  let app: Express;
  let storage: MemStorage;
  let closeApp: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await createAuthenticatedApp();
    app = ctx.app;
    storage = ctx.storage;
    closeApp = ctx.close;
  });

  afterAll(async () => {
    await closeApp();
  });

  it("returns 200 with an array when no runs exist", async () => {
    const res = await request(app).get("/api/runs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("returns runs after they are created", async () => {
    const pipeline = await storage.createPipeline({
      name: "List Runs Pipeline",
      stages: [],
      isTemplate: false,
    });
    await storage.createPipelineRun({
      pipelineId: pipeline.id,
      status: "pending",
      input: "test input",
    });

    const res = await request(app).get("/api/runs");
    expect(res.status).toBe(200);
    expect((res.body as unknown[]).length).toBeGreaterThan(0);
  });

  it("returns 401 when no auth token is provided", async () => {
    const ctx = await createUnauthenticatedApp();
    const res = await request(ctx.app).get("/api/runs");
    expect(res.status).toBe(401);
    await ctx.close();
  });
});

// ─── GET /api/runs/:id/variables ─────────────────────────────────────────────

describe("GET /api/runs/:id/variables", () => {
  let app: Express;
  let closeApp: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await createAuthenticatedApp();
    app = ctx.app;
    closeApp = ctx.close;
  });

  afterAll(async () => {
    await closeApp();
  });

  it("returns 404 when no variables exist for the run", async () => {
    const res = await request(app).get("/api/runs/no-such-run-id/variables");
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBeTruthy();
  });

  it("returns 200 with variable state and masks URL passwords", async () => {
    const { ephemeralVarStore } = await import(
      "../../server/run-variables/store.js"
    );
    const runId = "var-test-run-001";
    ephemeralVarStore.set(runId, {
      DB_URL: "postgres://user:s3cret@host/db",
      PLAIN: "visible",
    });

    const res = await request(app).get(`/api/runs/${runId}/variables`);
    expect(res.status).toBe(200);

    const body = res.body as {
      runId: string;
      variables: Record<string, string>;
    };
    expect(body.runId).toBe(runId);
    expect(body.variables["DB_URL"]).toContain("***");
    expect(body.variables["PLAIN"]).toBe("visible");

    ephemeralVarStore.clearManually(runId);
  });

  it("returns 401 when no auth token is provided", async () => {
    const ctx = await createUnauthenticatedApp();
    const res = await request(ctx.app).get("/api/runs/some-run/variables");
    expect(res.status).toBe(401);
    await ctx.close();
  });
});

// ─── DELETE /api/runs/:id/variables ──────────────────────────────────────────

describe("DELETE /api/runs/:id/variables", () => {
  let app: Express;
  let closeApp: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await createAuthenticatedApp();
    app = ctx.app;
    closeApp = ctx.close;
  });

  afterAll(async () => {
    await closeApp();
  });

  it("returns 404 when no variables exist for the run", async () => {
    const res = await request(app).delete("/api/runs/nonexistent-run/variables");
    expect(res.status).toBe(404);
  });

  it("returns 200 with cleared: true when variables are successfully cleared", async () => {
    const { ephemeralVarStore } = await import(
      "../../server/run-variables/store.js"
    );
    const runId = "delete-var-run-001";
    ephemeralVarStore.set(runId, { SECRET: "abc123" });

    const res = await request(app).delete(`/api/runs/${runId}/variables`);
    expect(res.status).toBe(200);
    expect((res.body as { cleared: boolean }).cleared).toBe(true);
  });

  it("returns 401 when no auth token is provided", async () => {
    const ctx = await createUnauthenticatedApp();
    const res = await request(ctx.app).delete("/api/runs/some-run/variables");
    expect(res.status).toBe(401);
    await ctx.close();
  });
});

// ─── POST /api/runs/:id/cancel ────────────────────────────────────────────────

describe("POST /api/runs/:id/cancel", () => {
  let app: Express;
  let storage: MemStorage;
  let closeApp: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await createAuthenticatedApp();
    app = ctx.app;
    storage = ctx.storage;
    closeApp = ctx.close;
  });

  afterAll(async () => {
    await closeApp();
  });

  it("returns 400 when the run does not exist", async () => {
    const res = await request(app).post("/api/runs/nonexistent-run-id/cancel");
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBeTruthy();
  });

  it("returns 200 when cancelling an existing run", async () => {
    const pipeline = await storage.createPipeline({
      name: "Cancel Pipeline",
      stages: [],
      isTemplate: false,
    });
    const run = await storage.createPipelineRun({
      pipelineId: pipeline.id,
      status: "running",
      input: "test input",
    });

    const res = await request(app).post(`/api/runs/${run.id}/cancel`);
    expect(res.status).toBe(200);
    expect((res.body as { message: string }).message).toBeTruthy();
  });

  it("returns 401 when no auth token is provided", async () => {
    const ctx = await createUnauthenticatedApp();
    const res = await request(ctx.app).post("/api/runs/some-run/cancel");
    expect(res.status).toBe(401);
    await ctx.close();
  });
});

// ─── GET /api/runs/:id/stages ─────────────────────────────────────────────────

describe("GET /api/runs/:id/stages", () => {
  let app: Express;
  let storage: MemStorage;
  let closeApp: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await createAuthenticatedApp();
    app = ctx.app;
    storage = ctx.storage;
    closeApp = ctx.close;
  });

  afterAll(async () => {
    await closeApp();
  });

  it("returns 200 with an empty array when run has no stage executions", async () => {
    const pipeline = await storage.createPipeline({
      name: "Stages Pipeline",
      stages: [],
      isTemplate: false,
    });
    const run = await storage.createPipelineRun({
      pipelineId: pipeline.id,
      status: "pending",
      input: "test",
    });

    const res = await request(app).get(`/api/runs/${run.id}/stages`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as unknown[]).length).toBe(0);
  });

  it("returns stage executions when they exist", async () => {
    const pipeline = await storage.createPipeline({
      name: "Stages Pipeline 2",
      stages: [],
      isTemplate: false,
    });
    const run = await storage.createPipelineRun({
      pipelineId: pipeline.id,
      status: "running",
      input: "test",
    });
    await storage.createStageExecution({
      runId: run.id,
      teamId: "planning",
      stageIndex: 0,
      modelSlug: "mock",
      status: "pending",
      input: { prompt: "test" },
    });

    const res = await request(app).get(`/api/runs/${run.id}/stages`);
    expect(res.status).toBe(200);
    const stages = res.body as Array<{ teamId: string; stageIndex: number }>;
    expect(stages.length).toBe(1);
    expect(stages[0].teamId).toBe("planning");
    expect(stages[0].stageIndex).toBe(0);
  });

  it("returns 401 when no auth token is provided", async () => {
    const ctx = await createUnauthenticatedApp();
    const res = await request(ctx.app).get("/api/runs/some-run/stages");
    expect(res.status).toBe(401);
    await ctx.close();
  });
});

// ─── GET /api/runs/:id/questions ─────────────────────────────────────────────

describe("GET /api/runs/:id/questions", () => {
  let app: Express;
  let storage: MemStorage;
  let closeApp: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await createAuthenticatedApp();
    app = ctx.app;
    storage = ctx.storage;
    closeApp = ctx.close;
  });

  afterAll(async () => {
    await closeApp();
  });

  it("returns 200 with an empty array when run has no questions", async () => {
    const pipeline = await storage.createPipeline({
      name: "Questions Pipeline",
      stages: [],
      isTemplate: false,
    });
    const run = await storage.createPipelineRun({
      pipelineId: pipeline.id,
      status: "pending",
      input: "test",
    });

    const res = await request(app).get(`/api/runs/${run.id}/questions`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as unknown[]).length).toBe(0);
  });

  it("returns questions when they exist for a run", async () => {
    const pipeline = await storage.createPipeline({
      name: "Questions Pipeline 2",
      stages: [],
      isTemplate: false,
    });
    const run = await storage.createPipelineRun({
      pipelineId: pipeline.id,
      status: "paused",
      input: "test",
    });
    await storage.createQuestion({
      runId: run.id,
      stageExecutionId: "stage-exec-001",
      question: "Shall we proceed?",
      status: "pending",
    });

    const res = await request(app).get(`/api/runs/${run.id}/questions`);
    expect(res.status).toBe(200);
    const questions = res.body as Array<{ question: string; status: string }>;
    expect(questions.length).toBe(1);
    expect(questions[0].question).toBe("Shall we proceed?");
    expect(questions[0].status).toBe("pending");
  });

  it("returns 401 when no auth token is provided", async () => {
    const ctx = await createUnauthenticatedApp();
    const res = await request(ctx.app).get("/api/runs/some-run/questions");
    expect(res.status).toBe(401);
    await ctx.close();
  });
});

// ─── POST /api/runs/:id/questions/:qid/answer ────────────────────────────────

describe("POST /api/runs/:id/questions/:qid/answer", () => {
  let app: Express;
  let storage: MemStorage;
  let closeApp: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await createAuthenticatedApp();
    app = ctx.app;
    storage = ctx.storage;
    closeApp = ctx.close;
  });

  afterAll(async () => {
    await closeApp();
  });

  it("returns 400 when the answer field is missing", async () => {
    const res = await request(app)
      .post("/api/runs/run-id/questions/qid-1/answer")
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 when the answer is an empty string", async () => {
    const res = await request(app)
      .post("/api/runs/run-id/questions/qid-1/answer")
      .send({ answer: "" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when the question does not exist", async () => {
    const res = await request(app)
      .post("/api/runs/run-id/questions/nonexistent-qid/answer")
      .send({ answer: "Yes" });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBeTruthy();
  });

  it("returns 200 when answering an existing pending question", async () => {
    const pipeline = await storage.createPipeline({
      name: "Answer Pipeline",
      stages: [],
      isTemplate: false,
    });
    const run = await storage.createPipelineRun({
      pipelineId: pipeline.id,
      status: "paused",
      input: "test",
    });
    const question = await storage.createQuestion({
      runId: run.id,
      stageExecutionId: "stage-exec-ans-001",
      question: "Ready to continue?",
      status: "pending",
    });

    const res = await request(app)
      .post(`/api/runs/${run.id}/questions/${question.id}/answer`)
      .send({ answer: "Yes, proceed" });
    expect(res.status).toBe(200);
    expect((res.body as { message: string }).message).toBeTruthy();
  });

  it("returns 401 when no auth token is provided", async () => {
    const ctx = await createUnauthenticatedApp();
    const res = await request(ctx.app)
      .post("/api/runs/run-id/questions/qid-1/answer")
      .send({ answer: "ok" });
    expect(res.status).toBe(401);
    await ctx.close();
  });
});

// ─── POST /api/runs/:id/questions/:qid/dismiss ───────────────────────────────

describe("POST /api/runs/:id/questions/:qid/dismiss", () => {
  let app: Express;
  let storage: MemStorage;
  let closeApp: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await createAuthenticatedApp();
    app = ctx.app;
    storage = ctx.storage;
    closeApp = ctx.close;
  });

  afterAll(async () => {
    await closeApp();
  });

  it("returns 400 when the question does not exist", async () => {
    const res = await request(app).post(
      "/api/runs/run-id/questions/nonexistent-qid/dismiss",
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBeTruthy();
  });

  it("returns 200 when dismissing an existing pending question", async () => {
    const pipeline = await storage.createPipeline({
      name: "Dismiss Pipeline",
      stages: [],
      isTemplate: false,
    });
    const run = await storage.createPipelineRun({
      pipelineId: pipeline.id,
      status: "paused",
      input: "test",
    });
    const question = await storage.createQuestion({
      runId: run.id,
      stageExecutionId: "stage-exec-dis-001",
      question: "Dismiss this?",
      status: "pending",
    });

    const res = await request(app).post(
      `/api/runs/${run.id}/questions/${question.id}/dismiss`,
    );
    expect(res.status).toBe(200);
    expect((res.body as { message: string }).message).toBeTruthy();
  });

  it("returns 401 when no auth token is provided", async () => {
    const ctx = await createUnauthenticatedApp();
    const res = await request(ctx.app).post(
      "/api/runs/run-id/questions/qid-1/dismiss",
    );
    expect(res.status).toBe(401);
    await ctx.close();
  });
});
