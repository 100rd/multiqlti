/**
 * Cross-project HTTP isolation tests (ADR-001 PR-0f, item 4)
 *
 * Proves that the `requireProject` middleware correctly enforces project
 * membership at the HTTP boundary:
 *
 *   1. Missing x-project-id → 400 (not duplicated from require-project-middleware.test.ts;
 *      included here only as a sanity anchor for the test app setup).
 *   2. Project does not exist → 404.
 *   3. User is a member of project A but NOT of project B → 403 on project B.
 *   4. User IS a member (non-owner) of project A → 200, context set to project A.
 *   5. User IS the owner of project A → 200, context set to project A.
 *   6. Successful request sets ALS context to the x-project-id value — downstream
 *      handlers can only see that project's ID (data-isolation proof at context level).
 *   7. After a 403 on project B, a subsequent valid request for project A succeeds
 *      and sets context to project A — 403 does NOT corrupt or bleed state.
 *
 * Strategy: build a minimal express app mirroring the requireAuth → requireProject
 * chain.  The db module is mocked so the tests are DB-free; `projects` and
 * `project_members` table queries return controlled payloads.  The real
 * requestContext (ALS) and requireProject logic are exercised.
 *
 * NOTE: the 400-without-header matrix for every scoped route is already in
 * tests/integration/require-project-middleware.test.ts.  This file focuses on
 * the 403 membership case and the data-isolation (context-value) proof.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import type { User } from "../../shared/types.js";

// ─── Mutable store controlled by tests ────────────────────────────────────────
//
// vi.hoisted() ensures these values are available inside the vi.mock() factory
// (both are hoisted above the module graph).  Tests mutate .value between calls.

const STORE = vi.hoisted(() => ({
  projectsRows: [] as unknown[],
  membersRows: [] as unknown[],
}));

// ─── Mock the db module so requireProject makes no real DB calls ──────────────
//
// requireProject calls:
//   db.select().from(projects).where(…).limit(1)   → determines if project exists + ownerId
//   db.select().from(projectMembers).where(…).limit(1) → determines if user is a member
//
// We route the mock responses by table name (drizzle's BaseName symbol).

vi.mock("../../server/db.js", () => {
  const TABLE_NAME = Symbol.for("drizzle:BaseName");

  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () => {
              const name = (table as Record<symbol, string>)[TABLE_NAME];
              if (name === "projects") return Promise.resolve(STORE.projectsRows);
              if (name === "project_members") return Promise.resolve(STORE.membersRows);
              return Promise.resolve([]);
            },
          }),
        }),
      }),
    },
    pool: { on: () => {} },
    // withProject / withProjectInsert are not called by requireProject itself —
    // they are route-handler concerns.  Expose no-op stubs.
    withProject: (_t: unknown, cond?: unknown) => cond ?? {},
    withProjectInsert: (_t: unknown, data: unknown) => data,
    runMigrations: async () => {},
  };
});

// ─── Synthetic users ──────────────────────────────────────────────────────────

const USER_A: User = {
  id: "user-a",
  email: "a@example.com",
  name: "User A",
  isActive: true,
  role: "user",
  lastLoginAt: null,
  createdAt: new Date(0),
};

// PROJECT_A is owned by USER_A.  USER_A has NO membership in PROJECT_B.
const PROJECT_A = { id: "proj-a", name: "Project A", ownerId: "user-a", createdAt: new Date(0), updatedAt: new Date(0) };
const PROJECT_B = { id: "proj-b", name: "Project B", ownerId: "user-b", createdAt: new Date(0), updatedAt: new Date(0) };

/** Injects USER_A as the authenticated user on every request. */
function injectUserA(req: Request, _res: Response, next: NextFunction) {
  req.user = USER_A;
  next();
}

