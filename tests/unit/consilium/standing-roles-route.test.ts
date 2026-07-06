/**
 * standing-roles-route.test.ts — ROLE-1 (standing-role.md §3/§8).
 *
 * Covers the StandingRole CRUD + manual wake surface:
 *   - CRUD (create / list / get / update / delete) against a fake project-scoped storage.
 *   - AUTH: a handler with no `req.user` → 401 (the /api/pr-queue 401 lesson — the route
 *     re-checks auth as defense-in-depth even though the mount applies requireAuth).
 *   - WAKE composes the CORRECT review payload FROM the role (persona+focus instruction,
 *     skills, loop template) and passes it to the REUSED `createConsiliumReview` factory.
 *   - WAKE records ROLE provenance on the loop's triggerProvenance.
 *   - WAKE surfaces the factory's fail-closed allowlist rejection as an actionable 400.
 *   - Skills are validated against the registry at CREATE (unknown id → 400, no persist).
 *   - A DISABLED role cannot wake (409, factory NEVER called).
 *
 * The factory is mocked (same resolved module the route imports) — we assert the route's
 * COMPOSITION + wiring, not the factory internals (covered by review-factory.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../../server/services/consilium/review-factory.js", () => ({
  createConsiliumReview: vi.fn(),
}));

import {
  registerStandingRoleRoutes,
  composeWakeInstruction,
} from "../../../server/routes/standing-roles.js";
import { createConsiliumReview } from "../../../server/services/consilium/review-factory.js";

const mockedCreate = vi.mocked(createConsiliumReview);

// ─── Fake project-scoped storage (only the methods the route touches) ─────────

interface FakeRole {
  id: string;
  projectId: string | null;
  name: string;
  persona: string;
  skills: string[];
  loopTemplate: { preset: string; maxRounds?: number; reviewMode?: string };
  enabled: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeStorage(seed: FakeRole[] = [], knownSkills: string[] = []) {
  const roles = new Map<string, FakeRole>();
  seed.forEach((r) => roles.set(r.id, r));
  const skillSet = new Set(knownSkills);
  let seq = seed.length;
  return {
    getStandingRoles: vi.fn(async () => Array.from(roles.values())),
    getStandingRole: vi.fn(async (id: string) => roles.get(id)),
    createStandingRole: vi.fn(async (data: Partial<FakeRole>) => {
      seq += 1;
      const row: FakeRole = {
        id: `role-${seq}`,
        projectId: "project-1",
        name: data.name ?? "",
        persona: data.persona ?? "",
        skills: data.skills ?? [],
        loopTemplate: data.loopTemplate ?? { preset: "sdlc-cross-review" },
        enabled: data.enabled ?? true,
        createdBy: data.createdBy ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      roles.set(row.id, row);
      return row;
    }),
    updateStandingRole: vi.fn(async (id: string, updates: Partial<FakeRole>) => {
      const ex = roles.get(id);
      if (!ex) throw new Error(`Standing role not found: ${id}`);
      const up = { ...ex, ...updates, updatedAt: new Date() };
      roles.set(id, up);
      return up;
    }),
    deleteStandingRole: vi.fn(async (id: string) => {
      roles.delete(id);
    }),
    getSkill: vi.fn(async (id: string) => (skillSet.has(id) ? { id, name: id } : undefined)),
    _roles: roles,
  };
}

function makeApp(storage: ReturnType<typeof makeStorage>, opts?: { auth?: boolean }) {
  const app = express();
  app.use(express.json());
  if (opts?.auth !== false) {
    app.use((req, _res, next) => {
      (req as unknown as { user: { id: string } }).user = { id: "user-1" };
      (req as unknown as { projectId: string }).projectId = "project-1";
      next();
    });
  }
  registerStandingRoleRoutes(app, { storage } as never);
  return app;
}

function seedRole(over: Partial<FakeRole> = {}): FakeRole {
  return {
    id: "role-1",
    projectId: "project-1",
    name: "devops-reviewer",
    persona: "You are a senior DevOps reviewer.",
    skills: ["sk-1"],
    loopTemplate: { preset: "sdlc-cross-review", maxRounds: 3, reviewMode: "single-verifier" },
    enabled: true,
    createdBy: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

const VALID_CREATE = {
  name: "devops-reviewer",
  persona: "You are a senior DevOps reviewer.",
  skills: ["sk-1"],
  loopTemplate: { preset: "sdlc-cross-review", maxRounds: 3, reviewMode: "single-verifier" },
};

// ─── composeWakeInstruction (pure) ────────────────────────────────────────────

describe("composeWakeInstruction", () => {
  it("joins persona + focus under a Focus heading (fencing is the factory's job)", () => {
    expect(composeWakeInstruction("PERSONA", "FOCUS")).toBe("PERSONA\n\n## Focus\nFOCUS");
  });
});

// ─── CRUD ─────────────────────────────────────────────────────────────────────

describe("StandingRole CRUD", () => {
  beforeEach(() => mockedCreate.mockReset());

  it("POST /api/roles creates a role (201) with the caller as owner", async () => {
    const storage = makeStorage([], ["sk-1"]);
    const res = await request(makeApp(storage)).post("/api/roles").send(VALID_CREATE);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("devops-reviewer");
    expect(storage.createStandingRole).toHaveBeenCalledTimes(1);
    expect(storage.createStandingRole.mock.calls[0][0]).toMatchObject({ createdBy: "user-1" });
  });

  it("GET /api/roles lists the project's roles", async () => {
    const storage = makeStorage([seedRole()]);
    const res = await request(makeApp(storage)).get("/api/roles");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("devops-reviewer");
  });

  it("GET /api/roles/:id returns 404 for an unknown id", async () => {
    const res = await request(makeApp(makeStorage())).get("/api/roles/nope");
    expect(res.status).toBe(404);
  });

  it("PATCH /api/roles/:id updates a role", async () => {
    const storage = makeStorage([seedRole()], ["sk-1"]);
    const res = await request(makeApp(storage)).patch("/api/roles/role-1").send({ name: "renamed" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("renamed");
  });

  it("DELETE /api/roles/:id removes a role (204)", async () => {
    const storage = makeStorage([seedRole()]);
    const res = await request(makeApp(storage)).delete("/api/roles/role-1");
    expect(res.status).toBe(204);
    expect(storage.deleteStandingRole).toHaveBeenCalledWith("role-1");
  });

  it("CREATE fails-closed on a skill id that is NOT in the project registry (400, no persist)", async () => {
    const storage = makeStorage([], []); // registry empty ⇒ sk-1 unknown
    const res = await request(makeApp(storage)).post("/api/roles").send(VALID_CREATE);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sk-1/);
    expect(res.body.error).toMatch(/was not found in this project/);
    expect(storage.createStandingRole).not.toHaveBeenCalled();
  });
});

// ─── AUTH (the /api/pr-queue 401 lesson) ──────────────────────────────────────

describe("StandingRole routes — auth guard", () => {
  it("GET /api/roles without an authenticated user → 401", async () => {
    const res = await request(makeApp(makeStorage(), { auth: false })).get("/api/roles");
    expect(res.status).toBe(401);
  });

  it("POST /api/roles/:id/wake without auth → 401 (factory never called)", async () => {
    mockedCreate.mockReset();
    const storage = makeStorage([seedRole()], ["sk-1"]);
    const res = await request(makeApp(storage, { auth: false }))
      .post("/api/roles/role-1/wake")
      .send({ repoPath: "/repos/x", focus: "f" });
    expect(res.status).toBe(401);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});

// ─── WAKE ─────────────────────────────────────────────────────────────────────

describe("POST /api/roles/:id/wake", () => {
  beforeEach(() => mockedCreate.mockReset());

  it("composes the review payload FROM the role and returns 201 with the loop", async () => {
    mockedCreate.mockResolvedValueOnce({ id: "loop-1", state: "pending" } as never);
    const storage = makeStorage([seedRole()], ["sk-1"]);
    const res = await request(makeApp(storage))
      .post("/api/roles/role-1/wake")
      .send({ repoPath: "/repos/iac", focus: "Review the new module version" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("loop-1");
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    const params = mockedCreate.mock.calls[0][1] as Record<string, unknown>;
    expect(params).toMatchObject({
      projectId: "project-1",
      repoPath: "/repos/iac",
      preset: "sdlc-cross-review",
      createdBy: "user-1",
      maxRounds: 3,
      reviewMode: "single-verifier",
      skillIds: ["sk-1"],
      engineerInstruction: "You are a senior DevOps reviewer.\n\n## Focus\nReview the new module version",
    });
  });

  it("records ROLE provenance on the loop (roleId + name)", async () => {
    mockedCreate.mockResolvedValueOnce({ id: "loop-1" } as never);
    const storage = makeStorage([seedRole()], ["sk-1"]);
    await request(makeApp(storage))
      .post("/api/roles/role-1/wake")
      .send({ repoPath: "/repos/iac", focus: "f" });

    const params = mockedCreate.mock.calls[0][1] as { triggerProvenance?: { role?: unknown; firedAt?: string } };
    expect(params.triggerProvenance?.role).toEqual({ roleId: "role-1", name: "devops-reviewer" });
    expect(typeof params.triggerProvenance?.firedAt).toBe("string");
  });

  it("a DISABLED role cannot wake → 409, factory NEVER called (§6 safety)", async () => {
    const storage = makeStorage([seedRole({ enabled: false })], ["sk-1"]);
    const res = await request(makeApp(storage))
      .post("/api/roles/role-1/wake")
      .send({ repoPath: "/repos/iac", focus: "f" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/disabled/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("maps the factory's fail-closed allowlist rejection to an actionable 400", async () => {
    mockedCreate.mockRejectedValueOnce(
      new Error('[repo-allowlist] Path "/repos/evil" is outside every allowed repo root'),
    );
    const storage = makeStorage([seedRole()], ["sk-1"]);
    const res = await request(makeApp(storage))
      .post("/api/roles/role-1/wake")
      .send({ repoPath: "/repos/evil", focus: "f" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/is not in the allowed repo paths/i);
  });

  it("maps a factory skill-not-found (skill deleted after role save) to a 400 naming the id", async () => {
    mockedCreate.mockRejectedValueOnce(
      new Error('[skill-not-found] skill "sk-1" was not found in this project'),
    );
    const storage = makeStorage([seedRole()], ["sk-1"]);
    const res = await request(makeApp(storage))
      .post("/api/roles/role-1/wake")
      .send({ repoPath: "/repos/iac", focus: "f" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sk-1/);
    expect(res.body.error).not.toMatch(/\[skill-not-found\]/);
  });

  it("waking an unknown role → 404 (factory never called)", async () => {
    const res = await request(makeApp(makeStorage()))
      .post("/api/roles/ghost/wake")
      .send({ repoPath: "/repos/iac", focus: "f" });
    expect(res.status).toBe(404);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});
