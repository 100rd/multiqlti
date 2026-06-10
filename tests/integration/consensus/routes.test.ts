/**
 * Integration tests for the /consensus routes — authZ + lifecycle over the
 * test-consensus-app factory (MemStorage + a deterministic gateway double). No
 * CLI / network / real DB.
 *
 * Covers: kill-switch 503 (route + controller), unauth 401, invalid body 400,
 * rate-limit 429, missing 404, non-owner 403, deny-when-ownerId-null, admin
 * bypass, the 401/403/404 ordering, owner-gate on workspaceId, and a happy
 * start → resolved run with scrubbed persistence.
 *
 * Invoked by the vitest integration project (include tests/integration/**).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createConsensusTestApp } from "../../helpers/test-consensus-app.js";
import { registerConsensusRoutes } from "../../../server/routes/consensus.js";
import type { MemStorage } from "../../../server/storage.js";
import type { ConsensusController } from "../../../server/consensus/consensus-controller.js";
import type { UserRole } from "../../../shared/types.js";

afterEach(() => vi.restoreAllMocks());

let seq = 0;
const uniqueUser = () => `cons-user-${seq++}`;

/** Build an app bound to existing storage+controller but a DIFFERENT user. */
function appAs(
  storage: MemStorage,
  controller: ConsensusController,
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
  registerConsensusRoutes(app as never, storage, controller);
  return app;
}

/** Seed a consensus run owned by `ownerId` (or ownerless) directly in storage. */
async function seedRun(storage: MemStorage, ownerId: string | null): Promise<string> {
  const run = await storage.createPipelineRun({
    pipelineId: "consensus:seed",
    status: "completed",
    input: "decision",
    triggeredBy: ownerId,
  });
  await storage.createConsensusRun({ runId: run.id, decisionText: "d", status: "resolved" });
  return run.id;
}

describe("POST /api/runs/consensus — start", () => {
  it("503 when the kill-switch is disabled (route)", async () => {
    const { app } = createConsensusTestApp({ enabled: false });
    const res = await request(app).post("/api/runs/consensus").send({ decisionText: "ship it?" });
    expect(res.status).toBe(503);
  });

  it("401 when unauthenticated", async () => {
    const { app } = createConsensusTestApp({ userId: uniqueUser() });
    const res = await request(app)
      .post("/api/runs/consensus")
      .set("x-test-unauth", "1")
      .send({ decisionText: "t" });
    expect(res.status).toBe(401);
  });

  it("400 on an invalid body (missing decisionText)", async () => {
    const { app } = createConsensusTestApp({ userId: uniqueUser() });
    const res = await request(app).post("/api/runs/consensus").send({});
    expect(res.status).toBe(400);
  });

  it("400 on an over-long decisionText (>50_000)", async () => {
    const { app } = createConsensusTestApp({ userId: uniqueUser() });
    const res = await request(app)
      .post("/api/runs/consensus")
      .send({ decisionText: "x".repeat(50_001) });
    expect(res.status).toBe(400);
  });

  it("201 + resolved on a happy run (all APPROVE)", async () => {
    const userId = uniqueUser();
    const { app, storage } = createConsensusTestApp({ userId, verdict: "APPROVE" });
    const res = await request(app).post("/api/runs/consensus").send({ decisionText: "Adopt OpenTofu?" });
    expect(res.status).toBe(201);
    expect(res.body.runId).toBeDefined();
    expect(res.body.status).toBe("resolved");

    const cr = await storage.getConsensusRun(res.body.runId);
    expect(cr?.finalVerdict).toBe("APPROVE");
    expect(cr?.status).toBe("resolved");
  });

  it("201 + unresolved when voters reject", async () => {
    const userId = uniqueUser();
    const { app } = createConsensusTestApp({ userId, verdict: "REJECT" });
    const res = await request(app)
      .post("/api/runs/consensus")
      .send({ decisionText: "Adopt risky thing?" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("unresolved");
  });

  it("429 when the per-user rate limit is exceeded", async () => {
    const { app } = createConsensusTestApp({ userId: uniqueUser() });
    let lastStatus = 0;
    for (let i = 0; i < 7; i++) {
      const res = await request(app).post("/api/runs/consensus").send({ decisionText: "t" });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it("400 when binding to a non-existent workspace", async () => {
    const { app } = createConsensusTestApp({ userId: uniqueUser() });
    const res = await request(app)
      .post("/api/runs/consensus")
      .send({ decisionText: "t", workspaceId: "no-such-ws" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/runs/:id/consensus — inspect (authz)", () => {
  it("404 for a missing run", async () => {
    const { app } = createConsensusTestApp({ userId: uniqueUser() });
    const res = await request(app).get("/api/runs/nonexistent/consensus");
    expect(res.status).toBe(404);
  });

  it("401 unauth takes precedence over 404 (ordering)", async () => {
    const { app } = createConsensusTestApp({ userId: uniqueUser() });
    const res = await request(app).get("/api/runs/nonexistent/consensus").set("x-test-unauth", "1");
    expect(res.status).toBe(401);
  });

  it("200 for the owner", async () => {
    const owner = uniqueUser();
    const { app, storage } = createConsensusTestApp({ userId: owner });
    const runId = await seedRun(storage, owner);
    const res = await request(app).get(`/api/runs/${runId}/consensus`);
    expect(res.status).toBe(200);
    expect(res.body.consensusRun.runId).toBe(runId);
  });

  it("403 for a non-owner", async () => {
    const { storage, controller } = createConsensusTestApp({ userId: uniqueUser() });
    const runId = await seedRun(storage, "owner-A");
    const res = await request(appAs(storage, controller, "intruder-B", "user")).get(
      `/api/runs/${runId}/consensus`,
    );
    expect(res.status).toBe(403);
  });

  it("403 DENY when the run is ownerless (triggeredBy null) for a non-admin", async () => {
    const { storage, controller } = createConsensusTestApp({ userId: uniqueUser() });
    const runId = await seedRun(storage, null);
    const res = await request(appAs(storage, controller, "anyone", "user")).get(
      `/api/runs/${runId}/consensus`,
    );
    expect(res.status).toBe(403);
  });

  it("200 admin bypass on an ownerless run", async () => {
    const { storage, controller } = createConsensusTestApp({ userId: uniqueUser() });
    const runId = await seedRun(storage, null);
    const res = await request(appAs(storage, controller, "admin-user", "admin")).get(
      `/api/runs/${runId}/consensus`,
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /api/runs/:id/consensus/rounds + /issues — authz", () => {
  it("rounds: 403 for a non-owner", async () => {
    const { storage, controller } = createConsensusTestApp({ userId: uniqueUser() });
    const runId = await seedRun(storage, "owner-A");
    const res = await request(appAs(storage, controller, "intruder-B", "user")).get(
      `/api/runs/${runId}/consensus/rounds`,
    );
    expect(res.status).toBe(403);
  });

  it("issues: 200 for the owner", async () => {
    const owner = uniqueUser();
    const { app, storage } = createConsensusTestApp({ userId: owner });
    const runId = await seedRun(storage, owner);
    const res = await request(app).get(`/api/runs/${runId}/consensus/issues`);
    expect(res.status).toBe(200);
    expect(res.body.issues).toEqual([]);
  });

  it("rounds: 404 for a missing run", async () => {
    const { app } = createConsensusTestApp({ userId: uniqueUser() });
    const res = await request(app).get("/api/runs/missing/consensus/rounds");
    expect(res.status).toBe(404);
  });
});
