/**
 * consult-route.test.ts — the standalone multi-model Q&A endpoints, end-to-end
 * through the real route → service path with a FAKE gateway/storage/workspace.
 *
 * Covers the contract that matters at the HTTP boundary:
 *   - create validates models against the active catalog (unknown ⇒ 400, nothing saved);
 *   - /answer runs one gateway call per model and persists round 0 (status → answered);
 *   - /debate refuses before any answers (400), else persists the next round;
 *   - /handoff connects a workspace, starts a loop, and records loopId/workspaceId;
 *   - access is project-scoped + owner-or-admin (403 for a stranger, 404 cross-project).
 *
 * createConsiliumReview is module-mocked — the handoff wiring is what we assert, not
 * the (separately tested) loop factory.
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../../server/services/consilium/review-factory.js", () => ({
  createConsiliumReview: vi.fn(async () => ({ id: "loop-1" })),
}));

import { registerConsultRoutes } from "../../../server/routes/consult.js";
import { createConsiliumReview } from "../../../server/services/consilium/review-factory.js";
import type { ConsultGateway } from "../../../server/services/consult/consult-service.js";
import type { IStorage } from "../../../server/storage.js";

/** Minimal in-memory storage covering only the methods the routes touch. */
function makeStorage(activeSlugs: string[]) {
  const sessions = new Map<string, Record<string, unknown>>();
  const answers: Array<Record<string, unknown>> = [];
  let seq = 0;
  const store = {
    async getActiveModels() {
      return activeSlugs.map((slug) => ({ slug }));
    },
    async createConsultSession(data: Record<string, unknown>) {
      const row = {
        id: `s${++seq}`,
        status: "created",
        createdAt: new Date(),
        loopId: null,
        workspaceId: null,
        ...data,
      };
      sessions.set(row.id as string, row);
      return row;
    },
    async getConsultSession(id: string) {
      return sessions.get(id);
    },
    async listConsultSessions(projectId: string) {
      return [...sessions.values()].filter((s) => s.projectId === projectId);
    },
    async getConsultAnswers(sessionId: string) {
      return answers.filter((a) => a.sessionId === sessionId);
    },
    async addConsultAnswers(rows: Array<Record<string, unknown>>) {
      const created = rows.map((r) => ({ id: `a${++seq}`, createdAt: new Date(), ...r }));
      answers.push(...created);
      return created;
    },
    async updateConsultStatus(id: string, status: string) {
      const s = sessions.get(id);
      if (s) s.status = status;
    },
    async setConsultHandoff(id: string, p: { loopId: string; workspaceId: string }) {
      const s = sessions.get(id);
      if (s) {
        s.loopId = p.loopId;
        s.workspaceId = p.workspaceId;
        s.status = "handed_off";
      }
    },
  };
  return { store: store as unknown as IStorage, sessions, answers };
}

type Requester = { userId?: string; role?: string; projectId?: string };

/** Mount the consult routes over a given store, impersonating one requester. */
function mount(store: IStorage, who: Requester = {}) {
  const gatewaySpy = vi.fn(async () => ({ content: "recommendation" }));
  const connectSpy = vi.fn(async () => ({ id: "ws-1", path: "/canon/repo" }));
  const app = express();
  app.use(express.json());
  // Stand in for requireAuth + requireProject (applied at mount in routes.ts).
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string; role: string } }).user = {
      id: who.userId ?? "user-1",
      role: who.role ?? "member",
    };
    (req as unknown as { projectId: string }).projectId = who.projectId ?? "project-1";
    next();
  });
  registerConsultRoutes(app, {
    storage: store,
    gateway: { completeStreaming: gatewaySpy } as unknown as ConsultGateway,
    reviewDeps: {} as never,
    connectWorkspace: connectSpy,
  });
  return { app, gatewaySpy, connectSpy };
}

function makeApp(opts: { activeSlugs?: string[] } & Requester = {}) {
  const { store, sessions } = makeStorage(opts.activeSlugs ?? ["m1", "m2"]);
  const { app, gatewaySpy, connectSpy } = mount(store, opts);
  return { app, store, sessions, gatewaySpy, connectSpy };
}

async function createSession(app: express.Express, modelSlugs = ["m1", "m2"]) {
  return request(app)
    .post("/api/consult")
    .send({ question: "should I use cloud WAN?", modelSlugs });
}

