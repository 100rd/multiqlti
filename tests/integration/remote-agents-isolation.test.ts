/**
 * Remote Agents isolation tests (ADR-001 fix-isolation: H-3 / H-4)
 *
 * H-3: GET /api/remote-agents (list), GET /api/remote-agents/:id, and
 *      POST /api/remote-agents (create) must NOT return the plaintext authTokenEnc
 *      field.  Instead the response contains `hasAuthToken: boolean`.
 *
 * H-4: A user in project A must receive 404 (not the agent) when requesting
 *      project B's agent by ID.  The manager's getAgent() uses
 *      withProject(remoteAgents, eq(remoteAgents.id, id)) so cross-project IDs
 *      yield no row → null → 404.
 *
 * Test strategy:
 *  H-3 — uses the existing mock-manager harness from remote-agents-api.test.ts;
 *         verifies response shape after toPublicAgent() is applied in routes.
 *  H-4 — uses a context-aware mock manager whose getAgent() / listAgents()
 *         look up the ALS project context (mimicking withProject behaviour).
 *         The requireProject middleware is mounted on the router; the db module
 *         is mocked so requireProject makes no real DB calls.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import type { RemoteAgentManager } from "../../server/remote-agents/remote-agent-manager.js";
import type { RemoteAgentConfig, A2AMessage } from "../../shared/types.js";
import type { Router } from "express";
import type { User } from "../../shared/types.js";

// ─── Mutable store for requireProject DB mock ─────────────────────────────────

const DB_STORE = vi.hoisted(() => ({
  projectsRows: [] as unknown[],
  membersRows: [] as unknown[],
}));

// Mock db module so requireProject works without a real database.
vi.mock("../../server/db.js", () => {
  const TABLE_NAME = Symbol.for("drizzle:BaseName");
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () => {
              const name = (table as Record<symbol, string>)[TABLE_NAME];
              if (name === "projects") return Promise.resolve(DB_STORE.projectsRows);
              if (name === "project_members") return Promise.resolve(DB_STORE.membersRows);
              return Promise.resolve([]);
            },
          }),
          // for listAgents / getAgent calls that go through withProject
          orderBy: () => Promise.resolve([]),
        }),
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
      delete: () => ({ where: () => Promise.resolve() }),
    },
    pool: { on: () => {} },
    withProject: (_t: unknown, cond?: unknown) => cond ?? Symbol("no-cond"),
    withProjectInsert: (_t: unknown, data: unknown) => data,
    runMigrations: async () => {},
  };
});

// ─── Shared mock agent factory (same as remote-agents-api.test.ts) ────────────

const NOW = new Date("2026-03-23T12:00:00Z");

function makeAgent(overrides: Partial<RemoteAgentConfig> = {}): RemoteAgentConfig {
  return {
    id: "agent-1",
    name: "k8s-agent",
    environment: "kubernetes",
    transport: "a2a-http",
    endpoint: "https://agent.example.com",
    cluster: null,
    namespace: null,
    labels: null,
    authTokenEnc: null,
    enabled: true,
    autoConnect: false,
    status: "online",
    lastHeartbeatAt: NOW,
    healthError: null,
    agentCard: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ─── H-3: Token redaction tests ───────────────────────────────────────────────
//
// Uses a simple mock manager (no project context required) — these tests focus
// on the response DTO shape, not on project isolation.

function createTokenMockManager(): RemoteAgentManager {
  const agents = new Map<string, RemoteAgentConfig>();

  return {
    initialize: async () => {},
    shutdown: async () => {},

    listAgents: async () => Array.from(agents.values()),

    getAgent: async (id: string) => agents.get(id) ?? null,

    registerAgent: async (input: Record<string, unknown>) => {
      const id = `agent-${Date.now()}`;
      const agent = makeAgent({
        id,
        name: input.name as string,
        environment: input.environment as RemoteAgentConfig["environment"],
        endpoint: input.endpoint as string,
        // Store the raw token value (simulating what rowToConfig returns after decrypt)
        authTokenEnc: (input.authTokenEnc as string | undefined) ?? null,
      });
      agents.set(id, agent);
      return agent;
    },

    unregisterAgent: async (id: string) => { agents.delete(id); },
    connectAgent: async () => {},
    disconnectAgent: async () => {},
    getConnectionStatus: () => false,
    resolveAgent: async () => null,
    dispatchTask: async () => ({ taskId: "t1", status: "completed", durationMs: 1 }),
  } as unknown as RemoteAgentManager;
}

describe("H-3: auth token is NOT exposed in remote-agent HTTP responses", () => {
  let app: Express;

  beforeAll(async () => {
    const { registerRemoteAgentRoutes } = await import("../../server/routes/remote-agents.js");
    app = express();
    app.use(express.json());
    registerRemoteAgentRoutes(app as unknown as Router, createTokenMockManager());
  });

  it("POST /api/remote-agents with authTokenEnc: response has hasAuthToken=true, no plaintext authTokenEnc", async () => {
    const res = await request(app)
      .post("/api/remote-agents")
      .send({
        name: "secured-agent",
        environment: "kubernetes",
        endpoint: "https://secured.example.com",
        authTokenEnc: "super-secret-bearer-token",
      });

    expect(res.status).toBe(201);
    // Must NOT return the plaintext token
    expect(res.body).not.toHaveProperty("authTokenEnc");
    // Must signal that a token is configured
    expect(res.body).toHaveProperty("hasAuthToken", true);
  });

  it("POST /api/remote-agents without authTokenEnc: response has hasAuthToken=false", async () => {
    const res = await request(app)
      .post("/api/remote-agents")
      .send({
        name: "open-agent",
        environment: "linux",
        endpoint: "https://open.example.com",
      });

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("authTokenEnc");
    expect(res.body).toHaveProperty("hasAuthToken", false);
  });

  it("GET /api/remote-agents: list response does not expose authTokenEnc for any agent", async () => {
    // Create one agent with a token
    await request(app)
      .post("/api/remote-agents")
      .send({
        name: "list-token-agent",
        environment: "docker",
        endpoint: "https://list-token.example.com",
        authTokenEnc: "token-in-list",
      });

    const res = await request(app).get("/api/remote-agents");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    for (const agent of res.body as Record<string, unknown>[]) {
      // None of the agents should expose a raw token
      expect(agent).not.toHaveProperty("authTokenEnc");
      expect(agent).toHaveProperty("hasAuthToken");
      expect(typeof agent.hasAuthToken).toBe("boolean");
    }

    // The token agent should have hasAuthToken=true
    const tokenAgent = (res.body as Array<{ name: string; hasAuthToken: boolean }>).find(
      (a) => a.name === "list-token-agent",
    );
    expect(tokenAgent).toBeDefined();
    expect(tokenAgent!.hasAuthToken).toBe(true);
  });

  it("GET /api/remote-agents/:id: detail response does not expose authTokenEnc", async () => {
    const createRes = await request(app)
      .post("/api/remote-agents")
      .send({
        name: "id-token-agent",
        environment: "cloud",
        endpoint: "https://id-token.example.com",
        authTokenEnc: "id-level-secret",
      });
    const id = createRes.body.id;

    const res = await request(app).get(`/api/remote-agents/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("authTokenEnc");
    expect(res.body).toHaveProperty("hasAuthToken", true);
  });
});

// ─── H-4: Project isolation tests ─────────────────────────────────────────────
//
// Uses a context-aware mock manager that reads the ALS project context (set by
// requireProject middleware) to decide which "project store" to use — exactly
// what the real getAgent()/listAgents() do after the withProject fix.

const TEST_USER: User = {
  id: "user-test",
  email: "test@example.com",
  name: "Test User",
  isActive: true,
  role: "user",
  lastLoginAt: null,
  createdAt: new Date(0),
};

const PROJECT_A = {
  id: "proj-a",
  name: "Project A",
  ownerId: "user-test",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const PROJECT_B = {
  id: "proj-b",
  name: "Project B",
  ownerId: "user-test",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

// Agent registered in project A only
const AGENT_IN_A = makeAgent({ id: "agent-proj-a", name: "proj-a-agent" });

function createIsolationManager(): RemoteAgentManager {
  // Each "project" has its own agent store
  const storeA = new Map<string, RemoteAgentConfig>([["agent-proj-a", AGENT_IN_A]]);
  const storeB = new Map<string, RemoteAgentConfig>(); // no agents in project B

  async function currentStore(): Promise<Map<string, RemoteAgentConfig>> {
    const { requestContext } = await import("../../server/context.js");
    const ctx = requestContext.getStore();
    if (ctx?.projectId === "proj-a") return storeA;
    if (ctx?.projectId === "proj-b") return storeB;
    return new Map();
  }

  return {
    initialize: async () => {},
    shutdown: async () => {},
    listAgents: async () => Array.from((await currentStore()).values()),
    getAgent: async (id: string) => (await currentStore()).get(id) ?? null,
    registerAgent: async () => AGENT_IN_A,
    unregisterAgent: async () => {},
    connectAgent: async () => {},
    disconnectAgent: async () => {},
    getConnectionStatus: () => false,
    resolveAgent: async () => null,
    dispatchTask: async () => ({ taskId: "t", status: "completed", durationMs: 1 }),
  } as unknown as RemoteAgentManager;
}

/** Inject TEST_USER as the authenticated user on every request. */
function injectTestUser(req: Request, _res: Response, next: NextFunction) {
  req.user = TEST_USER;
  next();
}

