/**
 * Integration tests for the LEGACY knowledge routes (server/routes/knowledge.ts).
 *
 * Issue #358 — authenticated IDOR: every /api/workspaces/:id/knowledge/* route
 * was behind requireAuth but did NOT verify the `:id` workspace belongs to the
 * caller, so any authenticated `user` could read/search/ingest/re-embed/delete
 * chunks in ANY workspace by supplying another workspace's id.
 *
 * These tests assert the workspace-scoping gate on EVERY route:
 *   - owner (non-admin)      → allowed (200/201/expected)
 *   - non-owner `user`       → 403
 *   - admin on another's ws  → allowed
 *   - missing workspace      → 404
 *   - unauthenticated        → 401 (and 401 precedes 404 in ordering)
 *   - null-owner workspace   → 403 (chosen policy: DENY null-owner, matching
 *                              orchestrator authorizeRun + workspaces
 *                              getOwnedWorkspace; admin still allowed)
 *
 * Plus cross-workspace isolation: user A cannot reach user B's workspace, and
 * when denied, the underlying store is NEVER touched (no leak / no write).
 *
 * supertest over the test-knowledge-legacy-app factory (MemStorage + injected
 * in-memory store + deterministic embedding factory). No CLI / network / DB.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import {
  createLegacyKnowledgeTestApp,
  type KnowledgeStoreCalls,
  type LegacyKnowledgeTestAppOptions,
} from "../../helpers/test-knowledge-legacy-app";

const MISSING = "does-not-exist";

function ingestBody() {
  return {
    sourceType: "document",
    sourceId: "src-1",
    text: "Pin terraform module sources to a version.",
    metadata: {},
    replace: false,
  };
}

function configBody() {
  return { provider: "ollama", model: "nomic-embed-text", dimensions: 768 };
}

// ─── Route descriptors: exercised by the shared gate-matrix below ──────────────

interface RouteCase {
  name: string;
  method: "get" | "post" | "put" | "delete";
  path: (ws: string) => string;
  body?: () => Record<string, unknown>;
  /** Expected status for the legitimate owner/admin happy path. */
  ok: number;
  query?: Record<string, string>;
  /** Which store call records a touch for this route (cross-ws isolation check). */
  touch: (calls: KnowledgeStoreCalls) => unknown[];
}

const ROUTES: RouteCase[] = [
  {
    name: "GET sources (read)",
    method: "get",
    path: (ws) => `/api/workspaces/${ws}/knowledge/sources`,
    ok: 200,
    touch: (c) => c.listSources,
  },
  {
    name: "GET search (read)",
    method: "get",
    path: (ws) => `/api/workspaces/${ws}/knowledge/search`,
    query: { q: "terraform" },
    ok: 200,
    touch: (c) => c.search,
  },
  {
    name: "POST ingest (mutation)",
    method: "post",
    path: (ws) => `/api/workspaces/${ws}/knowledge/ingest`,
    body: ingestBody,
    ok: 201,
    touch: (c) => c.insertChunks,
  },
  {
    name: "DELETE source (mutation)",
    method: "delete",
    path: (ws) => `/api/workspaces/${ws}/knowledge/sources/document/src-1`,
    ok: 200,
    touch: (c) => c.deleteBySource,
  },
  {
    name: "GET config (read)",
    method: "get",
    path: (ws) => `/api/workspaces/${ws}/knowledge/config`,
    ok: 200,
    touch: (c) => c.getEmbeddingConfig,
  },
  {
    name: "PUT config (mutation)",
    method: "put",
    path: (ws) => `/api/workspaces/${ws}/knowledge/config`,
    body: configBody,
    ok: 200,
    touch: (c) => c.upsertEmbeddingConfig,
  },
  {
    name: "POST re-embed (mutation)",
    method: "post",
    path: (ws) => `/api/workspaces/${ws}/knowledge/re-embed`,
    ok: 200,
    touch: (c) => c.countChunks,
  },
];

function send(
  app: import("express").Express,
  route: RouteCase,
  ws: string,
  opts: { unauth?: boolean } = {},
) {
  let req = request(app)[route.method](route.path(ws));
  if (route.query) req = req.query(route.query);
  if (opts.unauth) req = req.set("x-test-unauth", "1");
  if (route.body) req = req.send(route.body());
  return req;
}

function build(opts: LegacyKnowledgeTestAppOptions) {
  return createLegacyKnowledgeTestApp(opts);
}

