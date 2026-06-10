/**
 * Integration tests for the orchestrator routes (T11) — TC-Z01..Z11.
 *
 * Covers: unauth 401, non-owner 403, missing 404, kill-switch 503, rate-limit
 * 429, wrong-state approve 409, admin bypass, deny-when-ownerId-null, and the
 * 401/403/404 ordering. supertest over the test-orchestrator-app factory
 * (MemStorage + mock gateway + injected step executors). No CLI / network / DB.
 *
 * Invoked by the vitest integration project (include tests/integration/**).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createOrchestratorTestApp } from "../../helpers/test-orchestrator-app.js";
import { registerOrchestratorRoutes } from "../../../server/routes/orchestrator.js";
import type { MemStorage } from "../../../server/storage.js";
import type { PipelineController } from "../../../server/controller/pipeline-controller.js";
import type { UserRole } from "../../../shared/types.js";

afterEach(() => vi.restoreAllMocks());

/** Build an app bound to existing storage+controller but a DIFFERENT user. */
function appAs(
  storage: MemStorage,
  controller: PipelineController,
  id: string,
  role: UserRole,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id,
      email: `${id}@x.com`,
      name: id,
      isActive: true,
      role,
      lastLoginAt: null,
      createdAt: new Date(0),
    } as never;
    next();
  });
  registerOrchestratorRoutes(app as never, storage, controller);
  return app;
}

