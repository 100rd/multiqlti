/**
 * Integration tests for Skill Teams API (PR #171).
 *
 * Uses MemStorage + synthetic users. Verifies:
 * - GET  /api/skill-teams              — list teams (returns empty + populated)
 * - POST /api/skill-teams              — create team (valid + invalid payloads)
 * - DELETE /api/skill-teams/:id        — delete (owner, admin, non-owner forbidden)
 * - Auth requirement: routes return 401 when no user
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { createServer } from "http";
import type { Express } from "express";
import { MemStorage } from "../../server/storage.js";
import { registerSkillTeamRoutes } from "../../server/routes/skill-teams.js";
import type { User } from "../../shared/types.js";
import type { SkillTeam } from "../../shared/schema.js";

// ─── Users ────────────────────────────────────────────────────────────────────

const ADMIN_USER: User = {
  id: "admin-1",
  email: "admin@test.com",
  name: "Admin",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

const MEMBER_USER: User = {
  id: "member-1",
  email: "member@test.com",
  name: "Member",
  isActive: true,
  role: "member",
  lastLoginAt: null,
  createdAt: new Date(0),
};

const OTHER_MEMBER: User = {
  id: "member-2",
  email: "other@test.com",
  name: "Other",
  isActive: true,
  role: "member",
  lastLoginAt: null,
  createdAt: new Date(0),
};

// ─── App factories ────────────────────────────────────────────────────────────

function createApp(user: User | null, storage: MemStorage) {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }
  registerSkillTeamRoutes(app, storage);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Skill Teams API", () => {
  let storage: MemStorage;
  let adminApp: Express;
  let memberApp: Express;
  let otherMemberApp: Express;
  let noAuthApp: Express;
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    storage = new MemStorage();
    adminApp = createApp(ADMIN_USER, storage);
    memberApp = createApp(MEMBER_USER, storage);
    otherMemberApp = createApp(OTHER_MEMBER, storage);
    noAuthApp = createApp(null, storage);

    const srv = createServer(adminApp);
    closeServer = () => new Promise<void>((r) => srv.close(() => r()));
  }, 15_000);

  afterAll(async () => {
    await closeServer();
  });

  // ─── Auth checks ──────────────────────────────────────────────────────────

  describe("auth requirements", () => {
    it("GET /api/skill-teams → 401 without user", async () => {
      const res = await request(noAuthApp).get("/api/skill-teams");
      expect(res.status).toBe(401);
    });

    it("POST /api/skill-teams → 401 without user", async () => {
      const res = await request(noAuthApp).post("/api/skill-teams").send({ name: "test" });
      expect(res.status).toBe(401);
    });

    it("DELETE /api/skill-teams/:id → 401 without user", async () => {
      const res = await request(noAuthApp).delete("/api/skill-teams/some-id");
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/skill-teams ─────────────────────────────────────────────────

  describe("GET /api/skill-teams", () => {
    it("returns 200 with empty array initially", async () => {
      const freshStorage = new MemStorage();
      const app = createApp(ADMIN_USER, freshStorage);
      const res = await request(app).get("/api/skill-teams");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns all created teams", async () => {
      await storage.createSkillTeam({ name: "Alpha Team", description: "First", createdBy: ADMIN_USER.id });
      await storage.createSkillTeam({ name: "Beta Team", description: "Second", createdBy: MEMBER_USER.id });

      const res = await request(adminApp).get("/api/skill-teams");
      expect(res.status).toBe(200);
      const teams = res.body as SkillTeam[];
      expect(teams.length).toBeGreaterThanOrEqual(2);
      const names = teams.map((t) => t.name);
      expect(names).toContain("Alpha Team");
      expect(names).toContain("Beta Team");
    });

    it("returns teams with expected fields", async () => {
      const res = await request(adminApp).get("/api/skill-teams");
      expect(res.status).toBe(200);
      const teams = res.body as SkillTeam[];
      expect(teams.length).toBeGreaterThan(0);
      const team = teams[0];
      expect(team).toHaveProperty("id");
      expect(team).toHaveProperty("name");
      expect(team).toHaveProperty("description");
      expect(team).toHaveProperty("createdBy");
      expect(team).toHaveProperty("createdAt");
    });
  });

  // ─── POST /api/skill-teams ────────────────────────────────────────────────

  describe("POST /api/skill-teams", () => {
    it("returns 201 with the created team on valid payload", async () => {
      const res = await request(adminApp).post("/api/skill-teams").send({
        name: "QA Team",
        description: "Quality assurance team",
      });
      expect(res.status).toBe(201);
      const body = res.body as SkillTeam;
      expect(body.name).toBe("QA Team");
      expect(body.description).toBe("Quality assurance team");
      expect(body.createdBy).toBe(ADMIN_USER.id);
      expect(body.id).toBeTruthy();
    });

    it("returns 201 with empty description when omitted (uses default)", async () => {
      const res = await request(adminApp).post("/api/skill-teams").send({ name: "No Desc Team" });
      expect(res.status).toBe(201);
      const body = res.body as SkillTeam;
      expect(body.description).toBe("");
    });

    it("returns 400 when name is missing", async () => {
      const res = await request(adminApp).post("/api/skill-teams").send({ description: "No name" });
      expect(res.status).toBe(400);
    });

    it("returns 400 when name is empty string", async () => {
      const res = await request(adminApp).post("/api/skill-teams").send({ name: "", description: "Empty name" });
      expect(res.status).toBe(400);
    });

    it("returns 400 when name exceeds 100 characters", async () => {
      const res = await request(adminApp).post("/api/skill-teams").send({
        name: "x".repeat(101),
        description: "Too long name",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when description exceeds 500 characters", async () => {
      const res = await request(adminApp).post("/api/skill-teams").send({
        name: "Valid Name",
        description: "d".repeat(501),
      });
      expect(res.status).toBe(400);
    });

    it("member user can create a team", async () => {
      const res = await request(memberApp).post("/api/skill-teams").send({
        name: "Member Created Team",
        description: "Created by member",
      });
      expect(res.status).toBe(201);
      const body = res.body as SkillTeam;
      expect(body.createdBy).toBe(MEMBER_USER.id);
    });
  });

  // ─── DELETE /api/skill-teams/:id ─────────────────────────────────────────

  describe("DELETE /api/skill-teams/:id", () => {
    it("returns 404 for unknown team id", async () => {
      const res = await request(adminApp).delete("/api/skill-teams/nonexistent-team-id");
      expect(res.status).toBe(404);
    });

    it("owner can delete their own team", async () => {
      const team = await storage.createSkillTeam({
        name: "Owner Deletable",
        description: "",
        createdBy: MEMBER_USER.id,
      });

      const res = await request(memberApp).delete(`/api/skill-teams/${team.id}`);
      expect(res.status).toBe(204);
    });

    it("admin can delete any team regardless of ownership", async () => {
      const team = await storage.createSkillTeam({
        name: "Admin Can Delete This",
        description: "",
        createdBy: MEMBER_USER.id,
      });

      const res = await request(adminApp).delete(`/api/skill-teams/${team.id}`);
      expect(res.status).toBe(204);
    });

    it("non-owner member cannot delete another member's team (403)", async () => {
      const team = await storage.createSkillTeam({
        name: "Protected Team",
        description: "Only member-1 can delete",
        createdBy: MEMBER_USER.id,
      });

      const res = await request(otherMemberApp).delete(`/api/skill-teams/${team.id}`);
      expect(res.status).toBe(403);
      expect((res.body as { error: string }).error).toContain("Forbidden");
    });

    it("confirms deletion — deleted team no longer appears in list", async () => {
      const team = await storage.createSkillTeam({
        name: "Will Be Gone",
        description: "",
        createdBy: ADMIN_USER.id,
      });

      await request(adminApp).delete(`/api/skill-teams/${team.id}`).expect(204);

      const listRes = await request(adminApp).get("/api/skill-teams");
      const teams = listRes.body as SkillTeam[];
      expect(teams.find((t) => t.id === team.id)).toBeUndefined();
    });
  });
});
