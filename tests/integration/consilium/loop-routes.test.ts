/**
 * loop-routes.test.ts — B.7 integration coverage for the consilium-loop HTTP
 * surface (design §7) + the BINDING security criteria:
 *   B-2  merge-approved requires maintainer/admin PLUS visibility — a plain
 *        OWNER (role "user") without the role gets 403.
 *   H-3  create rejects a 2nd active loop on the same group (409).
 *   M-1  cross-owner access → 404 (the stronger deviation), not 403.
 *   start 409s unless PENDING.
 *
 * Uses MemStorage + a settable `req.user` middleware (mirrors models-api.test).
 * `allowedRepoPaths` points at an ISOLATED temp dir this file owns (NOT the
 * shared process.cwd()) — the realgit integration test mkdtemp/rm's inside cwd,
 * and sharing it caused an intermittent 400 on the allowlist check under
 * combined runs. `readRepoHead` is faked, so no real git ever runs here.
 */
// Bypass any ambient/sandbox HTTP proxy for the ephemeral loopback server that
// supertest spins up — otherwise the proxy intermittently answers the request
// with a 400 ("explicit proxy server ... relative URIs"), a flaky non-test 400.
process.env.NO_PROXY = ["127.0.0.1", "localhost", process.env.NO_PROXY].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.http_proxy;
delete process.env.HTTPS_PROXY;
delete process.env.https_proxy;

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User } from "../../../shared/types.js";
import { MemStorage } from "../../../server/storage.js";
import { ConsiliumLoopController } from "../../../server/services/consilium/consilium-loop-controller.js";
import { registerConsiliumLoopRoutes } from "../../../server/routes/consilium-loops.js";

// Isolated allowlist root in the OS tmpdir (outside the shared repo cwd). Created
// SYNCHRONOUSLY at module load so REPO_ROOT is a non-empty constant for every
// test body + fakeConfig — an async beforeAll left a window where REPO_ROOT was
// still "" and the zod `repoPath: min(1)` rejected create with a spurious 400.
const REPO_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "consilium-loop-routes-")));
afterAll(() => {
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

const OWNER_USER: User = { id: "owner-1", email: "o@x.io", name: "Owner", isActive: true, role: "user", lastLoginAt: null, createdAt: new Date(0) };
const MAINTAINER_USER: User = { id: "owner-1", email: "o@x.io", name: "Owner", isActive: true, role: "maintainer", lastLoginAt: null, createdAt: new Date(0) };
const OTHER_USER: User = { id: "other-2", email: "p@x.io", name: "Other", isActive: true, role: "user", lastLoginAt: null, createdAt: new Date(0) };
const ADMIN_USER: User = { id: "admin-9", email: "a@x.io", name: "Admin", isActive: true, role: "admin", lastLoginAt: null, createdAt: new Date(0) };

const fakeConfig = () =>
  ({
    pipeline: {
      consiliumLoop: {
        enabled: true,
        maxRounds: 6,
        pollIntervalMs: 5000,
        maxDiffBytes: 200000,
        allowedRepoPaths: [REPO_ROOT],
      },
    },
  }) as never;

interface Harness {
  app: Express;
  storage: MemStorage;
  group: { id: string };
  setUser: (u: User | null) => void;
}

async function setup(): Promise<Harness> {
  const storage = new MemStorage();
  let activeUser: User | null = OWNER_USER;
  const controller = new ConsiliumLoopController({
    storage,
    taskOrchestrator: {
      startGroup: async () => ({ group: {}, iteration: { iterationNumber: 1 } }),
      createTaskGroup: async () => ({ group: { id: "devgrp" }, tasks: [] }),
      cancelGroup: async () => undefined,
    } as never,
    config: fakeConfig,
    // Fix (flaky LOW): inject a FAKE HEAD reader so these route tests NEVER touch
    // real git — no shared cwd git state with the realgit integration test.
    readRepoHead: async () => "feedface",
  });

  const app: Express = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (activeUser) req.user = activeUser;
    next();
  });
  registerConsiliumLoopRoutes(app, storage, controller, fakeConfig);
  // Deterministic JSON error handler — without it an express.json() parse blip
  // (seen intermittently under the forks pool) bubbles to express's default HTML
  // handler, surfacing as a spurious empty-body 400 in supertest.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: "bad request", detail: (err as Error)?.message });
  });

  const group = await storage.createTaskGroup({
    name: "consilium",
    description: "d",
    input: "objective",
    createdBy: OWNER_USER.id,
  } as never);

  return { app, storage, group: group as { id: string }, setUser: (u: User | null) => (activeUser = u) };
}

