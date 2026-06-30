/**
 * consilium-loops-develop-route.test.ts — POST /api/consilium-loops/:id/develop
 * and the GET /api/consilium-loops/:id devProgress merge.
 *
 * Wires the REAL `registerConsiliumLoopRoutes` over a MOCK controller (so each
 * typed `DevelopResult` code maps deterministically) + a fake storage and a
 * requireAuth stand-in. Asserts:
 *   - owner-or-admin auth (404 on a foreign loop — parity with the removed button,
 *     NOT the stricter maintainer/admin merge gate);
 *   - the typed develop result → HTTP mapping (200 + masked loop / 400 / 409 / 429);
 *   - GET detail merges `devProgress` alongside `rounds`;
 *   - the removed standalone execute-sdlc route is GONE (404).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { AppConfig } from "../../../server/config/schema.js";
import type { IStorage } from "../../../server/storage.js";
import type {
  ConsiliumLoopController,
  DevelopErrorCode,
  DevelopResult,
} from "../../../server/services/consilium/consilium-loop-controller.js";
import { registerConsiliumLoopRoutes } from "../../../server/routes/consilium-loops.js";

const LOOP_ID = "loop-1";
const OWNER = "user-1";

const DEVELOPING_LOOP = {
  id: LOOP_ID,
  groupId: "grp-1",
  state: "developing",
  round: 2,
  createdBy: OWNER,
  repoPath: "/repos/widget",
};

const TERMINAL_LOOP = { ...DEVELOPING_LOOP, state: "converged" };

const config = () => ({ pipeline: { consiliumLoop: {} } }) as unknown as AppConfig;

function makeApp(opts: {
  developResult?: DevelopResult;
  devProgress?: unknown;
  loop?: Record<string, unknown>;
  user?: { id: string; role?: string };
} = {}) {
  const {
    developResult = { ok: true, loop: { ...DEVELOPING_LOOP } as never },
    devProgress,
    loop = { ...TERMINAL_LOOP },
  } = opts;
  // Distinguish "explicitly unauthenticated" (key present, value undefined) from
  // "default to owner" (key absent) — a destructuring default would swallow the
  // explicit undefined and re-apply the owner.
  const user = "user" in opts ? opts.user : { id: OWNER };

  const controller = {
    develop: vi.fn(async () => developResult),
    getDevProgress: vi.fn(() => devProgress),
  } as unknown as ConsiliumLoopController;

  const storage = {
    getLoop: vi.fn(async () => loop),
    getLoopRounds: vi.fn(async () => [{ round: 1, openP0: 2 }]),
  } as unknown as IStorage;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) (req as unknown as { user: typeof user }).user = user;
    next();
  });
  registerConsiliumLoopRoutes(app, storage, controller, config);
  return { app, controller };
}

describe("POST /api/consilium-loops/:id/develop", () => {
  beforeEach(() => vi.clearAllMocks());

  it("owner re-opens a terminal loop → 200 + masked loop (state developing), createdBy hidden", async () => {
    const { app, controller } = makeApp();
    const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/develop`).send();
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("developing");
    expect(res.body.createdBy).toBeUndefined(); // masked for a non-admin owner
    expect((controller.develop as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(LOOP_ID);
  });

  it("admin keeps createdBy in the masked row", async () => {
    const { app } = makeApp({ user: { id: "admin-x", role: "admin" } });
    const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/develop`).send();
    expect(res.status).toBe(200);
    expect(res.body.createdBy).toBe(OWNER);
  });

  it("a foreign loop → 404 (owner-or-admin, no existence oracle), develop NOT called", async () => {
    const { app, controller } = makeApp({ user: { id: "intruder" } });
    const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/develop`).send();
    expect(res.status).toBe(404);
    expect((controller.develop as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated", async () => {
    const { app } = makeApp({ user: undefined as never });
    const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/develop`).send();
    expect(res.status).toBe(401);
  });

  const cases: Array<{ code: DevelopErrorCode; status: number; retryAfter?: boolean }> = [
    { code: "WRONG_STATE", status: 409 },
    { code: "ACTIVE_LOOP_EXISTS", status: 409 },
    { code: "CAS_LOST", status: 409 },
    { code: "BUSY", status: 429, retryAfter: true },
    { code: "NO_ACTION_POINTS", status: 400 },
    { code: "REPO_NOT_ALLOWED", status: 400 },
    { code: "REPO_NOT_WORKSPACE", status: 400 },
    { code: "NOT_FOUND", status: 404 },
  ];
  for (const c of cases) {
    it(`maps ${c.code} → ${c.status}`, async () => {
      const { app } = makeApp({ developResult: { ok: false, code: c.code } });
      const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/develop`).send();
      expect(res.status).toBe(c.status);
      if (c.retryAfter) expect(res.headers["retry-after"]).toBe("30");
    });
  }
});

describe("GET /api/consilium-loops/:id — devProgress merge", () => {
  beforeEach(() => vi.clearAllMocks());

  it("merges devProgress alongside rounds", async () => {
    const progress = { phase: "coding", actionPointIndex: 1, actionPointTotal: 2, actionPointTitle: "AP1", completedCount: 0 };
    const { app, controller } = makeApp({ devProgress: progress, loop: { ...DEVELOPING_LOOP } });
    const res = await request(app).get(`/api/consilium-loops/${LOOP_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.rounds).toHaveLength(1);
    expect(res.body.devProgress).toMatchObject(progress);
    expect((controller.getDevProgress as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(LOOP_ID);
  });

  it("devProgress is undefined when no developing run is tracked", async () => {
    const { app } = makeApp({ devProgress: undefined, loop: { ...DEVELOPING_LOOP } });
    const res = await request(app).get(`/api/consilium-loops/${LOOP_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.devProgress).toBeUndefined();
  });
});

describe("removed standalone execute-sdlc surface", () => {
  it("POST /api/task-groups/:id/execute-sdlc is no longer registered → 404", async () => {
    const { app } = makeApp();
    const res = await request(app).post(`/api/task-groups/grp-1/execute-sdlc`).send({});
    expect(res.status).toBe(404);
  });
});