describe("legacy knowledge routes — IDOR workspace-scoping gate (#358)", () => {
  for (const route of ROUTES) {
    describe(route.name, () => {
      it("allows a non-admin workspace OWNER", async () => {
        const { app, workspaceId } = await build({ role: "user", ownsWorkspace: true });
        const res = await send(app, route, workspaceId);
        expect(res.status).toBe(route.ok);
      });

      it("allows an admin on another user's workspace", async () => {
        const { app, workspaceId } = await build({ role: "admin", workspaceOwnerId: "other" });
        const res = await send(app, route, workspaceId);
        expect(res.status).toBe(route.ok);
      });

      it("rejects a non-owner `user` with 403 and never touches the store", async () => {
        const { app, workspaceId, calls } = await build({
          role: "user",
          userId: "user-A",
          workspaceOwnerId: "user-B",
        });
        const res = await send(app, route, workspaceId);
        expect(res.status).toBe(403);
        expect(route.touch(calls)).toHaveLength(0);
      });

      it("404s on a missing workspace", async () => {
        const { app } = await build({ role: "admin" });
        const res = await send(app, route, MISSING);
        expect(res.status).toBe(404);
      });

      it("401s when unauthenticated", async () => {
        const { app, workspaceId } = await build({ role: "user", ownsWorkspace: true });
        const res = await send(app, route, workspaceId, { unauth: true });
        expect(res.status).toBe(401);
      });

      it("401 precedes 404 (unauth on a missing workspace)", async () => {
        const { app } = await build({ role: "admin" });
        const res = await send(app, route, MISSING, { unauth: true });
        expect(res.status).toBe(401);
      });

      it("denies a null-owner workspace with 403 for a non-admin (chosen policy)", async () => {
        const { app, workspaceId, calls } = await build({
          role: "user",
          userId: "user-A",
          workspaceOwnerId: null,
        });
        const res = await send(app, route, workspaceId);
        expect(res.status).toBe(403);
        expect(route.touch(calls)).toHaveLength(0);
      });

      it("admin may access a null-owner workspace", async () => {
        const { app, workspaceId } = await build({ role: "admin", workspaceOwnerId: null });
        const res = await send(app, route, workspaceId);
        expect(res.status).toBe(route.ok);
      });
    });
  }
});

describe("legacy knowledge routes — cross-workspace isolation", () => {
  it("user A cannot READ (search) into user B's workspace", async () => {
    const { app, workspaceId, calls } = await createLegacyKnowledgeTestApp({
      role: "user",
      userId: "user-A",
      workspaceOwnerId: "user-B",
    });
    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/knowledge/search`)
      .query({ q: "secret" });
    expect(res.status).toBe(403);
    expect(calls.search).toHaveLength(0);
  });

  it("user A cannot READ (sources) into user B's workspace", async () => {
    const { app, workspaceId, calls } = await createLegacyKnowledgeTestApp({
      role: "user",
      userId: "user-A",
      workspaceOwnerId: "user-B",
    });
    const res = await request(app).get(`/api/workspaces/${workspaceId}/knowledge/sources`);
    expect(res.status).toBe(403);
    expect(calls.listSources).toHaveLength(0);
  });

  it("user A cannot INGEST into user B's workspace", async () => {
    const { app, workspaceId, calls } = await createLegacyKnowledgeTestApp({
      role: "user",
      userId: "user-A",
      workspaceOwnerId: "user-B",
    });
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/knowledge/ingest`)
      .send(ingestBody());
    expect(res.status).toBe(403);
    expect(calls.insertChunks).toHaveLength(0);
  });

  it("the legitimate owner ingest still writes through to the store", async () => {
    const { app, workspaceId, calls } = await createLegacyKnowledgeTestApp({
      role: "user",
      userId: "owner-X",
      ownsWorkspace: true,
    });
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/knowledge/ingest`)
      .send(ingestBody());
    expect(res.status).toBe(201);
    expect(calls.insertChunks.length).toBeGreaterThan(0);
    for (const chunk of calls.insertChunks) {
      expect(chunk.workspaceId).toBe(workspaceId);
    }
  });
});

describe("legacy knowledge routes — generic client errors (no internal leak)", () => {
  it("returns a generic 403 body with no internal detail when denied", async () => {
    const { app, workspaceId } = await createLegacyKnowledgeTestApp({
      role: "user",
      userId: "user-A",
      workspaceOwnerId: "user-B",
    });
    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/knowledge/search`)
      .query({ q: "x" });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|Error:|node_modules|pgvector|ollama/i);
  });
});
