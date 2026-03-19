/**
 * Integration tests for Phase 6.17 — Model Skill Bindings API.
 *
 * Covers:
 * - POST   /api/skills/models/:modelId/:skillId → 201
 * - GET    /api/skills/models/:modelId          → lists bound skills
 * - GET    /api/skills/models                   → lists model IDs with bindings
 * - DELETE /api/skills/models/:modelId/:skillId → 204
 * - 409 on duplicate bind
 * - 403 when non-owner/non-admin tries to bind
 * - 404 when skill doesn't exist
 * - 400 for invalid modelId
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { createServer } from "http";
import { MemStorage } from "../../server/storage.js";
import { registerSkillRoutes } from "../../server/routes/skills.js";
import { registerModelSkillBindingRoutes } from "../../server/routes/model-skill-bindings.js";
import type { User } from "../../shared/types.js";

const ADMIN_USER: User = {
  id: "admin-id",
  email: "admin@test.com",
  name: "Admin",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

const REGULAR_USER: User = {
  id: "regular-id",
  email: "user@test.com",
  name: "Regular",
  isActive: true,
  role: "user",
  lastLoginAt: null,
  createdAt: new Date(0),
};

function buildApp(user: User = ADMIN_USER) {
  const storage = new MemStorage();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  registerModelSkillBindingRoutes(app, storage);
  registerSkillRoutes(app, storage);
  return { app, storage };
}

describe("Model Skill Bindings API", () => {
  let app: express.Express;
  let storage: MemStorage;
  let closeServer: () => Promise<void>;
  let skillId: string;

  const MODEL_ID = "claude-sonnet-4-6"; // valid model ID from DEFAULT_MODELS

  beforeAll(async () => {
    ({ app, storage } = buildApp(ADMIN_USER));
    const httpServer = createServer(app);
    closeServer = () => new Promise<void>((r) => httpServer.close(() => r()));

    // Create a skill to use in tests
    const res = await request(app)
      .post("/api/skills")
      .send({
        name: "TestSkill",
        description: "A test skill",
        teamId: "development",
        systemPromptOverride: "You are a test assistant.",
        tools: [],
        tags: ["test"],
        isPublic: true,
      });
    expect(res.status).toBe(201);
    skillId = (res.body as { id: string }).id;
  });

  afterAll(async () => {
    await closeServer();
  });

  // ─── POST bind ──────────────────────────────────────────────────────────────

  it("POST /api/skills/models/:modelId/:skillId → 201", async () => {
    const res = await request(app).post(`/api/skills/models/${MODEL_ID}/${skillId}`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ modelId: MODEL_ID, skillId });
  });

  it("POST → 409 on duplicate bind", async () => {
    const res = await request(app).post(`/api/skills/models/${MODEL_ID}/${skillId}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already bound/i);
  });

  // ─── GET model skills ────────────────────────────────────────────────────────

  it("GET /api/skills/models/:modelId → lists bound skills", async () => {
    const res = await request(app).get(`/api/skills/models/${MODEL_ID}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as { id: string }[])[0].id).toBe(skillId);
  });

  // ─── GET models with bindings ────────────────────────────────────────────────

  it("GET /api/skills/models → lists model IDs with bindings", async () => {
    const res = await request(app).get("/api/skills/models");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body as string[]).toContain(MODEL_ID);
  });

  // ─── DELETE unbind ───────────────────────────────────────────────────────────

  it("DELETE /api/skills/models/:modelId/:skillId → 204", async () => {
    const res = await request(app).delete(`/api/skills/models/${MODEL_ID}/${skillId}`);
    expect(res.status).toBe(204);

    // Verify binding is gone
    const checkRes = await request(app).get(`/api/skills/models/${MODEL_ID}`);
    expect(checkRes.status).toBe(200);
    expect(checkRes.body as unknown[]).toHaveLength(0);
  });

  it("DELETE non-existent binding → 404", async () => {
    const res = await request(app).delete(`/api/skills/models/${MODEL_ID}/${skillId}`);
    expect(res.status).toBe(404);
  });

  // ─── 404 for non-existent skill ──────────────────────────────────────────────

  it("POST with unknown skillId → 404", async () => {
    const fakeSkillId = "00000000-0000-0000-0000-000000000000";
    const res = await request(app).post(`/api/skills/models/${MODEL_ID}/${fakeSkillId}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // ─── 400 for invalid model ID ────────────────────────────────────────────────

  it("POST with unknown/invalid modelId → 400", async () => {
    const res = await request(app).post(`/api/skills/models/INVALID-MODEL-XYZ/${skillId}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/model/i);
  });

  it("GET with unknown modelId → 400", async () => {
    const res = await request(app).get("/api/skills/models/TOTALLY-FAKE-MODEL");
    expect(res.status).toBe(400);
  });

  // ─── 403 for non-owner/non-admin ─────────────────────────────────────────────

  it("non-owner user cannot bind skill created by another user", async () => {
    // Build an app where the current user is REGULAR_USER but the skill is owned by ADMIN_USER.
    // We do this by: build a single-storage app that injects admin first to create the skill,
    // then manually creates a request with the regular user injected.
    const sharedStorage = new MemStorage();

    // Build admin app using shared storage
    const adminApp = express();
    adminApp.use(express.json());
    adminApp.use((_req, _res, next) => { _req.user = ADMIN_USER; next(); });
    registerModelSkillBindingRoutes(adminApp, sharedStorage);
    registerSkillRoutes(adminApp, sharedStorage);

    // Build regular user app using same storage
    const userApp = express();
    userApp.use(express.json());
    userApp.use((_req, _res, next) => { _req.user = REGULAR_USER; next(); });
    registerModelSkillBindingRoutes(userApp, sharedStorage);
    registerSkillRoutes(userApp, sharedStorage);

    // Admin creates a skill
    const createRes = await request(adminApp).post("/api/skills").send({
      name: "AdminOwnedSkill2",
      description: "Owned by admin",
      teamId: "development",
      systemPromptOverride: "",
      tools: [],
      tags: [],
      isPublic: true,
    });
    expect(createRes.status).toBe(201);
    const adminSkillId = (createRes.body as { id: string }).id;

    // Regular user tries to bind admin's skill — should be forbidden
    const res = await request(userApp).post(`/api/skills/models/${MODEL_ID}/${adminSkillId}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/forbidden/i);
  });

  it("owner can bind their own skill", async () => {
    // Create skill as regular user (createdBy = "regular-id")
    const { app: userApp, storage: userStorage } = buildApp(REGULAR_USER);

    const createRes = await request(userApp).post("/api/skills").send({
      name: "UserOwnedSkill",
      description: "Owned by regular user",
      teamId: "development",
      systemPromptOverride: "",
      tools: [],
      tags: [],
      isPublic: true,
    });
    expect(createRes.status).toBe(201);
    const userSkillId = (createRes.body as { id: string }).id;

    // Regular user can bind their own skill
    const bindRes = await request(userApp).post(`/api/skills/models/${MODEL_ID}/${userSkillId}`);
    expect(bindRes.status).toBe(201);
  });
});

// ─── Pipeline integration: skill resolution ────────────────────────────────

describe("Pipeline: model-specific skill resolution via MemStorage", () => {
  it("resolveSkillsForModel returns empty array for model with no bindings (global fallback)", async () => {
    const { storage } = buildApp();
    const skills = await storage.resolveSkillsForModel("grok-3");
    expect(skills).toEqual([]);
  });

  it("resolveSkillsForModel returns bound skills for model with bindings", async () => {
    const { app, storage } = buildApp(ADMIN_USER);

    // Create a skill
    const createRes = await request(app).post("/api/skills").send({
      name: "PipelineSkill",
      description: "Used by pipeline",
      teamId: "development",
      systemPromptOverride: "Pipeline helper",
      tools: ["read_file"],
      tags: [],
      isPublic: true,
    });
    expect(createRes.status).toBe(201);
    const sid = (createRes.body as { id: string }).id;

    // Bind it to grok-3
    const bindRes = await request(app).post(`/api/skills/models/grok-3/${sid}`);
    expect(bindRes.status).toBe(201);

    // Resolve — should return the bound skill
    const resolved = await storage.resolveSkillsForModel("grok-3");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("PipelineSkill");

    // Different model — no bindings → empty (global fallback)
    const fallback = await storage.resolveSkillsForModel("claude-sonnet-4-6");
    expect(fallback).toHaveLength(0);
  });
});