describe("H-4: project isolation — project-B user cannot access project-A agent", () => {
  let app: Express;

  beforeAll(async () => {
    const { requireProject } = await import("../../server/middleware/project.js");
    const { registerRemoteAgentRoutes } = await import("../../server/routes/remote-agents.js");

    app = express();
    app.use(express.json());
    app.use(injectTestUser);

    // Mount the routes behind requireProject so each request runs in project ALS context.
    const router = express.Router();
    router.use(requireProject as express.RequestHandler);
    registerRemoteAgentRoutes(router as unknown as Router, createIsolationManager());
    app.use(router);
  });

  it("project-A user can GET their own agent", async () => {
    DB_STORE.projectsRows = [PROJECT_A];
    DB_STORE.membersRows = [];

    const res = await request(app)
      .get("/api/remote-agents/agent-proj-a")
      .set("x-project-id", "proj-a");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", "agent-proj-a");
  });

  it("project-B user gets 404 (not the agent) when requesting project-A agent ID", async () => {
    // Project B exists and user owns it — so requireProject succeeds for proj-b.
    // The isolation must come from the project-scoped getAgent() returning null.
    DB_STORE.projectsRows = [PROJECT_B];
    DB_STORE.membersRows = [];

    const res = await request(app)
      .get("/api/remote-agents/agent-proj-a")   // agent lives in proj-a
      .set("x-project-id", "proj-b");           // but request is for proj-b

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error", "Agent not found");
  });

  it("project-B user gets empty list (not project-A agents) from GET /api/remote-agents", async () => {
    DB_STORE.projectsRows = [PROJECT_B];
    DB_STORE.membersRows = [];

    const res = await request(app)
      .get("/api/remote-agents")
      .set("x-project-id", "proj-b");

    expect(res.status).toBe(200);
    // Project B has no agents — the list must be empty, not leaking proj-a's agents
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("project-A user sees their agent in the list", async () => {
    DB_STORE.projectsRows = [PROJECT_A];
    DB_STORE.membersRows = [];

    const res = await request(app)
      .get("/api/remote-agents")
      .set("x-project-id", "proj-a");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toHaveProperty("id", "agent-proj-a");
  });

  it("project-B user gets 404 for connect attempt on project-A agent ID", async () => {
    DB_STORE.projectsRows = [PROJECT_B];
    DB_STORE.membersRows = [];

    const res = await request(app)
      .post("/api/remote-agents/agent-proj-a/connect")
      .set("x-project-id", "proj-b");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error", "Agent not found");
  });

  it("project-B user gets 404 for dispatch attempt on project-A agent ID", async () => {
    DB_STORE.projectsRows = [PROJECT_B];
    DB_STORE.membersRows = [];

    const res = await request(app)
      .post("/api/remote-agents/agent-proj-a/dispatch")
      .set("x-project-id", "proj-b")
      .send({
        message: { role: "user", parts: [{ type: "text", text: "hello" }] },
      });

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error", "Agent not found");
  });
});
