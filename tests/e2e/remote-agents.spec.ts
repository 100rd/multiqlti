/**
 * E2E tests for the Remote Agent system (Phase 8.12).
 *
 * Two categories:
 *   1. A2A Protocol tests -- start an in-process test agent and verify
 *      the A2A protocol endpoints directly (no DB needed).
 *   2. API tests -- hit /api/remote-agents via the Playwright webServer.
 *      These require DATABASE_URL and are skipped when absent.
 */
import { test, expect, request as playwrightRequest } from "@playwright/test";
import { startTestAgent, type TestAgentHandle } from "../helpers/test-agent";
import { getAuthToken } from "./helpers/auth";

const BASE_URL_FALLBACK = "http://localhost:3099";
const HAS_DATABASE = !!process.env.DATABASE_URL;

// ─── A2A Protocol Tests (no DB required) ──────────────────────────────────────

test.describe("Remote Agents — A2A Protocol", () => {
  let handle: TestAgentHandle;

  test.beforeAll(async () => {
    handle = await startTestAgent();
  });

  test.afterAll(async () => {
    await handle.stop();
  });

  test("test agent responds to health check", async () => {
    const res = await fetch(`${handle.url}/healthz`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; agent: string; tools: number };
    expect(body.status).toBe("ok");
    expect(body.agent).toBe("test-agent");
    expect(body.tools).toBeGreaterThanOrEqual(1);
  });

  test("test agent serves agent card at /.well-known/agent.json", async () => {
    const res = await fetch(`${handle.url}/.well-known/agent.json`);
    expect(res.status).toBe(200);

    const card = (await res.json()) as {
      name: string;
      description: string;
      version: string;
      url: string;
      capabilities: { streaming: boolean };
      skills: Array<{ id: string; name: string; description: string }>;
    };

    expect(card.name).toBe("test-agent");
    expect(card.version).toBe("0.1.0");
    expect(card.capabilities).toEqual({ streaming: false });
    expect(card.skills.length).toBeGreaterThanOrEqual(1);
    expect(card.skills[0].id).toBe("echo");
  });

  test("test agent handles A2A message/send", async () => {
    const rpcPayload = {
      jsonrpc: "2.0",
      id: "test-1",
      method: "message/send",
      params: {
        message: {
          parts: [{ text: "hello world" }],
        },
      },
    };

    const res = await fetch(`${handle.url}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpcPayload),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      jsonrpc: string;
      id: string;
      result: {
        id: string;
        status: string;
        output: { role: string; parts: Array<{ type: string; text: string }> };
      };
    };

    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe("test-1");
    expect(body.result.status).toBe("completed");
    expect(body.result.output.parts[0].text).toContain("Echo:");
    expect(body.result.output.parts[0].text).toContain("hello world");
  });

  test("test agent routes to specific skill via skill param", async () => {
    const rpcPayload = {
      jsonrpc: "2.0",
      id: "test-skill",
      method: "message/send",
      params: {
        skill: "echo",
        message: {
          parts: [{ text: "skill routing" }],
        },
      },
    };

    const res = await fetch(`${handle.url}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpcPayload),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { output: { parts: Array<{ text: string }> } };
    };
    expect(body.result.output.parts[0].text).toBe("Echo: skill routing");
  });

  test("test agent returns error for tasks/get (stateless)", async () => {
    const rpcPayload = {
      jsonrpc: "2.0",
      id: "test-get",
      method: "tasks/get",
      params: { id: "some-task" },
    };

    const res = await fetch(`${handle.url}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpcPayload),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toContain("Stateless");
  });

  test("test agent returns error for unknown RPC method", async () => {
    const rpcPayload = {
      jsonrpc: "2.0",
      id: "test-unknown",
      method: "unknown/method",
      params: {},
    };

    const res = await fetch(`${handle.url}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpcPayload),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toContain("Method not found");
  });

  test("test agent returns 404 for unknown routes", async () => {
    const res = await fetch(`${handle.url}/nonexistent`);
    expect(res.status).toBe(404);
  });

  test("test agent serves MCP tool listing at /mcp", async () => {
    const res = await fetch(`${handle.url}/mcp`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    };
    expect(body.tools.length).toBeGreaterThanOrEqual(1);
    expect(body.tools[0].name).toBe("echo");
  });
});

// ─── A2A Auth Tests (separate agent with AUTH_TOKEN) ──────────────────────────

