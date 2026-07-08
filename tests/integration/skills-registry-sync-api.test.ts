/**
 * Integration tests for POST /api/skills/registry-sync (issue #446, task 52.1).
 *
 * Two test apps:
 *  - `authApp` mounts the REAL requireAuth middleware in front of the skills
 *    routes (mirroring server/routes.ts:145) to prove the route returns 401
 *    when unauthenticated -- it has no synthetic-admin bypass.
 *  - `bypassApp` injects a synthetic admin (matching the existing
 *    tests/integration/skills-api.test.ts convention) so sync/drift/guard
 *    behavior can be exercised without a real auth token or DB-backed
 *    requireProject middleware.
 *
 * configLoader.get() is spied to point pipeline.consiliumLoop.allowedRepoPaths
 * at the fixture registry root -- config.yaml itself is never touched.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createServer } from "http";
import fs from "fs/promises";
import path from "path";
import { MemStorage } from "../../server/storage.js";
import { registerSkillRoutes } from "../../server/routes/skills.js";
import { requireAuth } from "../../server/auth/middleware.js";
import { configLoader } from "../../server/config/loader.js";
import type { User } from "../../shared/types.js";

const FIXTURE_ROOT = path.join(__dirname, "..", "fixtures", "registry-sync");

const TEST_ADMIN: User = {
  id: "test-admin-id",
  email: "admin@test.com",
  name: "Test Admin",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

describe("POST /api/skills/registry-sync", () => {
  let registryRoot: string;
  let authApp: express.Express;
  let bypassApp: express.Express;
  let bypassStorage: MemStorage;
  let closeServers: Array<() => Promise<void>>;

  beforeAll(async () => {
    registryRoot = await fs.realpath(FIXTURE_ROOT);

    // Point the (fail-closed) consilium-loop allowlist at the fixture root so
    // the sync route's path confinement accepts it, without touching config.yaml.
    vi.spyOn(configLoader, "get").mockReturnValue({
      ...configLoader.get(),
      pipeline: {
        ...configLoader.get().pipeline,
        consiliumLoop: {
          ...configLoader.get().pipeline.consiliumLoop,
          allowedRepoPaths: [registryRoot],
        },
      },
    });

    closeServers = [];

    // ── authApp: real requireAuth, no bypass ──────────────────────────────
    authApp = express();
    authApp.use(express.json());
    authApp.use("/api/skills", requireAuth);
    registerSkillRoutes(authApp, new MemStorage());
    const authServer = createServer(authApp);
    closeServers.push(() => new Promise<void>((r) => authServer.close(() => r())));

    // ── bypassApp: synthetic admin injected (matches skills-api.test.ts) ──
    bypassStorage = new MemStorage();
    bypassApp = express();
    bypassApp.use(express.json());
    bypassApp.use((req, _res, next) => {
      req.user = TEST_ADMIN;
      next();
    });
    registerSkillRoutes(bypassApp, bypassStorage);
    const bypassServer = createServer(bypassApp);
    closeServers.push(() => new Promise<void>((r) => bypassServer.close(() => r())));
  }, 15_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await Promise.all(closeServers.map((close) => close()));
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request(authApp)
      .post("/api/skills/registry-sync")
      .send({ registryRoot, teamId: "team-a" });

    expect(res.status).toBe(401);
  });

  it("400s on an invalid body (missing teamId)", async () => {
    const res = await request(bypassApp)
      .post("/api/skills/registry-sync")
      .send({ registryRoot });

    expect(res.status).toBe(400);
  });

  it("syncs compatible skills and reports per-skill results, including drift", async () => {
    const res = await request(bypassApp)
      .post("/api/skills/registry-sync")
      .send({ registryRoot, teamId: "team-a" });

    expect(res.status).toBe(200);
    expect(res.body.registryRoot).toBe(registryRoot);

    const byKey = Object.fromEntries(
      (res.body.results as Array<{ skillKey: string; status: string; reason?: string }>).map(
        (r) => [r.skillKey, r],
      ),
    );

    expect(byKey["demo-skill"].status).toBe("synced");
    expect(byKey["other-tool-skill"].status).toBe("skipped");
    expect(byKey["drifted-skill"].status).toBe("drift");
    expect(byKey["drifted-skill"].reason).toMatch(/sha256 mismatch/);

    // Synced row landed in storage and is immutable via the normal API.
    const skills = await bypassStorage.getSkills({ teamId: "team-a" });
    const demo = skills.find((s) => s.name === "demo-skill");
    expect(demo).toBeDefined();
    expect(demo!.sourceType).toBe("git");

    const patchRes = await request(bypassApp)
      .patch(`/api/skills/${demo!.id}`)
      .send({ description: "attempted edit" });
    expect(patchRes.status).toBe(403);
    expect(patchRes.body.error).toMatch(/git-sourced/);

    const deleteRes = await request(bypassApp).delete(`/api/skills/${demo!.id}`);
    expect(deleteRes.status).toBe(403);
    expect(deleteRes.body.error).toMatch(/git-sourced/);
  });

  it("400s when registryRoot is outside the configured allowlist", async () => {
    const res = await request(bypassApp)
      .post("/api/skills/registry-sync")
      .send({ registryRoot: "/tmp/definitely-not-allowed", teamId: "team-a" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});