describe("consilium-loop routes", () => {
  let ctx: Harness;
  beforeEach(async () => {
    ctx = await setup();
  });

  // Some execution environments interpose a transparent HTTP proxy that
  // intermittently answers supertest's loopback request with a text/plain 400
  // ("explicit proxy server ... relative URIs") instead of reaching the app.
  // That is an environment artifact, not a route response (real route errors are
  // application/json with an `error` field). Retry ONLY that sentinel so the
  // suite is deterministic everywhere without masking any real assertion.
  const isProxyArtifact = (res: request.Response): boolean =>
    res.status === 400 &&
    typeof res.text === "string" &&
    res.text.includes("explicit proxy server");

  async function send(
    make: () => request.Test,
  ): Promise<request.Response> {
    let res = await make();
    for (let i = 0; i < 5 && isProxyArtifact(res); i++) res = await make();
    return res;
  }

  const post = (path: string, body?: unknown): Promise<request.Response> =>
    send(() => {
      const r = request(ctx.app).post(path);
      return body === undefined ? r : r.send(body as object);
    });

  const get = (path: string): Promise<request.Response> =>
    send(() => request(ctx.app).get(path));

  it("POST create → 201, stamps createdBy = caller", async () => {
    const res = await post("/api/consilium-loops", { groupId: ctx.group.id, repoPath: REPO_ROOT });
    expect(res.status).toBe(201);
    expect(res.body.createdBy).toBe(OWNER_USER.id);
    expect(res.body.state).toBe("pending");
  });

  it("H-3: a 2nd active loop on the same group → 409", async () => {
    const first = await post("/api/consilium-loops", { groupId: ctx.group.id, repoPath: REPO_ROOT });
    expect(first.status).toBe(201);
    const second = await post("/api/consilium-loops", { groupId: ctx.group.id, repoPath: REPO_ROOT });
    expect(second.status).toBe(409);
  });

  it("create rejects a repoPath outside the allowlist → 400", async () => {
    const res = await post("/api/consilium-loops", { groupId: ctx.group.id, repoPath: "/etc" });
    expect(res.status).toBe(400);
  });

  it("M-1: cross-owner GET :id → 404 (not 403)", async () => {
    const created = await post("/api/consilium-loops", { groupId: ctx.group.id, repoPath: REPO_ROOT });
    expect(created.status).toBe(201);
    ctx.setUser(OTHER_USER);
    const res = await get(`/api/consilium-loops/${created.body.id}`);
    expect(res.status).toBe(404);
  });

  it("start 409s unless PENDING (double-start)", async () => {
    const created = await post("/api/consilium-loops", { groupId: ctx.group.id, repoPath: REPO_ROOT });
    const id = created.body.id;
    // Move it out of PENDING directly via storage, then start → 409.
    await ctx.storage.updateLoop(id, { state: "reviewing" });
    const res = await post(`/api/consilium-loops/${id}/start`);
    expect(res.status).toBe(409);
  });

  // ─── B-2: merge gate privilege (separation of duties) ──────────────────────

  it("B-2: owner WITHOUT maintainer/admin → 403 on merge-approved", async () => {
    const created = await post("/api/consilium-loops", { groupId: ctx.group.id, repoPath: REPO_ROOT });
    const id = created.body.id;
    await ctx.storage.updateLoop(id, { state: "awaiting_merge", headCommitAtReview: "abc1234" });
    // OWNER_USER is role "user" — the creator. requireRole must DENY (403).
    const res = await post(`/api/consilium-loops/${id}/merge-approved`);
    expect(res.status).toBe(403);
  });

  it("B-2: maintainer (same identity) WITH visibility → 200 on merge-approved", async () => {
    const created = await post("/api/consilium-loops", { groupId: ctx.group.id, repoPath: REPO_ROOT });
    const id = created.body.id;
    await ctx.storage.updateLoop(id, { state: "awaiting_merge", headCommitAtReview: "abc1234" });
    ctx.setUser(MAINTAINER_USER); // same id, but now role maintainer → allowed.
    const res = await post(`/api/consilium-loops/${id}/merge-approved`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("building_context");
  });

  it("B-2: admin (other identity) WITH visibility → 200; loop advances to round n+1", async () => {
    const created = await post("/api/consilium-loops", { groupId: ctx.group.id, repoPath: REPO_ROOT });
    const id = created.body.id;
    await ctx.storage.updateLoop(id, { state: "awaiting_merge", headCommitAtReview: "abc1234" });
    ctx.setUser(ADMIN_USER);
    const res = await post(`/api/consilium-loops/${id}/merge-approved`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("building_context");
  });

  it("merge-approved 409s when not AWAITING_MERGE (maintainer)", async () => {
    const created = await post("/api/consilium-loops", { groupId: ctx.group.id, repoPath: REPO_ROOT });
    ctx.setUser(MAINTAINER_USER);
    const res = await post(`/api/consilium-loops/${created.body.id}/merge-approved`);
    expect(res.status).toBe(409);
  });

  it("L-3: ownerless loop stays admin-cancellable", async () => {
    const created = await post("/api/consilium-loops", { groupId: ctx.group.id, repoPath: REPO_ROOT });
    const id = created.body.id;
    await ctx.storage.updateLoop(id, { createdBy: null }); // creator deleted
    ctx.setUser(ADMIN_USER);
    const res = await post(`/api/consilium-loops/${id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("cancelled");
  });

  it("cancel with a reason records a self-explanatory `error` (who + when + why)", async () => {
    const created = await post("/api/consilium-loops", { groupId: ctx.group.id, repoPath: REPO_ROOT });
    const id = created.body.id;
    ctx.setUser(OWNER_USER); // name "Owner"
    const res = await post(`/api/consilium-loops/${id}/cancel`, { reason: "superseded by a newer loop" });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("cancelled");
    expect(res.body.error).toMatch(/^Cancelled by Owner at .+ — superseded by a newer loop$/);
    // Persisted (not just echoed): a fresh GET carries the same explanation.
    ctx.setUser(OWNER_USER);
    const got = await get(`/api/consilium-loops/${id}`);
    expect(got.body.error).toBe(res.body.error);
  });

  it("cancel with NO body still records actor + timestamp — `error` is never blank", async () => {
    const created = await post("/api/consilium-loops", { groupId: ctx.group.id, repoPath: REPO_ROOT });
    const id = created.body.id;
    ctx.setUser(OWNER_USER);
    const res = await post(`/api/consilium-loops/${id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.error).toMatch(/^Cancelled by Owner at .+Z$/);
    expect(res.body.error).not.toContain("—");
  });

  it("list is owner-scoped: OTHER_USER sees none of OWNER's loops", async () => {
    await post("/api/consilium-loops", { groupId: ctx.group.id, repoPath: REPO_ROOT });
    ctx.setUser(OTHER_USER);
    const res = await get("/api/consilium-loops");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});
