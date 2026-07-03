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
  rounds?: unknown[];
  user?: { id: string; role?: string; name?: string; email?: string };
} = {}) {
  const {
    developResult = { ok: true, loop: { ...DEVELOPING_LOOP } as never },
    devProgress,
    loop = { ...TERMINAL_LOOP },
    rounds = [{ round: 1, openP0: 2 }],
  } = opts;
  // Distinguish "explicitly unauthenticated" (key present, value undefined) from
  // "default to owner" (key absent) — a destructuring default would swallow the
  // explicit undefined and re-apply the owner.
  const user = "user" in opts ? opts.user : { id: OWNER };

  const controller = {
    develop: vi.fn(async () => developResult),
    getDevProgress: vi.fn(() => devProgress),
    // Cancel echoes back a cancelled loop; tests assert the ARGS the route passes
    // (sanitized reason + session-resolved actor), not controller internals.
    cancel: vi.fn(async (_id: string, _opts?: { reason?: string; actor?: string }) => ({
      ...DEVELOPING_LOOP,
      state: "cancelled",
      error: "recorded",
    })),
  } as unknown as ConsiliumLoopController;

  const storage = {
    getLoop: vi.fn(async () => loop),
    getLoopRounds: vi.fn(async () => rounds),
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

// Finding #5: the loop detail exposes a computed `openRemainder` (count-by-priority
// of the LAST round's still-open action points) for a TERMINAL loop only.
describe("GET /api/consilium-loops/:id — openRemainder (finding #5)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a CONVERGED loop with a non-P0 remainder exposes openRemainder from the LAST round", async () => {
    const { app } = makeApp({
      loop: { ...TERMINAL_LOOP }, // state: converged
      rounds: [
        { round: 1, openP0: 2, openActionPoints: [{ title: "a", priority: "P0" }] },
        { round: 2, openP0: 0, openActionPoints: [
          { title: "b", priority: "P1" },
          { title: "c", priority: "P2" },
        ] },
      ],
    });
    const res = await request(app).get(`/api/consilium-loops/${LOOP_ID}`);
    expect(res.status).toBe(200);
    // LAST round only — the round-1 P0 must NOT leak into the count.
    expect(res.body.openRemainder).toEqual({ total: 2, byPriority: { P1: 1, P2: 1 } });
  });

  it("a converged-clean loop (empty last round) omits openRemainder entirely", async () => {
    const { app } = makeApp({
      loop: { ...TERMINAL_LOOP },
      rounds: [{ round: 1, openP0: 0, openActionPoints: [] }],
    });
    const res = await request(app).get(`/api/consilium-loops/${LOOP_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.openRemainder).toBeUndefined();
    expect("openRemainder" in res.body).toBe(false);
  });

  it("a NON-terminal loop never computes openRemainder even when a round carries items", async () => {
    const { app } = makeApp({
      loop: { ...DEVELOPING_LOOP }, // non-terminal
      rounds: [{ round: 1, openP0: 1, openActionPoints: [{ title: "a", priority: "P1" }] }],
    });
    const res = await request(app).get(`/api/consilium-loops/${LOOP_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.openRemainder).toBeUndefined();
  });
});

describe("removed standalone execute-sdlc surface", () => {
  it("POST /api/task-groups/:id/execute-sdlc is no longer registered → 404", async () => {
    const { app } = makeApp();
    const res = await request(app).post(`/api/task-groups/grp-1/execute-sdlc`).send({});
    expect(res.status).toBe(404);
  });
});

describe("POST /api/consilium-loops/:id/cancel — reason + actor threading", () => {
  beforeEach(() => vi.clearAllMocks());
  type CancelFn = ReturnType<typeof vi.fn>;

  it("passes a sanitized reason + session-resolved actor (name preferred) to controller.cancel", async () => {
    const { app, controller } = makeApp({ user: { id: OWNER, name: "Ada Lovelace", email: "ada@x.io" } });
    const res = await request(app)
      .post(`/api/consilium-loops/${LOOP_ID}/cancel`)
      .send({ reason: "  superseded\tby #42  " });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("cancelled");
    expect(controller.cancel as CancelFn).toHaveBeenCalledWith(LOOP_ID, {
      reason: "superseded by #42", // control-stripped + whitespace-collapsed + trimmed
      actor: "Ada Lovelace", // name wins over email/id
    });
  });

  it("no body (auto-cancel) → controller.cancel called with reason undefined, actor from id", async () => {
    const { app, controller } = makeApp({ user: { id: OWNER } }); // no name/email
    const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/cancel`).send();
    expect(res.status).toBe(200);
    expect(controller.cancel as CancelFn).toHaveBeenCalledWith(LOOP_ID, {
      reason: undefined,
      actor: OWNER,
    });
  });

  it("clamps an over-long reason to <= 500 chars (truncate, not reject)", async () => {
    const { app, controller } = makeApp({ user: { id: OWNER, email: "ops@x.io" } });
    const res = await request(app)
      .post(`/api/consilium-loops/${LOOP_ID}/cancel`)
      .send({ reason: "x".repeat(2000) });
    expect(res.status).toBe(200);
    const arg = (controller.cancel as CancelFn).mock.calls[0][1] as { reason?: string; actor?: string };
    expect(arg.reason?.length).toBe(500);
    expect(arg.actor).toBe("ops@x.io"); // email fallback when no name
  });

  it("a whitespace-only reason collapses to undefined (never a blank reason tail)", async () => {
    const { app, controller } = makeApp();
    const res = await request(app)
      .post(`/api/consilium-loops/${LOOP_ID}/cancel`)
      .send({ reason: "   \n\t  " });
    expect(res.status).toBe(200);
    const arg = (controller.cancel as CancelFn).mock.calls[0][1] as { reason?: string };
    expect(arg.reason).toBeUndefined();
  });

  it("a non-string reason → 400 (validation), controller.cancel NOT called", async () => {
    const { app, controller } = makeApp();
    const res = await request(app)
      .post(`/api/consilium-loops/${LOOP_ID}/cancel`)
      .send({ reason: 123 });
    expect(res.status).toBe(400);
    expect(controller.cancel as CancelFn).not.toHaveBeenCalled();
  });

  it("a foreign loop → 404, controller.cancel NOT called (no existence oracle)", async () => {
    const { app, controller } = makeApp({ user: { id: "intruder" } });
    const res = await request(app)
      .post(`/api/consilium-loops/${LOOP_ID}/cancel`)
      .send({ reason: "nope" });
    expect(res.status).toBe(404);
    expect(controller.cancel as CancelFn).not.toHaveBeenCalled();
  });

  it("controller reports already-terminal (null) → 409", async () => {
    const { app, controller } = makeApp();
    (controller.cancel as CancelFn).mockResolvedValueOnce(null);
    const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/cancel`).send();
    expect(res.status).toBe(409);
  });
});
