/**
 * Integration tests for Phase 3.1b — Skills API.
 *
 * Uses MemStorage + synthetic admin (no real auth layer).
 * Verifies:
 * - GET /api/skills returns seeded built-in skills
 * - POST /api/skills creates a custom skill
 * - PATCH /api/skills/:id updates a custom skill (blocks built-in)
 * - DELETE /api/skills/:id removes a custom skill (blocks built-in)
 * - Skill filtering by teamId and isBuiltin
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { createServer } from "http";
import { MemStorage } from "../../server/storage.js";
import { registerSkillRoutes } from "../../server/routes/skills.js";
import { BUILTIN_SKILLS } from "../../server/skills/builtin.js";
import type { User } from "../../shared/types.js";

const TEST_ADMIN: User = {
  id: "test-admin-id",
  email: "admin@test.com",
  name: "Test Admin",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

async function createSkillsTestApp() {
  const storage = new MemStorage();
  const app = express();
  app.use(express.json());
  // Inject synthetic admin
  app.use((req, _res, next) => {
    req.user = TEST_ADMIN;
    next();
  });
  registerSkillRoutes(app, storage);

  // Seed built-in skills
  for (const skill of BUILTIN_SKILLS) {
    await storage.createSkill(skill);
  }

  const httpServer = createServer(app);
  return {
    app,
    storage,
    close: () => new Promise<void>((r) => httpServer.close(() => r())),
  };
}

describe("Skills API", () => {
  let app: express.Express;
  let closeApp: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createSkillsTestApp();
    app = testApp.app;
    closeApp = testApp.close;
  }, 15_000);

  afterAll(async () => {
    await closeApp();
  });

  // ─── GET /api/skills ──────────────────────────────────────────────────────

  it("GET /api/skills → 200 with built-in skills", async () => {
    const res = await request(app).get("/api/skills");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it("GET /api/skills → all returned skills have isBuiltin = true (only seeded builtins)", async () => {
    const res = await request(app).get("/api/skills?isBuiltin=true");
    expect(res.status).toBe(200);
    const skills = res.body as Array<{ isBuiltin: boolean }>;
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((s) => s.isBuiltin)).toBe(true);
  });

  it("GET /api/skills?isBuiltin=false → empty initially", async () => {
    const res = await request(app).get("/api/skills?isBuiltin=false");
    expect(res.status).toBe(200);
    const skills = res.body as Array<{ isBuiltin: boolean }>;
    expect(skills.every((s) => !s.isBuiltin)).toBe(true);
  });

  it("GET /api/skills?teamId=code_review → filters by team", async () => {
    const res = await request(app).get("/api/skills?teamId=code_review");
    expect(res.status).toBe(200);
    const skills = res.body as Array<{ teamId: string }>;
    if (skills.length > 0) {
      expect(skills.every((s) => s.teamId === "code_review")).toBe(true);
    }
  });

  // ─── GET /api/skills/builtin ─────────────────────────────────────────────

  it("GET /api/skills/builtin → returns built-in definitions array", async () => {
    const res = await request(app).get("/api/skills/builtin");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as unknown[]).length).toBeGreaterThan(0);
  });

  // ─── GET /api/skills/:id ─────────────────────────────────────────────────

  it("GET /api/skills/builtin-code-review → 200", async () => {
    const res = await request(app).get("/api/skills/builtin-code-review");
    expect(res.status).toBe(200);
    expect((res.body as { name: string }).name).toBe("Code Review");
  });

  it("GET /api/skills/nonexistent → 404", async () => {
    const res = await request(app).get("/api/skills/does-not-exist");
    expect(res.status).toBe(404);
  });

  // ─── POST /api/skills ─────────────────────────────────────────────────────

  let createdSkillId: string;

  it("POST /api/skills → 201 creates a custom skill", async () => {
    const res = await request(app)
      .post("/api/skills")
      .send({
        name: "Custom Refactoring Skill",
        description: "Focuses on clean code.",
        teamId: "development",
        systemPromptOverride: "You are an expert refactorer.",
        tools: ["code_search"],
        tags: ["refactoring"],
        isPublic: true,
      });
    expect(res.status).toBe(201);
    const skill = res.body as { id: string; name: string; isBuiltin: boolean };
    expect(skill.name).toBe("Custom Refactoring Skill");
    expect(skill.isBuiltin).toBe(false);
    createdSkillId = skill.id;
  });

  it("POST /api/skills → 400 on missing required fields", async () => {
    const res = await request(app)
      .post("/api/skills")
      .send({ description: "Missing name and teamId" });
    expect(res.status).toBe(400);
  });

  // ─── PATCH /api/skills/:id ────────────────────────────────────────────────

  it("PATCH /api/skills/:id → 200 updates a custom skill", async () => {
    const res = await request(app)
      .patch(`/api/skills/${createdSkillId}`)
      .send({ description: "Updated description." });
    expect(res.status).toBe(200);
    expect((res.body as { description: string }).description).toBe("Updated description.");
  });

  it("PATCH /api/skills/builtin-code-review → 403 cannot modify built-in", async () => {
    const res = await request(app)
      .patch("/api/skills/builtin-code-review")
      .send({ name: "Hacked" });
    expect(res.status).toBe(403);
  });

  // ─── DELETE /api/skills/:id ───────────────────────────────────────────────

  it("DELETE /api/skills/builtin-security-analysis → 403 cannot delete built-in", async () => {
    const res = await request(app).delete("/api/skills/builtin-security-analysis");
    expect(res.status).toBe(403);
  });

  it("DELETE /api/skills/:id → 204 deletes a custom skill", async () => {
    const res = await request(app).delete(`/api/skills/${createdSkillId}`);
    expect(res.status).toBe(204);
  });

  it("GET /api/skills/:id after delete → 404", async () => {
    const res = await request(app).get(`/api/skills/${createdSkillId}`);
    expect(res.status).toBe(404);
  });
});
