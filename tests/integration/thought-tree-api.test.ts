/**
 * Integration tests for GET /api/runs/:runId/stages/:stageIndex/thought-tree
 *
 * Verifies:
 *   - Authentication is required (401 without user)
 *   - Ownership check enforced (403 for wrong user)
 *   - Admin bypasses ownership check
 *   - Returns 404 for unknown run or stage
 *   - Returns thought tree nodes for valid authenticated owner request
 *   - Empty thought tree returns empty array (not null)
 *   - Pipeline with no owner allows any authenticated user
 */
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";
import type { User } from "../../shared/types.js";

// ─── Test users ───────────────────────────────────────────────────────────────

const OWNER_USER: User = {
  id: "owner-user-id",
  email: "owner@example.com",
  name: "Owner",
  isActive: true,
  role: "user",
  lastLoginAt: null,
  createdAt: new Date(0),
};

const OTHER_USER: User = {
  id: "other-user-id",
  email: "other@example.com",
  name: "Other",
  isActive: true,
  role: "user",
  lastLoginAt: null,
  createdAt: new Date(0),
};

const ADMIN_USER: User = {
  id: "admin-user-id",
  email: "admin@example.com",
  name: "Admin",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

// ─── Test setup ───────────────────────────────────────────────────────────────

function makeApp(user: User | null): Express {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }
  return app;
}

describe("GET /api/runs/:runId/stages/:stageIndex/thought-tree", () => {
  let storage: Awaited<ReturnType<typeof import("../../server/storage.js").MemStorage.prototype.createPipeline>> extends never ? never : import("../../server/storage.js").MemStorage;
  let runId: string;
  let unownedRunId: string;
  const THOUGHT_TREE_NODES = [
    {
      id: "node-1",
      parentId: null,
      type: "reasoning" as const,
      label: "Thinking",
      content: "I think about X",
      timestamp: Date.now(),
    },
  ];

  beforeAll(async () => {
    const { MemStorage } = await import("../../server/storage.js");
    const { registerStatsRoutes } = await import("../../server/routes/stats.js");

    storage = new MemStorage() as typeof storage;

    // Create a pipeline owned by OWNER_USER
    const pipeline = await storage.createPipeline({
      name: "test-pipeline",
      stages: [],
      ownerId: OWNER_USER.id,
    } as Parameters<typeof storage.createPipeline>[0]);

    // Create a run for that pipeline
    const run = await storage.createPipelineRun({
      pipelineId: pipeline.id,
      status: "completed",
      input: {},
    } as Parameters<typeof storage.createPipelineRun>[0]);
    runId = run.id;

    // Create a stage execution with a thought tree
    await storage.createStageExecution({
      runId,
      stageIndex: 0,
      teamId: "planning",
      modelSlug: "claude-sonnet",
      status: "completed",
      input: {},
      thoughtTree: THOUGHT_TREE_NODES as unknown as Record<string, unknown>[],
    } as Parameters<typeof storage.createStageExecution>[0]);

    // Create a stage execution with no thought tree
    await storage.createStageExecution({
      runId,
      stageIndex: 1,
      teamId: "development",
      modelSlug: "claude-sonnet",
      status: "completed",
      input: {},
      thoughtTree: null,
    } as Parameters<typeof storage.createStageExecution>[0]);

    // Create a pipeline with NO owner
    const unownedPipeline = await storage.createPipeline({
      name: "unowned-pipeline",
      stages: [],
      ownerId: null,
    } as Parameters<typeof storage.createPipeline>[0]);
    const unownedRun = await storage.createPipelineRun({
      pipelineId: unownedPipeline.id,
      status: "completed",
      input: {},
    } as Parameters<typeof storage.createPipelineRun>[0]);
    unownedRunId = unownedRun.id;
    await storage.createStageExecution({
      runId: unownedRunId,
      stageIndex: 0,
      teamId: "planning",
      modelSlug: "claude-sonnet",
      status: "completed",
      input: {},
      thoughtTree: THOUGHT_TREE_NODES as unknown as Record<string, unknown>[],
    } as Parameters<typeof storage.createStageExecution>[0]);

    // Register routes on a shared app for tests that re-register
    // (individual tests create their own apps)
    void registerStatsRoutes; // imported but used per-test below
    void storage; // used in closure
  });

  // ── Authentication ─────────────────────────────────────────────────────────

  it("returns 401 when no user is authenticated", async () => {
    const { registerStatsRoutes } = await import("../../server/routes/stats.js");
    const app = makeApp(null);
    registerStatsRoutes(app, storage);

    const res = await request(app).get(`/api/runs/${runId}/stages/0/thought-tree`);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "Authentication required" });
  });

  // ── Ownership ──────────────────────────────────────────────────────────────

  it("returns 200 for the pipeline owner", async () => {
    const { registerStatsRoutes } = await import("../../server/routes/stats.js");
    const app = makeApp(OWNER_USER);
    registerStatsRoutes(app, storage);

    const res = await request(app).get(`/api/runs/${runId}/stages/0/thought-tree`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe("node-1");
  });

  it("returns 403 for a different user who does not own the pipeline", async () => {
    const { registerStatsRoutes } = await import("../../server/routes/stats.js");
    const app = makeApp(OTHER_USER);
    registerStatsRoutes(app, storage);

    const res = await request(app).get(`/api/runs/${runId}/stages/0/thought-tree`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: /forbidden/i });
  });

  it("returns 200 for admin regardless of ownership", async () => {
    const { registerStatsRoutes } = await import("../../server/routes/stats.js");
    const app = makeApp(ADMIN_USER);
    registerStatsRoutes(app, storage);

    const res = await request(app).get(`/api/runs/${runId}/stages/0/thought-tree`);
    expect(res.status).toBe(200);
  });

  it("returns 200 for any authenticated user when pipeline has no owner", async () => {
    const { registerStatsRoutes } = await import("../../server/routes/stats.js");
    const app = makeApp(OTHER_USER);
    registerStatsRoutes(app, storage);

    const res = await request(app).get(`/api/runs/${unownedRunId}/stages/0/thought-tree`);
    expect(res.status).toBe(200);
  });

  // ── Data ───────────────────────────────────────────────────────────────────

  it("returns empty array (not null) when thought tree is null in DB", async () => {
    const { registerStatsRoutes } = await import("../../server/routes/stats.js");
    const app = makeApp(OWNER_USER);
    registerStatsRoutes(app, storage);

    const res = await request(app).get(`/api/runs/${runId}/stages/1/thought-tree`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  // ── Not found ──────────────────────────────────────────────────────────────

  it("returns 404 for an unknown runId", async () => {
    const { registerStatsRoutes } = await import("../../server/routes/stats.js");
    const app = makeApp(OWNER_USER);
    registerStatsRoutes(app, storage);

    const res = await request(app).get(`/api/runs/unknown-run-id/stages/0/thought-tree`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when stage index is out of range", async () => {
    const { registerStatsRoutes } = await import("../../server/routes/stats.js");
    const app = makeApp(OWNER_USER);
    registerStatsRoutes(app, storage);

    const res = await request(app).get(`/api/runs/${runId}/stages/99/thought-tree`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for a non-numeric stage index", async () => {
    const { registerStatsRoutes } = await import("../../server/routes/stats.js");
    const app = makeApp(OWNER_USER);
    registerStatsRoutes(app, storage);

    const res = await request(app).get(`/api/runs/${runId}/stages/abc/thought-tree`);
    expect(res.status).toBe(400);
  });
});
