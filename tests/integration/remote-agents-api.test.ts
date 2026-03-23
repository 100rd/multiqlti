/**
 * Integration tests for the Remote Agents API (Phase 8.9).
 *
 * Since RemoteAgentManager uses the DB directly (not IStorage), we mock the
 * manager at the HTTP level and test all route behaviour through supertest.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { registerRemoteAgentRoutes } from "../../server/routes/remote-agents.js";
import type { RemoteAgentManager } from "../../server/remote-agents/remote-agent-manager.js";
import type { RemoteAgentConfig, A2AMessage } from "../../shared/types.js";
import type { Router } from "express";

// ─── Mock agent data ────────────────────────────────────────────────────────

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

// ─── Mock RemoteAgentManager ────────────────────────────────────────────────

function createMockManager(): RemoteAgentManager {
  const agents = new Map<string, RemoteAgentConfig>();
  const connected = new Set<string>();

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
        transport: (input.transport as RemoteAgentConfig["transport"]) ?? "a2a-http",
        endpoint: input.endpoint as string,
        cluster: (input.cluster as string) ?? null,
        namespace: (input.namespace as string) ?? null,
        labels: (input.labels as Record<string, string>) ?? null,
        authTokenEnc: (input.authTokenEnc as string) ?? null,
        enabled: (input.enabled as boolean) ?? true,
        autoConnect: (input.autoConnect as boolean) ?? false,
        status: "offline",
      });
      agents.set(id, agent);
      return agent;
    },

    unregisterAgent: async (id: string) => {
      agents.delete(id);
      connected.delete(id);
    },

    connectAgent: async (id: string) => {
      if (!agents.has(id)) throw new Error(`Agent ${id} not found`);
      connected.add(id);
      const agent = agents.get(id)!;
      agents.set(id, { ...agent, status: "online", lastHeartbeatAt: new Date() });
    },

    disconnectAgent: async (id: string) => {
      connected.delete(id);
      const agent = agents.get(id);
      if (agent) agents.set(id, { ...agent, status: "offline" });
    },

    getConnectionStatus: (id: string) => connected.has(id),

    resolveAgent: async () => null,

    dispatchTask: async (agentId: string, message: A2AMessage, options?: { skill?: string }) => {
      if (!connected.has(agentId)) throw new Error(`Agent ${agentId} not connected`);
      return {
        taskId: `task-${Date.now()}`,
        status: "completed",
        output: { role: "agent" as const, parts: [{ type: "text" as const, text: "done" }] },
        durationMs: 42,
      };
    },
  } as unknown as RemoteAgentManager;
}

// ─── Test setup ─────────────────────────────────────────────────────────────

describe("Remote Agents API", () => {
  let app: express.Express;
  let manager: RemoteAgentManager;

  beforeAll(() => {
    manager = createMockManager();
    app = express();
    app.use(express.json());
    registerRemoteAgentRoutes(app as unknown as Router, manager);
  });

  // ── POST /api/remote-agents ─────────────────────────────────────────────

  it("POST /api/remote-agents creates agent and returns 201", async () => {
    const res = await request(app)
      .post("/api/remote-agents")
      .send({
        name: "test-agent",
        environment: "kubernetes",
        endpoint: "https://agent.example.com",
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
    expect(res.body.name).toBe("test-agent");
    expect(res.body.environment).toBe("kubernetes");
    expect(res.body.transport).toBe("a2a-http");
    expect(res.body.endpoint).toBe("https://agent.example.com");
  });

  it("POST /api/remote-agents with invalid endpoint returns 400", async () => {
    const res = await request(app)
      .post("/api/remote-agents")
      .send({
        name: "bad-agent",
        environment: "kubernetes",
        endpoint: "not-a-url",
      });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "Validation failed");
    expect(res.body.issues).toBeDefined();
  });

  it("POST /api/remote-agents with missing name returns 400", async () => {
    const res = await request(app)
      .post("/api/remote-agents")
      .send({
        environment: "kubernetes",
        endpoint: "https://agent.example.com",
      });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "Validation failed");
  });

  it("POST /api/remote-agents with invalid environment returns 400", async () => {
    const res = await request(app)
      .post("/api/remote-agents")
      .send({
        name: "bad-env-agent",
        environment: "windows",
        endpoint: "https://agent.example.com",
      });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "Validation failed");
  });

  it("POST /api/remote-agents with all optional fields returns 201", async () => {
    const res = await request(app)
      .post("/api/remote-agents")
      .send({
        name: "full-agent",
        environment: "docker",
        transport: "a2a-grpc",
        endpoint: "https://grpc.example.com",
        cluster: "prod-east",
        namespace: "agents",
        labels: { tier: "gold", team: "platform" },
        enabled: false,
        autoConnect: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.transport).toBe("a2a-grpc");
    expect(res.body.cluster).toBe("prod-east");
    expect(res.body.namespace).toBe("agents");
    expect(res.body.labels).toEqual({ tier: "gold", team: "platform" });
  });

  // ── GET /api/remote-agents ──────────────────────────────────────────────

  it("GET /api/remote-agents returns array", async () => {
    const res = await request(app).get("/api/remote-agents");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Should contain agents created by previous POST tests
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  // ── GET /api/remote-agents/:id ──────────────────────────────────────────

  it("GET /api/remote-agents/:id returns agent", async () => {
    // First create an agent to get its ID
    const createRes = await request(app)
      .post("/api/remote-agents")
      .send({
        name: "get-test-agent",
        environment: "linux",
        endpoint: "https://linux.example.com",
      });

    const id = createRes.body.id;

    const res = await request(app).get(`/api/remote-agents/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.name).toBe("get-test-agent");
  });

  it("GET /api/remote-agents/:id with unknown ID returns 404", async () => {
    const res = await request(app).get("/api/remote-agents/nonexistent-id");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error", "Agent not found");
  });

  // ── DELETE /api/remote-agents/:id ───────────────────────────────────────

  it("DELETE /api/remote-agents/:id returns 204", async () => {
    const createRes = await request(app)
      .post("/api/remote-agents")
      .send({
        name: "delete-me",
        environment: "cloud",
        endpoint: "https://cloud.example.com",
      });

    const id = createRes.body.id;
    const res = await request(app).delete(`/api/remote-agents/${id}`);
    expect(res.status).toBe(204);

    // Verify it was deleted
    const getRes = await request(app).get(`/api/remote-agents/${id}`);
    expect(getRes.status).toBe(404);
  });

  // ── POST /api/remote-agents/:id/connect ─────────────────────────────────

  it("POST /api/remote-agents/:id/connect connects agent", async () => {
    const createRes = await request(app)
      .post("/api/remote-agents")
      .send({
        name: "connect-agent",
        environment: "kubernetes",
        endpoint: "https://k8s.example.com",
      });

    const id = createRes.body.id;
    const res = await request(app).post(`/api/remote-agents/${id}/connect`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, agentId: id, status: "connected" });
  });

  it("POST /api/remote-agents/:id/connect with unknown ID returns 404", async () => {
    const res = await request(app).post("/api/remote-agents/no-such-agent/connect");
    expect(res.status).toBe(404);
  });

  // ── POST /api/remote-agents/:id/disconnect ──────────────────────────────

  it("POST /api/remote-agents/:id/disconnect disconnects agent", async () => {
    const createRes = await request(app)
      .post("/api/remote-agents")
      .send({
        name: "disconnect-agent",
        environment: "kubernetes",
        endpoint: "https://disc.example.com",
      });

    const id = createRes.body.id;
    // Connect first
    await request(app).post(`/api/remote-agents/${id}/connect`);
    // Then disconnect
    const res = await request(app).post(`/api/remote-agents/${id}/disconnect`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, agentId: id, status: "disconnected" });
  });

  // ── POST /api/remote-agents/:id/dispatch ────────────────────────────────

  it("POST /api/remote-agents/:id/dispatch validates message", async () => {
    const createRes = await request(app)
      .post("/api/remote-agents")
      .send({
        name: "dispatch-agent",
        environment: "kubernetes",
        endpoint: "https://dispatch.example.com",
      });

    const id = createRes.body.id;

    // Missing message entirely
    const res = await request(app)
      .post(`/api/remote-agents/${id}/dispatch`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "Validation failed");
  });

  it("POST /api/remote-agents/:id/dispatch with empty parts returns 400", async () => {
    const createRes = await request(app)
      .post("/api/remote-agents")
      .send({
        name: "dispatch-empty",
        environment: "kubernetes",
        endpoint: "https://dispatch2.example.com",
      });

    const id = createRes.body.id;

    const res = await request(app)
      .post(`/api/remote-agents/${id}/dispatch`)
      .send({
        message: { role: "user", parts: [] },
      });

    expect(res.status).toBe(400);
  });

  it("POST /api/remote-agents/:id/dispatch succeeds for connected agent", async () => {
    const createRes = await request(app)
      .post("/api/remote-agents")
      .send({
        name: "dispatch-ok",
        environment: "kubernetes",
        endpoint: "https://dispatch-ok.example.com",
      });

    const id = createRes.body.id;
    // Connect the agent first
    await request(app).post(`/api/remote-agents/${id}/connect`);

    const res = await request(app)
      .post(`/api/remote-agents/${id}/dispatch`)
      .send({
        message: {
          role: "user",
          parts: [{ type: "text", text: "Hello agent" }],
        },
        skill: "kubectl-get",
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("taskId");
    expect(res.body.status).toBe("completed");
    expect(res.body.durationMs).toBe(42);
  });

  // ── GET /api/remote-agents/status ───────────────────────────────────────

  it("GET /api/remote-agents/status returns status map", async () => {
    const res = await request(app).get("/api/remote-agents/status");

    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("object");
    // Each entry should have name, status, connected
    for (const entry of Object.values(res.body) as Array<Record<string, unknown>>) {
      expect(entry).toHaveProperty("name");
      expect(entry).toHaveProperty("status");
      expect(entry).toHaveProperty("connected");
    }
  });

  // ── GET /api/remote-agents/:id/health ───────────────────────────────────

  it("GET /api/remote-agents/:id/health returns health info", async () => {
    const createRes = await request(app)
      .post("/api/remote-agents")
      .send({
        name: "health-agent",
        environment: "kubernetes",
        endpoint: "https://health.example.com",
      });

    const id = createRes.body.id;
    const res = await request(app).get(`/api/remote-agents/${id}/health`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("agentId", id);
    expect(res.body).toHaveProperty("status");
  });

  // ── 503 when manager is null ────────────────────────────────────────────

  it("returns 503 when manager is unavailable", async () => {
    const noManagerApp = express();
    noManagerApp.use(express.json());
    registerRemoteAgentRoutes(noManagerApp as unknown as Router, null);

    const res = await request(noManagerApp).get("/api/remote-agents");
    expect(res.status).toBe(503);
    expect(res.body).toHaveProperty("error");
  });
});
