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
 *
 * Phase 6.8 additions:
 * - GET /api/skills/export
 * - POST /api/skills/import
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

// ─── Phase 6.8: Skills Export/Import API ──────────────────────────────────────

describe("Skills Export/Import API", () => {
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

  // ─── GET /api/skills/export ───────────────────────────────────────────────

  it("GET /api/skills/export → 200 with valid JSON shape when no custom skills", async () => {
    const res = await request(app).get("/api/skills/export");
    expect(res.status).toBe(200);
    const body = res.body as { version: string; exportedAt: string; skills: unknown[] };
    expect(body.version).toBe("1.0");
    expect(typeof body.exportedAt).toBe("string");
    expect(Array.isArray(body.skills)).toBe(true);
    // No custom skills seeded — only built-ins are present, export returns user's custom skills
    expect(body.skills.length).toBe(0);
  });

  it("GET /api/skills/export → 200 includes created custom skill", async () => {
    // Create a custom skill first
    await request(app).post("/api/skills").send({
      name: "Export Target Skill",
      description: "Will be exported.",
      teamId: "development",
      systemPromptOverride: "Export me.",
      tools: [],
      tags: ["export-test"],
      isPublic: false,
    });

    const res = await request(app).get("/api/skills/export");
    expect(res.status).toBe(200);
    const body = res.body as { version: string; exportedAt: string; skills: Array<{ name: string }> };
    expect(body.skills.length).toBeGreaterThanOrEqual(1);
    expect(body.skills.some((s) => s.name === "Export Target Skill")).toBe(true);
  });

  it("GET /api/skills/export → Content-Disposition header set for download", async () => {
    const res = await request(app).get("/api/skills/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("skills-export.json");
  });

  // ─── POST /api/skills/import ──────────────────────────────────────────────

  it("POST /api/skills/import → 200 imports new skills", async () => {
    const res = await request(app)
      .post("/api/skills/import")
      .send({
        conflictStrategy: "skip",
        skills: [
          {
            name: "Imported Skill One",
            description: "First import.",
            teamId: "testing",
            systemPromptOverride: "Write tests.",
            tools: ["knowledge_search"],
            tags: ["imported"],
            isPublic: true,
          },
          {
            name: "Imported Skill Two",
            description: "Second import.",
            teamId: "architecture",
            systemPromptOverride: "Design APIs.",
            tools: ["web_search"],
            tags: ["imported"],
            isPublic: false,
          },
        ],
      });
    expect(res.status).toBe(200);
    const result = res.body as { imported: number; skipped: number; errors: string[] };
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("POST /api/skills/import with conflictStrategy=skip → skips duplicates", async () => {
    // Create the skill first
    await request(app).post("/api/skills").send({
      name: "Duplicate Skill",
      description: "Already exists.",
      teamId: "development",
      systemPromptOverride: "Original prompt.",
      tools: [],
      tags: [],
      isPublic: true,
    });

    // Attempt to import the same name again with skip strategy
    const res = await request(app)
      .post("/api/skills/import")
      .send({
        conflictStrategy: "skip",
        skills: [
          {
            name: "Duplicate Skill",
            description: "Attempted overwrite.",
            teamId: "development",
            systemPromptOverride: "Should not replace.",
            tools: [],
            tags: [],
            isPublic: true,
          },
        ],
      });
    expect(res.status).toBe(200);
    const result = res.body as { imported: number; skipped: number; errors: string[] };
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);

    // Verify original description is unchanged
    const listRes = await request(app).get("/api/skills");
    const skills = listRes.body as Array<{ name: string; description: string }>;
    const found = skills.find((s) => s.name === "Duplicate Skill");
    expect(found?.description).toBe("Already exists.");
  });

  it("POST /api/skills/import with conflictStrategy=overwrite → updates duplicates", async () => {
    // Create the skill first
    await request(app).post("/api/skills").send({
      name: "Overwrite Target",
      description: "Original description.",
      teamId: "development",
      systemPromptOverride: "Old prompt.",
      tools: [],
      tags: [],
      isPublic: true,
    });

    // Import with overwrite
    const res = await request(app)
      .post("/api/skills/import")
      .send({
        conflictStrategy: "overwrite",
        skills: [
          {
            name: "Overwrite Target",
            description: "Updated description.",
            teamId: "development",
            systemPromptOverride: "New prompt.",
            tools: ["knowledge_search"],
            tags: ["overwritten"],
            isPublic: false,
          },
        ],
      });
    expect(res.status).toBe(200);
    const result = res.body as { imported: number; skipped: number; errors: string[] };
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);

    // Verify the description was updated
    const listRes = await request(app).get("/api/skills");
    const skills = listRes.body as Array<{ name: string; description: string }>;
    const found = skills.find((s) => s.name === "Overwrite Target");
    expect(found?.description).toBe("Updated description.");
  });

  it("POST /api/skills/import → 400 on invalid request body shape", async () => {
    const res = await request(app)
      .post("/api/skills/import")
      .send({ notSkills: "wrong shape" });
    expect(res.status).toBe(400);
  });

  it("POST /api/skills/import → records errors for invalid skill entries but processes valid ones", async () => {
    const res = await request(app)
      .post("/api/skills/import")
      .send({
        conflictStrategy: "skip",
        skills: [
          // Valid skill
          {
            name: "Valid Import Skill",
            description: "Good skill.",
            teamId: "testing",
            systemPromptOverride: "Test.",
            tools: [],
            tags: [],
            isPublic: true,
          },
          // Invalid — missing name and teamId
          {
            description: "No name or teamId.",
          },
        ],
      });
    expect(res.status).toBe(200);
    const result = res.body as { imported: number; skipped: number; errors: string[] };
    expect(result.imported).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("index 1");
  });

  it("POST /api/skills/import → strips id and isBuiltin from imported skills", async () => {
    const res = await request(app)
      .post("/api/skills/import")
      .send({
        conflictStrategy: "skip",
        skills: [
          {
            id: "attacker-chosen-id",
            name: "Injected ID Skill",
            description: "Should not retain the provided id.",
            teamId: "development",
            systemPromptOverride: "Injection test.",
            isBuiltin: true,
            tools: [],
            tags: [],
            isPublic: true,
          },
        ],
      });
    expect(res.status).toBe(200);
    const result = res.body as { imported: number; skipped: number; errors: string[] };
    expect(result.imported).toBe(1);

    // The injected id must not exist as a skill id
    const byIdRes = await request(app).get("/api/skills/attacker-chosen-id");
    expect(byIdRes.status).toBe(404);

    // The skill should not be marked built-in
    const listRes = await request(app).get("/api/skills?isBuiltin=false");
    const skills = listRes.body as Array<{ name: string; isBuiltin: boolean }>;
    const found = skills.find((s) => s.name === "Injected ID Skill");
    expect(found).toBeDefined();
    expect(found?.isBuiltin).toBe(false);
  });
});
