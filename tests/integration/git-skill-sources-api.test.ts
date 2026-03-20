/**
 * Integration tests for Git Skill Sources API (issue #161).
 *
 * Routes use db directly — we mock the db module and crypto.
 *
 * Tests:
 * - POST /api/skills/git-sources → 201 (admin)
 * - GET  /api/skills/git-sources → list
 * - DELETE /api/skills/git-sources/:id → 204
 * - POST /api/skills/git-sources/:id/sync → 202
 * - POST /api/skills/git-sources/:id/pat → 204
 * - Auth: non-admin gets 403 on mutating routes
 * - Auth: unauthenticated gets 401
 * - URL validation: rejects file:// scheme
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createServer } from "http";
import type { Express } from "express";
import type { User } from "../../shared/types.js";

// ─── Synthetic Users ──────────────────────────────────────────────────────────

const ADMIN_USER: User = {
  id: "admin-1",
  email: "admin@test.com",
  name: "Admin",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

const REGULAR_USER: User = {
  id: "user-1",
  email: "user@test.com",
  name: "User",
  isActive: true,
  role: "user",
  lastLoginAt: null,
  createdAt: new Date(0),
};

// ─── In-memory "DB" store ────────────────────────────────────────────────────

// We keep a simple array to simulate the DB for these tests
const sourcesStore: Array<{
  id: string;
  name: string;
  repoUrl: string;
  branch: string;
  path: string;
  syncOnStart: boolean;
  lastSyncedAt: Date | null;
  lastError: string | null;
  encryptedPat: string | null;
  createdBy: string;
  createdAt: Date;
}> = [];

const skillsStore: Array<{ id: string; gitSourceId: string | null }> = [];

let idCounter = 1;

vi.mock("../../server/db.js", () => {
  // Reusable promise-like that supports .groupBy()
  function queryResult(rows: unknown[]) {
    const p = Promise.resolve(rows) as Promise<unknown[]> & { groupBy: () => Promise<unknown[]>; orderBy: () => Promise<unknown[]> };
    p.groupBy = () => Promise.resolve([]);
    p.orderBy = () => Promise.resolve(rows);
    return p;
  }

  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          orderBy: () => queryResult([...sourcesStore]),
          where: (condition: unknown) => queryResult([...sourcesStore]),
        }),
      }),
      insert: (table: unknown) => ({
        values: (data: Record<string, unknown>) => ({
          returning: () => {
            const row = {
              id: `source-${idCounter++}`,
              name: data.name as string,
              repoUrl: data.repoUrl as string,
              branch: (data.branch as string) ?? "main",
              path: (data.path as string) ?? "/",
              syncOnStart: (data.syncOnStart as boolean) ?? false,
              lastSyncedAt: null,
              lastError: null,
              encryptedPat: null,
              createdBy: data.createdBy as string,
              createdAt: new Date(),
            };
            sourcesStore.push(row);
            return [row];
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => Promise.resolve(),
        }),
      }),
      delete: () => ({
        where: () => {
          // Simple mock — just clear from sourcesStore
          return Promise.resolve();
        },
      }),
    },
  };
});

vi.mock("../../server/crypto.js", () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ""),
}));

// Mock the sync service so it doesn't try to git clone in tests
vi.mock("../../server/services/git-skill-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/services/git-skill-sync.js")>();
  return {
    ...actual,
    syncGitSkillSource: vi.fn().mockResolvedValue(undefined),
  };
});

// ─── App Factory ──────────────────────────────────────────────────────────────

function createApp(user: User | null): Express {
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Git Skill Sources API", () => {
  let adminApp: Express;
  let userApp: Express;
  let anonApp: Express;
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    const { registerGitSkillSourceRoutes } = await import(
      "../../server/routes/git-skill-sources.js"
    );

    adminApp = createApp(ADMIN_USER);
    registerGitSkillSourceRoutes(adminApp);

    userApp = createApp(REGULAR_USER);
    registerGitSkillSourceRoutes(userApp);

    anonApp = createApp(null);
    registerGitSkillSourceRoutes(anonApp);

    const httpServer = createServer(adminApp);
    closeServer = () => new Promise<void>((r) => httpServer.close(() => r()));

    // Clear store before tests
    sourcesStore.length = 0;
  }, 15_000);

  afterAll(async () => {
    await closeServer();
  });

  // ─── POST /api/skills/git-sources ─────────────────────────────────────────

  describe("POST /api/skills/git-sources", () => {
    it("admin can create a source → 201", async () => {
      const res = await request(adminApp)
        .post("/api/skills/git-sources")
        .send({
          name: "Test Library",
          repoUrl: "https://github.com/org/skills.git",
          branch: "main",
          path: "/skills",
        });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: "Test Library",
        repoUrl: "https://github.com/org/skills.git",
        branch: "main",
        path: "/skills",
      });
      // PAT should never appear in response
      expect(res.body).not.toHaveProperty("encryptedPat");
    });

    it("rejects file:// URL → 400", async () => {
      const res = await request(adminApp)
        .post("/api/skills/git-sources")
        .send({
          name: "Bad Source",
          repoUrl: "file:///etc/passwd",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid repo URL");
    });

    it("rejects git:// URL → 400", async () => {
      const res = await request(adminApp)
        .post("/api/skills/git-sources")
        .send({
          name: "Bad Source",
          repoUrl: "git://github.com/org/repo.git",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid repo URL");
    });

    it("rejects missing name → 400", async () => {
      const res = await request(adminApp)
        .post("/api/skills/git-sources")
        .send({
          repoUrl: "https://github.com/org/repo.git",
        });

      expect(res.status).toBe(400);
    });

    it("rejects path with .. → 400", async () => {
      const res = await request(adminApp)
        .post("/api/skills/git-sources")
        .send({
          name: "Traversal",
          repoUrl: "https://github.com/org/repo.git",
          path: "../../etc",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("..");
    });

    it("non-admin gets 403", async () => {
      const res = await request(userApp)
        .post("/api/skills/git-sources")
        .send({
          name: "Test",
          repoUrl: "https://github.com/org/repo.git",
        });

      expect(res.status).toBe(403);
    });

    it("unauthenticated gets 401", async () => {
      const res = await request(anonApp)
        .post("/api/skills/git-sources")
        .send({
          name: "Test",
          repoUrl: "https://github.com/org/repo.git",
        });

      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/skills/git-sources ──────────────────────────────────────────

  describe("GET /api/skills/git-sources", () => {
    it("returns list of sources → 200", async () => {
      const res = await request(adminApp).get("/api/skills/git-sources");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // Each item should have skillCount
      for (const item of res.body as Array<Record<string, unknown>>) {
        expect(item).toHaveProperty("skillCount");
        expect(item).not.toHaveProperty("encryptedPat");
      }
    });

    it("unauthenticated gets 401", async () => {
      const res = await request(anonApp).get("/api/skills/git-sources");
      expect(res.status).toBe(401);
    });
  });

  // ─── POST /api/skills/git-sources/:id/sync ────────────────────────────────

  describe("POST /api/skills/git-sources/:id/sync", () => {
    it("admin can trigger sync → 202", async () => {
      // Ensure there's a source in the store
      sourcesStore.length = 0;
      sourcesStore.push({
        id: "source-test",
        name: "Sync Test",
        repoUrl: "https://github.com/org/repo.git",
        branch: "main",
        path: "/",
        syncOnStart: false,
        lastSyncedAt: null,
        lastError: null,
        encryptedPat: null,
        createdBy: "admin-1",
        createdAt: new Date(),
      });

      const res = await request(adminApp).post("/api/skills/git-sources/source-test/sync");
      expect(res.status).toBe(202);
      expect(res.body.message).toBeDefined();
    });

    it("non-admin gets 403", async () => {
      const res = await request(userApp).post("/api/skills/git-sources/source-test/sync");
      expect(res.status).toBe(403);
    });
  });

  // ─── POST /api/skills/git-sources/:id/pat ─────────────────────────────────

  describe("POST /api/skills/git-sources/:id/pat", () => {
    it("admin can set PAT → 204", async () => {
      // Ensure source exists
      if (!sourcesStore.find((s) => s.id === "source-test")) {
        sourcesStore.push({
          id: "source-test",
          name: "PAT Test",
          repoUrl: "https://github.com/org/private.git",
          branch: "main",
          path: "/",
          syncOnStart: false,
          lastSyncedAt: null,
          lastError: null,
          encryptedPat: null,
          createdBy: "admin-1",
          createdAt: new Date(),
        });
      }

      const res = await request(adminApp)
        .post("/api/skills/git-sources/source-test/pat")
        .send({ pat: "ghp_test_token_123" });

      expect(res.status).toBe(204);
    });

    it("rejects empty PAT → 400", async () => {
      const res = await request(adminApp)
        .post("/api/skills/git-sources/source-test/pat")
        .send({ pat: "" });

      expect(res.status).toBe(400);
    });

    it("non-admin gets 403", async () => {
      const res = await request(userApp)
        .post("/api/skills/git-sources/source-test/pat")
        .send({ pat: "token123" });

      expect(res.status).toBe(403);
    });
  });

  // ─── DELETE /api/skills/git-sources/:id ───────────────────────────────────

  describe("DELETE /api/skills/git-sources/:id", () => {
    it("admin can delete a source → 204", async () => {
      // Add source to delete
      sourcesStore.push({
        id: "source-to-delete",
        name: "Delete Me",
        repoUrl: "https://github.com/org/repo.git",
        branch: "main",
        path: "/",
        syncOnStart: false,
        lastSyncedAt: null,
        lastError: null,
        encryptedPat: null,
        createdBy: "admin-1",
        createdAt: new Date(),
      });

      const res = await request(adminApp).delete("/api/skills/git-sources/source-to-delete");
      expect(res.status).toBe(204);
    });

    it("returns 404 when store is empty", async () => {
      // Clear the store so where() returns empty array → 404
      const saved = [...sourcesStore];
      sourcesStore.length = 0;
      const res = await request(adminApp).delete("/api/skills/git-sources/nonexistent-id");
      // Restore
      sourcesStore.push(...saved);
      expect(res.status).toBe(404);
    });

    it("non-admin gets 403", async () => {
      const res = await request(userApp).delete("/api/skills/git-sources/source-test");
      expect(res.status).toBe(403);
    });
  });
});