test.describe("Remote Agents — A2A Auth", () => {
  let handle: TestAgentHandle;
  const AUTH_TOKEN = "test-secret-token-12345";

  test.beforeAll(async () => {
    // Set AUTH_TOKEN before starting the agent
    process.env.AUTH_TOKEN = AUTH_TOKEN;
    handle = await startTestAgent();
  });

  test.afterAll(async () => {
    await handle.stop();
    delete process.env.AUTH_TOKEN;
  });

  test("rejects unauthorized requests when AUTH_TOKEN set", async () => {
    const rpcPayload = {
      jsonrpc: "2.0",
      id: "auth-test",
      method: "message/send",
      params: {
        message: { parts: [{ text: "unauthorized" }] },
      },
    };

    const res = await fetch(`${handle.url}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpcPayload),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.message).toBe("Unauthorized");
  });

  test("accepts authorized requests with correct Bearer token", async () => {
    const rpcPayload = {
      jsonrpc: "2.0",
      id: "auth-ok",
      method: "message/send",
      params: {
        message: { parts: [{ text: "authorized" }] },
      },
    };

    const res = await fetch(`${handle.url}/a2a`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify(rpcPayload),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { status: string };
    };
    expect(body.result.status).toBe("completed");
  });

  test("rejects requests with wrong Bearer token", async () => {
    const rpcPayload = {
      jsonrpc: "2.0",
      id: "auth-wrong",
      method: "message/send",
      params: {
        message: { parts: [{ text: "wrong token" }] },
      },
    };

    const res = await fetch(`${handle.url}/a2a`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer wrong-token",
      },
      body: JSON.stringify(rpcPayload),
    });

    expect(res.status).toBe(401);
  });
});

// ─── Custom Tools Test (separate agent) ───────────────────────────────────────

test.describe("Remote Agents — Custom Tools", () => {
  let handle: TestAgentHandle;

  test.beforeAll(async () => {
    handle = await startTestAgent(undefined, [
      {
        name: "add",
        description: "Add two numbers",
        handler: async (input) => {
          const nums = String(input.input).split("+").map(Number);
          return { content: String(nums.reduce((a, b) => a + b, 0)) };
        },
      },
      {
        name: "uppercase",
        description: "Convert text to uppercase",
        handler: async (input) => ({ content: String(input.input).toUpperCase() }),
      },
    ]);
  });

  test.afterAll(async () => {
    await handle.stop();
  });

  test("agent card lists custom tools alongside default echo", async () => {
    const res = await fetch(`${handle.url}/.well-known/agent.json`);
    const card = (await res.json()) as {
      skills: Array<{ id: string }>;
    };

    const ids = card.skills.map((s) => s.id);
    expect(ids).toContain("echo");
    expect(ids).toContain("add");
    expect(ids).toContain("uppercase");
  });

  test("custom tool invoked via skill routing", async () => {
    const rpcPayload = {
      jsonrpc: "2.0",
      id: "custom-1",
      method: "message/send",
      params: {
        skill: "uppercase",
        message: { parts: [{ text: "hello" }] },
      },
    };

    const res = await fetch(`${handle.url}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpcPayload),
    });

    const body = (await res.json()) as {
      result: { output: { parts: Array<{ text: string }> } };
    };
    expect(body.result.output.parts[0].text).toBe("HELLO");
  });
});

// ─── API Tests (DB required) ──────────────────────────────────────────────────

test.describe("Remote Agents — API (DB)", () => {
  /** Create an authenticated API context against the Playwright webServer. */
  async function authenticatedApiContext(baseURL: string) {
    const token = await getAuthToken(baseURL);
    return playwrightRequest.newContext({
      baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
  }

  test("GET /api/remote-agents returns array (DB)", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.get("/api/remote-agents");
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });

  test("POST /api/remote-agents registers agent (DB)", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.post("/api/remote-agents", {
        data: {
          name: "e2e-test-agent",
          environment: "kubernetes",
          endpoint: "https://e2e-agent.example.com",
        },
      });
      expect(res.status()).toBe(201);
      const body = (await res.json()) as { id: string; name: string };
      expect(body.name).toBe("e2e-test-agent");
      expect(body.id).toBeTruthy();

      // Cleanup -- delete the agent we just created
      await ctx.delete(`/api/remote-agents/${body.id}`);
    } finally {
      await ctx.dispose();
    }
  });

  test("POST /api/remote-agents validation rejects invalid payload (DB)", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.post("/api/remote-agents", {
        data: { name: "", environment: "invalid" },
      });
      expect(res.status()).toBe(400);
    } finally {
      await ctx.dispose();
    }
  });

  test("GET /api/remote-agents/status returns status map (DB)", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.get("/api/remote-agents/status");
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(typeof body).toBe("object");
    } finally {
      await ctx.dispose();
    }
  });

  test("DELETE /api/remote-agents/:id returns 204 (DB)", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      // Create then delete
      const createRes = await ctx.post("/api/remote-agents", {
        data: {
          name: "e2e-delete-me",
          environment: "linux",
          endpoint: "https://delete-me.example.com",
        },
      });
      const { id } = (await createRes.json()) as { id: string };

      const res = await ctx.delete(`/api/remote-agents/${id}`);
      expect(res.status()).toBe(204);

      // Verify deletion
      const getRes = await ctx.get(`/api/remote-agents/${id}`);
      expect(getRes.status()).toBe(404);
    } finally {
      await ctx.dispose();
    }
  });
});