/** A stub handler that returns the project context it sees — isolation proof. */
async function contextEchoHandler(req: Request, res: Response) {
  // Import context here to avoid module-graph issues at test-app build time.
  const { getProjectId } = await import("../../server/context.js");
  try {
    const projectId = getProjectId();
    res.json({ ok: true, projectId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ─── Build the test express app ───────────────────────────────────────────────

let app: Express;

beforeAll(async () => {
  const { requireProject } = await import("../../server/middleware/project.js");

  app = express();
  app.use(express.json());
  app.use(injectUserA);

  // Mount a scoped router that mirrors the requireAuth → requireProject chain.
  // The context-echo handler returns the projectId from ALS for isolation verification.
  const router = express.Router();
  router.use(requireProject as express.RequestHandler);
  router.get("/data", contextEchoHandler as express.RequestHandler);
  app.use("/api/pipelines", router);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("HTTP middleware — 400 on missing x-project-id (sanity check)", () => {
  it("scoped route returns 400 when x-project-id header is absent", async () => {
    const res = await request(app).get("/api/pipelines/data");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("x-project-id") });
  });
});

describe("HTTP middleware — 404 when project does not exist", () => {
  it("x-project-id refers to a non-existent project → 404", async () => {
    STORE.projectsRows = []; // empty: project not found
    STORE.membersRows = [];

    const res = await request(app)
      .get("/api/pipelines/data")
      .set("x-project-id", "proj-nonexistent");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Project not found") });
  });
});

describe("HTTP middleware — 403 cross-project membership check", () => {
  it("user-A (member of proj-a, NOT proj-b) gets 403 when sending x-project-id: proj-b", async () => {
    // Project B exists, but USER_A is not a member (not an owner either).
    STORE.projectsRows = [PROJECT_B];
    STORE.membersRows = []; // USER_A has no membership in proj-b

    const res = await request(app)
      .get("/api/pipelines/data")
      .set("x-project-id", "proj-b");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Access denied") });
  });

  it("403 response does not leak any of project B's data in the body", async () => {
    STORE.projectsRows = [PROJECT_B];
    STORE.membersRows = [];

    const res = await request(app)
      .get("/api/pipelines/data")
      .set("x-project-id", "proj-b");

    expect(res.status).toBe(403);
    // The body must not contain project-B data
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("proj-b data");
    expect(body).not.toContain("proj-b secret");
  });
});

describe("HTTP middleware — 200 with valid membership, context set correctly", () => {
  it("user-A as owner of proj-a gets 200 and ALS context is set to proj-a", async () => {
    // USER_A owns PROJECT_A → owner branch in requireProject fires.
    STORE.projectsRows = [PROJECT_A];
    STORE.membersRows = []; // ownership check succeeds before member check

    const res = await request(app)
      .get("/api/pipelines/data")
      .set("x-project-id", "proj-a");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, projectId: "proj-a" });
  });

  it("user-A as a non-owner member of proj-a gets 200 and ALS context is set to proj-a", async () => {
    // USER_A is not the owner but is a member (e.g. another user owns the project).
    const otherUserProject = { ...PROJECT_A, ownerId: "user-c" };
    STORE.projectsRows = [otherUserProject];
    STORE.membersRows = [{ projectId: "proj-a", userId: "user-a", role: "editor" }];

    const res = await request(app)
      .get("/api/pipelines/data")
      .set("x-project-id", "proj-a");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, projectId: "proj-a" });
  });

  it("ALS context value matches exactly the x-project-id sent in the header", async () => {
    STORE.projectsRows = [PROJECT_A];
    STORE.membersRows = [];

    const res = await request(app)
      .get("/api/pipelines/data")
      .set("x-project-id", "proj-a");

    // The handler reads getProjectId() from ALS — must equal the header value.
    expect(res.body.projectId).toBe("proj-a");
  });
});

describe("HTTP middleware — 403 does not corrupt subsequent successful requests", () => {
  it("after a 403 on proj-b, a valid request for proj-a succeeds with correct context", async () => {
    // First request: 403 on proj-b
    STORE.projectsRows = [PROJECT_B];
    STORE.membersRows = [];
    const failRes = await request(app)
      .get("/api/pipelines/data")
      .set("x-project-id", "proj-b");
    expect(failRes.status).toBe(403);

    // Second request: 200 on proj-a — context must be proj-a, not contaminated.
    STORE.projectsRows = [PROJECT_A];
    STORE.membersRows = [];
    const successRes = await request(app)
      .get("/api/pipelines/data")
      .set("x-project-id", "proj-a");
    expect(successRes.status).toBe(200);
    expect(successRes.body.projectId).toBe("proj-a");
  });
});