describe("POST /api/runs/orchestrator — start", () => {
  it("503 when the kill-switch is disabled (L1)", async () => {
    const { app } = createOrchestratorTestApp({ enabled: false });
    const res = await request(app)
      .post("/api/runs/orchestrator")
      .send({ task: "compare frameworks" });
    expect(res.status).toBe(503);
  });

  it("401 when unauthenticated", async () => {
    const { app } = createOrchestratorTestApp();
    const res = await request(app)
      .post("/api/runs/orchestrator")
      .set("x-test-unauth", "1")
      .send({ task: "t" });
    expect(res.status).toBe(401);
  });

  it("400 on an invalid body (missing task)", async () => {
    const { app } = createOrchestratorTestApp();
    const res = await request(app).post("/api/runs/orchestrator").send({});
    expect(res.status).toBe(400);
  });

  it("201 starts the run and returns awaiting_plan_approval + plan", async () => {
    const { app } = createOrchestratorTestApp();
    const res = await request(app)
      .post("/api/runs/orchestrator")
      .send({ task: "compare frameworks" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("awaiting_plan_approval");
    expect(Array.isArray(res.body.plan)).toBe(true);
    expect(res.body.runId).toBeTruthy();
  });

  it("429 when the per-user rate limit is exceeded", async () => {
    const { app } = createOrchestratorTestApp({ userId: "rl-user" });
    let lastStatus = 0;
    for (let i = 0; i < 7; i++) {
      const res = await request(app).post("/api/runs/orchestrator").send({ task: "t" });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});

describe("GET /api/runs/:id/orchestrator — inspect (authz)", () => {
  it("404 for a missing run", async () => {
    const { app } = createOrchestratorTestApp();
    const res = await request(app).get("/api/runs/nonexistent/orchestrator");
    expect(res.status).toBe(404);
  });

  it("401 unauth takes precedence over 404 (ordering)", async () => {
    const { app } = createOrchestratorTestApp();
    const res = await request(app)
      .get("/api/runs/nonexistent/orchestrator")
      .set("x-test-unauth", "1");
    expect(res.status).toBe(401);
  });

  it("200 for the owner", async () => {
    const { app } = createOrchestratorTestApp({ userId: "owner-1" });
    const start = await request(app).post("/api/runs/orchestrator").send({ task: "t" });
    const res = await request(app).get(`/api/runs/${start.body.runId}/orchestrator`);
    expect(res.status).toBe(200);
    expect(res.body.orchestratorRun.runId).toBe(start.body.runId);
  });

  it("403 for a non-owner, non-admin user", async () => {
    const owner = createOrchestratorTestApp({ userId: "owner-A" });
    const start = await request(owner.app).post("/api/runs/orchestrator").send({ task: "t" });
    const other = appAs(owner.storage, owner.controller, "user-B", "user");
    const res = await request(other).get(`/api/runs/${start.body.runId}/orchestrator`);
    expect(res.status).toBe(403);
  });

  it("admin bypasses the owner check (200)", async () => {
    const owner = createOrchestratorTestApp({ userId: "owner-A" });
    const start = await request(owner.app).post("/api/runs/orchestrator").send({ task: "t" });
    const admin = appAs(owner.storage, owner.controller, "admin-1", "admin");
    const res = await request(admin).get(`/api/runs/${start.body.runId}/orchestrator`);
    expect(res.status).toBe(200);
  });

  it("DENIES when the run ownerId (triggeredBy) is null (stricter than manager)", async () => {
    const { app, storage } = createOrchestratorTestApp({ userId: "user-1" });
    const run = await storage.createPipelineRun({
      pipelineId: "orchestrator:x",
      status: "paused",
      input: "t",
      workspaceId: null,
      currentStageIndex: 0,
      startedAt: new Date(),
      triggeredBy: null,
      dagMode: false,
    });
    await storage.createOrchestratorRun({
      runId: run.id,
      task: "t",
      status: "awaiting_plan_approval",
    });

    const res = await request(app).get(`/api/runs/${run.id}/orchestrator`);
    expect(res.status).toBe(403);
  });
});

describe("POST /api/runs/:id/orchestrator/approve-plan", () => {
  it("404 for a missing run", async () => {
    const { app } = createOrchestratorTestApp();
    const res = await request(app).post("/api/runs/nonexistent/orchestrator/approve-plan").send({});
    expect(res.status).toBe(404);
  });

  it("403 for a non-owner", async () => {
    const owner = createOrchestratorTestApp({ userId: "owner-A" });
    const start = await request(owner.app).post("/api/runs/orchestrator").send({ task: "t" });
    const other = appAs(owner.storage, owner.controller, "user-B", "user");
    const res = await request(other)
      .post(`/api/runs/${start.body.runId}/orchestrator/approve-plan`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("409 when approving a run that is not awaiting approval", async () => {
    const { app, storage } = createOrchestratorTestApp({ userId: "user-1" });
    const run = await storage.createPipelineRun({
      pipelineId: "orchestrator:x",
      status: "completed",
      input: "t",
      workspaceId: null,
      currentStageIndex: 0,
      startedAt: new Date(),
      triggeredBy: "user-1",
      dagMode: false,
    });
    await storage.createOrchestratorRun({ runId: run.id, task: "t", status: "completed" });

    const res = await request(app).post(`/api/runs/${run.id}/orchestrator/approve-plan`).send({});
    expect(res.status).toBe(409);
  });
});

describe("POST /api/runs/orchestrator — workspace owner-gate (H-WS-1)", () => {
  async function seedWorkspace(storage: MemStorage, ownerId: string | null) {
    return storage.createWorkspace({
      name: "WS",
      type: "local",
      path: "/tmp/ws",
      branch: "main",
      status: "active",
      ownerId,
    });
  }

  it("403 when binding to a workspace owned by another user", async () => {
    const { app, storage } = createOrchestratorTestApp({ userId: "user-1" });
    const ws = await seedWorkspace(storage, "someone-else");
    const res = await request(app)
      .post("/api/runs/orchestrator")
      .send({ task: "t", workspaceId: ws.id });
    expect(res.status).toBe(403);
  });

  it("201 when the workspace is owned by the caller", async () => {
    const { app, storage } = createOrchestratorTestApp({ userId: "owner-ws" });
    const ws = await seedWorkspace(storage, "owner-ws");
    const res = await request(app)
      .post("/api/runs/orchestrator")
      .send({ task: "t", workspaceId: ws.id });
    expect(res.status).toBe(201);
  });

  it("201 when the workspace is ownerless (null owner)", async () => {
    const { app, storage } = createOrchestratorTestApp({ userId: "user-null" });
    const ws = await seedWorkspace(storage, null);
    const res = await request(app)
      .post("/api/runs/orchestrator")
      .send({ task: "t", workspaceId: ws.id });
    expect(res.status).toBe(201);
  });

  it("admin may bind to another user's workspace (201)", async () => {
    const { app, storage } = createOrchestratorTestApp({ userId: "admin-1", role: "admin" });
    const ws = await seedWorkspace(storage, "someone-else");
    const res = await request(app)
      .post("/api/runs/orchestrator")
      .send({ task: "t", workspaceId: ws.id });
    expect(res.status).toBe(201);
  });
});
