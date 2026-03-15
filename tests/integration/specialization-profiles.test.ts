/**
 * Integration tests — Specialization Profiles API (Phase 5)
 *
 * GET  /api/specialization-profiles — returns built-ins + user-defined
 * POST /api/specialization-profiles — creates user-defined profile
 * DELETE /api/specialization-profiles/:id — deletes user profile; 403 for built-ins
 */
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { MemStorage } from "../../server/storage.js";
import { registerSpecializationRoutes } from "../../server/routes/specialization.js";
import type { User } from "../../shared/types.js";

const TEST_USER: User = {
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
  isActive: true,
  role: "user",
  lastLoginAt: null,
  createdAt: new Date(),
};

function createApp() {
  const storage = new MemStorage();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = TEST_USER; next(); });
  registerSpecializationRoutes(app, storage);
  return { app, storage };
}

describe("GET /api/specialization-profiles", () => {
  it("returns built-in presets when no user profiles exist", async () => {
    const { app } = createApp();
    const res = await request(app).get("/api/specialization-profiles");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const ids = (res.body as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain("balanced");
    expect(ids).toContain("claude-only");
    expect(ids).toContain("gemini-only");
    expect(ids).toContain("grok-only");
    expect(ids).toContain("provider-strengths");
  });

  it("includes user-defined profiles alongside built-ins", async () => {
    const { app, storage } = createApp();
    await storage.createSpecializationProfile({
      name: "My Custom Preset",
      isBuiltIn: false,
      assignments: { planning: "claude-3-5-sonnet" },
    });
    const res = await request(app).get("/api/specialization-profiles");
    expect(res.status).toBe(200);
    const names = (res.body as Array<{ name: string }>).map((p) => p.name);
    expect(names).toContain("My Custom Preset");
  });
});

describe("POST /api/specialization-profiles", () => {
  it("creates a user-defined profile", async () => {
    const { app } = createApp();
    const res = await request(app)
      .post("/api/specialization-profiles")
      .send({ name: "Team Claude", assignments: { planning: "claude-3-5-sonnet", development: "claude-3-5-sonnet" } });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Team Claude");
    expect(res.body.isBuiltIn).toBe(false);
    expect(res.body.assignments.planning).toBe("claude-3-5-sonnet");
  });

  it("strips HTML from the name", async () => {
    const { app } = createApp();
    const res = await request(app)
      .post("/api/specialization-profiles")
      .send({ name: "<script>alert(1)</script>Nice Preset", assignments: {} });
    expect(res.status).toBe(201);
    expect(res.body.name).not.toContain("<script>");
    expect(res.body.name).toContain("Nice Preset");
  });

  it("rejects empty name", async () => {
    const { app } = createApp();
    const res = await request(app)
      .post("/api/specialization-profiles")
      .send({ name: "", assignments: {} });
    expect(res.status).toBe(400);
  });

  it("rejects name longer than 100 chars", async () => {
    const { app } = createApp();
    const res = await request(app)
      .post("/api/specialization-profiles")
      .send({ name: "x".repeat(101), assignments: {} });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/specialization-profiles/:id", () => {
  it("deletes a user-defined profile", async () => {
    const { app, storage } = createApp();
    const created = await storage.createSpecializationProfile({
      name: "To Delete",
      isBuiltIn: false,
      assignments: {},
    });
    const res = await request(app).delete(`/api/specialization-profiles/${created.id}`);
    expect(res.status).toBe(204);
  });

  it("returns 403 when trying to delete a built-in preset", async () => {
    const { app } = createApp();
    const res = await request(app).delete("/api/specialization-profiles/balanced");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/built-in/i);
  });

  it("returns 404 when profile does not exist", async () => {
    const { app } = createApp();
    const res = await request(app).delete("/api/specialization-profiles/nonexistent-id");
    expect(res.status).toBe(404);
  });
});