describe("POST /api/consult", () => {
  it("creates a session for models in the active catalog", async () => {
    const { app } = makeApp();
    const res = await createSession(app);
    expect(res.status).toBe(201);
    expect(res.body.question).toBe("should I use cloud WAN?");
    expect(res.body.modelSlugs).toEqual(["m1", "m2"]);
    expect(res.body.status).toBe("created");
  });

  it("rejects an unknown/inactive model with 400 and persists nothing", async () => {
    const { app, sessions } = makeApp({ activeSlugs: ["m1"] });
    const res = await createSession(app, ["m1", "ghost"]);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("ghost");
    expect(sessions.size).toBe(0);
  });

  it("rejects an empty question with 400 (zod, before catalog lookup)", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/api/consult").send({ question: "  ", modelSlugs: ["m1"] });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/consult/:id/answer", () => {
  it("runs one gateway call per model, persists round 0, marks answered", async () => {
    const { app, gatewaySpy } = makeApp();
    const { body: session } = await createSession(app);
    const res = await request(app).post(`/api/consult/${session.id}/answer`).send({});
    expect(res.status).toBe(200);
    expect(res.body.round).toBe(0);
    expect(res.body.answers).toHaveLength(2);
    expect(gatewaySpy).toHaveBeenCalledTimes(2);

    const get = await request(app).get(`/api/consult/${session.id}`);
    expect(get.body.session.status).toBe("answered");
    expect(get.body.answers).toHaveLength(2);
  });

  it("404s cross-project (same store, different project context)", async () => {
    const { store } = makeApp();
    const owner = mount(store, { projectId: "project-1" });
    const { body: session } = await createSession(owner.app);
    const stranger = mount(store, { projectId: "project-2" });
    const res = await request(stranger.app).post(`/api/consult/${session.id}/answer`).send({});
    expect(res.status).toBe(404);
  });
});

describe("POST /api/consult/:id/debate", () => {
  it("refuses before any answers (400)", async () => {
    const { app } = makeApp();
    const { body: session } = await createSession(app);
    const res = await request(app).post(`/api/consult/${session.id}/debate`).send({});
    expect(res.status).toBe(400);
  });

  it("persists the next round after answers exist", async () => {
    const { app, gatewaySpy } = makeApp();
    const { body: session } = await createSession(app);
    await request(app).post(`/api/consult/${session.id}/answer`).send({});
    gatewaySpy.mockClear();
    const res = await request(app).post(`/api/consult/${session.id}/debate`).send({});
    expect(res.status).toBe(200);
    expect(res.body.round).toBe(1);
    expect(res.body.answers).toHaveLength(2);
    expect(gatewaySpy).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/consult/:id/handoff", () => {
  it("connects a workspace, starts a loop, records the ids", async () => {
    const { app, connectSpy, store } = makeApp();
    const { body: session } = await createSession(app);
    const res = await request(app)
      .post(`/api/consult/${session.id}/handoff`)
      .send({ repoPath: "/my/repo", instruction: "do the thing" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ loopId: "loop-1", workspaceId: "ws-1" });
    expect(connectSpy).toHaveBeenCalledWith("/my/repo");
    expect(vi.mocked(createConsiliumReview)).toHaveBeenCalledTimes(1);

    const persisted = await store.getConsultSession(session.id);
    expect(persisted?.loopId).toBe("loop-1");
    expect(persisted?.status).toBe("handed_off");
  });

  it("rejects an empty instruction with 400 before any side effect", async () => {
    const { app, connectSpy } = makeApp();
    const { body: session } = await createSession(app);
    const res = await request(app)
      .post(`/api/consult/${session.id}/handoff`)
      .send({ repoPath: "/my/repo", instruction: "" });
    expect(res.status).toBe(400);
    expect(connectSpy).not.toHaveBeenCalled();
  });
});

describe("access control", () => {
  it("403s for a non-owner non-admin viewing the session", async () => {
    const { store } = makeApp();
    const owner = mount(store, { userId: "user-1" });
    const { body: session } = await createSession(owner.app);
    const stranger = mount(store, { userId: "user-2", role: "member" });
    const res = await request(stranger.app).get(`/api/consult/${session.id}`);
    expect(res.status).toBe(403);
  });

  it("lets an admin view another user's session", async () => {
    const { store } = makeApp();
    const owner = mount(store, { userId: "user-1" });
    const { body: session } = await createSession(owner.app);
    const admin = mount(store, { userId: "admin-9", role: "admin" });
    const res = await request(admin.app).get(`/api/consult/${session.id}`);
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(session.id);
  });
});
