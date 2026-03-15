/**
 * RBAC integration tests.
 *
 * Tests the pipeline routes for role-based access control.
 * Uses the standard test-app helper which injects an admin user by default.
 * Each test that needs a different role creates a custom Express app.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";
import { createTestApp } from "../helpers/test-app.js";
import { requireRole, requireOwnerOrRole } from "../../server/auth/middleware.js";
import { registerPipelineRoutes } from "../../server/routes/pipelines.js";
import { MemStorage } from "../../server/storage.js";
import type { User } from "../../shared/types.js";

type TestApp = { app: Express; storage: MemStorage; close: () => Promise<void> };

function createAppWithUser(user: User, storage?: MemStorage): { app: Express; storage: MemStorage } {
  const st = storage ?? new MemStorage();
  const app = express();
  app.use(express.json());
  // Inject the given user on every request
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  registerPipelineRoutes(app, st);
  return { app, storage: st };
}

const ADMIN_USER: User = {
  id: "admin-id",
  email: "admin@example.com",
  name: "Admin",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(),
};

const MAINTAINER_USER: User = {
  id: "maintainer-id",
  email: "maintainer@example.com",
  name: "Maintainer",
  isActive: true,
  role: "maintainer",
  lastLoginAt: null,
  createdAt: new Date(),
};

const REGULAR_USER: User = {
  id: "user-id",
  email: "user@example.com",
  name: "Regular User",
  isActive: true,
  role: "user",
  lastLoginAt: null,
  createdAt: new Date(),
};

// ─── POST /api/pipelines — role enforcement ───────────────────────────────────

describe("POST /api/pipelines — RBAC", () => {
  it("admin can create a pipeline", async () => {
    const { app } = createAppWithUser(ADMIN_USER);
    const res = await request(app)
      .post("/api/pipelines")
      .send({ name: "Admin Pipeline", stages: [] });
    expect(res.status).toBe(201);
    expect((res.body as { name: string }).name).toBe("Admin Pipeline");
  });

  it("maintainer can create a pipeline", async () => {
    const { app } = createAppWithUser(MAINTAINER_USER);
    const res = await request(app)
      .post("/api/pipelines")
      .send({ name: "Maintainer Pipeline", stages: [] });
    expect(res.status).toBe(201);
  });

  it("regular user cannot create a pipeline (403)", async () => {
    const { app } = createAppWithUser(REGULAR_USER);
    const res = await request(app)
      .post("/api/pipelines")
      .send({ name: "User Pipeline", stages: [] });
    expect(res.status).toBe(403);
  });
});

// ─── PATCH /api/pipelines/:id — owner or admin ───────────────────────────────

describe("PATCH /api/pipelines/:id — owner or admin", () => {
  let storage: MemStorage;
  let pipelineId: string;

  beforeAll(async () => {
    storage = new MemStorage();
    // Admin creates the pipeline (owner = admin-id)
    const adminApp = createAppWithUser(ADMIN_USER, storage);
    const res = await request(adminApp.app)
      .post("/api/pipelines")
      .send({ name: "Owned Pipeline", stages: [] });
    pipelineId = (res.body as { id: string }).id;
  });

  it("owner (admin) can update their own pipeline", async () => {
    const { app } = createAppWithUser(ADMIN_USER, storage);
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}`)
      .send({ name: "Updated Name" });
    expect(res.status).toBe(200);
    expect((res.body as { name: string }).name).toBe("Updated Name");
  });

  it("admin can update any pipeline", async () => {
    const { app } = createAppWithUser(ADMIN_USER, storage);
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}`)
      .send({ name: "Admin Updated" });
    expect(res.status).toBe(200);
  });

  it("regular user cannot update another user's pipeline (403)", async () => {
    const { app } = createAppWithUser(REGULAR_USER, storage);
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}`)
      .send({ name: "Hijacked" });
    expect(res.status).toBe(403);
  });

  it("maintainer who is the owner can update their pipeline", async () => {
    // Maintainer creates a pipeline — they become owner
    const storage2 = new MemStorage();
    const maintainerApp = createAppWithUser(MAINTAINER_USER, storage2);
    const createRes = await request(maintainerApp.app)
      .post("/api/pipelines")
      .send({ name: "Maintainer Owned", stages: [] });
    const maintainerPipelineId = (createRes.body as { id: string }).id;

    const res = await request(maintainerApp.app)
      .patch(`/api/pipelines/${maintainerPipelineId}`)
      .send({ name: "Maintainer Updated" });
    expect(res.status).toBe(200);
  });
});

// ─── DELETE /api/pipelines/:id — owner or admin ──────────────────────────────

describe("DELETE /api/pipelines/:id — owner or admin", () => {
  it("regular user cannot delete another user's pipeline (403)", async () => {
    const storage = new MemStorage();
    const adminApp = createAppWithUser(ADMIN_USER, storage);
    const createRes = await request(adminApp.app)
      .post("/api/pipelines")
      .send({ name: "Admin Owned", stages: [] });
    const pid = (createRes.body as { id: string }).id;

    const userApp = createAppWithUser(REGULAR_USER, storage);
    const res = await request(userApp.app).delete(`/api/pipelines/${pid}`);
    expect(res.status).toBe(403);
  });

  it("admin can delete any pipeline", async () => {
    const storage = new MemStorage();
    const adminApp = createAppWithUser(ADMIN_USER, storage);
    const createRes = await request(adminApp.app)
      .post("/api/pipelines")
      .send({ name: "To Delete", stages: [] });
    const pid = (createRes.body as { id: string }).id;

    const res = await request(adminApp.app).delete(`/api/pipelines/${pid}`);
    expect(res.status).toBe(204);
  });
});

// ─── GET /api/pipelines — any authenticated user ─────────────────────────────

describe("GET /api/pipelines — any authenticated user", () => {
  it("regular user can list pipelines", async () => {
    const { app } = createAppWithUser(REGULAR_USER);
    const res = await request(app).get("/api/pipelines");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("admin can list pipelines", async () => {
    const { app } = createAppWithUser(ADMIN_USER);
    const res = await request(app).get("/api/pipelines");
    expect(res.status).toBe(200);
  });
});

// ─── Pipeline ownerId is set on creation ─────────────────────────────────────

describe("ownerId is set on pipeline creation", () => {
  it("ownerId matches the creating user's id", async () => {
    const { app, storage } = createAppWithUser(ADMIN_USER);
    const res = await request(app)
      .post("/api/pipelines")
      .send({ name: "Owner Test", stages: [] });
    expect(res.status).toBe(201);
    const pipeline = await storage.getPipeline((res.body as { id: string }).id);
    expect(pipeline?.ownerId).toBe(ADMIN_USER.id);
  });
});
