import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { BaseAgent } from "../src/base-agent.js";
import type { AgentToolHandler } from "../src/base-agent.js";

// ─── Concrete test agent ────────────────────────────────────────────────────

class TestAgent extends BaseAgent {
  protected setupTools(): void {
    this.registerTool({
      name: "echo",
      description: "Echo the input back",
      handler: async (input) => ({ content: `Echo: ${input.input}` }),
    });
    this.registerTool({
      name: "reverse",
      description: "Reverse the input string",
      inputSchema: { type: "object", properties: { input: { type: "string" } } },
      handler: async (input) => ({
        content: String(input.input).split("").reverse().join(""),
      }),
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const PORT = 19876; // Use a high port unlikely to conflict
const BASE = `http://localhost:${PORT}`;

function jsonRpcRequest(method: string, params?: unknown, id: string | number = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: params ?? {},
  };
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe("BaseAgent", () => {
  let agent: TestAgent;

  beforeAll(async () => {
    agent = new TestAgent({
      name: "test-agent",
      description: "A test agent",
      version: "0.1.0",
      port: PORT,
    });
    await agent.start();
  });

  afterAll(async () => {
    await agent.stop();
  });

  afterEach(() => {
    delete process.env.AUTH_TOKEN;
  });

  it("returns agent card at /.well-known/agent.json", async () => {
    const res = await fetch(`${BASE}/.well-known/agent.json`);
    expect(res.status).toBe(200);

    const card = await res.json();
    expect(card.name).toBe("test-agent");
    expect(card.description).toBe("A test agent");
    expect(card.version).toBe("0.1.0");
    expect(card.capabilities).toEqual({ streaming: false });
    expect(card.skills).toHaveLength(2);
    expect(card.skills[0].id).toBe("echo");
    expect(card.skills[1].id).toBe("reverse");
    expect(card.defaultInputModes).toEqual(["text/plain"]);
    expect(card.defaultOutputModes).toEqual(["text/plain"]);
  });

  it("returns health status at /healthz", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.agent).toBe("test-agent");
    expect(body.tools).toBe(2);
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`${BASE}/unknown`);
    expect(res.status).toBe(404);
  });

  it("handles A2A message/send and routes to default tool", async () => {
    const res = await fetch(`${BASE}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        jsonRpcRequest("message/send", {
          message: { parts: [{ text: "hello world" }] },
        }),
      ),
    });
    expect(res.status).toBe(200);

    const rpc = await res.json();
    expect(rpc.jsonrpc).toBe("2.0");
    expect(rpc.id).toBe(1);
    expect(rpc.result.status).toBe("completed");
    expect(rpc.result.output.parts[0].text).toBe("Echo: hello world");
    // Task ID should be a valid UUID
    expect(rpc.result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("routes to a specific skill when skill param is provided", async () => {
    const res = await fetch(`${BASE}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        jsonRpcRequest("message/send", {
          message: { parts: [{ text: "abc" }] },
          skill: "reverse",
        }),
      ),
    });
    expect(res.status).toBe(200);

    const rpc = await res.json();
    expect(rpc.result.status).toBe("completed");
    expect(rpc.result.output.parts[0].text).toBe("cba");
  });

  it("returns error for tasks/get (stateless)", async () => {
    const res = await fetch(`${BASE}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(jsonRpcRequest("tasks/get", { id: "some-id" })),
    });
    expect(res.status).toBe(200);

    const rpc = await res.json();
    expect(rpc.error).toBeDefined();
    expect(rpc.error.code).toBe(-32601);
    expect(rpc.error.message).toContain("Stateless");
  });

  it("returns error for tasks/cancel (stateless)", async () => {
    const res = await fetch(`${BASE}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(jsonRpcRequest("tasks/cancel", { id: "some-id" })),
    });
    expect(res.status).toBe(200);

    const rpc = await res.json();
    expect(rpc.error).toBeDefined();
    expect(rpc.error.code).toBe(-32601);
    expect(rpc.error.message).toContain("tasks/cancel not supported");
  });

  it("returns error for unknown A2A methods", async () => {
    const res = await fetch(`${BASE}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(jsonRpcRequest("unknown/method")),
    });
    expect(res.status).toBe(200);

    const rpc = await res.json();
    expect(rpc.error).toBeDefined();
    expect(rpc.error.code).toBe(-32601);
    expect(rpc.error.message).toBe("Method not found");
  });

  it("returns MCP tool list at /mcp", async () => {
    const res = await fetch(`${BASE}/mcp`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tools).toHaveLength(2);
    expect(body.tools[0].name).toBe("echo");
    expect(body.tools[0].description).toBe("Echo the input back");
    // echo has no custom inputSchema, so should get the default
    expect(body.tools[0].inputSchema).toEqual({
      type: "object",
      properties: { input: { type: "string" } },
    });
    // reverse has a custom inputSchema
    expect(body.tools[1].name).toBe("reverse");
    expect(body.tools[1].inputSchema).toEqual({
      type: "object",
      properties: { input: { type: "string" } },
    });
  });

  it("rejects A2A requests without Bearer token when AUTH_TOKEN is set", async () => {
    process.env.AUTH_TOKEN = "secret-token-123";

    const res = await fetch(`${BASE}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        jsonRpcRequest("message/send", {
          message: { parts: [{ text: "test" }] },
        }),
      ),
    });
    expect(res.status).toBe(401);

    const rpc = await res.json();
    expect(rpc.error.message).toBe("Unauthorized");
  });

  it("accepts A2A requests with correct Bearer token when AUTH_TOKEN is set", async () => {
    process.env.AUTH_TOKEN = "secret-token-123";

    const res = await fetch(`${BASE}/a2a`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token-123",
      },
      body: JSON.stringify(
        jsonRpcRequest("message/send", {
          message: { parts: [{ text: "secure input" }] },
        }),
      ),
    });
    expect(res.status).toBe(200);

    const rpc = await res.json();
    expect(rpc.result.status).toBe("completed");
    expect(rpc.result.output.parts[0].text).toBe("Echo: secure input");
  });

  it("concatenates multi-part message text", async () => {
    const res = await fetch(`${BASE}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        jsonRpcRequest("message/send", {
          message: { parts: [{ text: "hello" }, { text: "world" }] },
        }),
      ),
    });
    expect(res.status).toBe(200);

    const rpc = await res.json();
    expect(rpc.result.output.parts[0].text).toBe("Echo: hello\nworld");
  });
});

// ─── Agent with no tools ────────────────────────────────────────────────────

describe("BaseAgent with no tools", () => {
  class EmptyAgent extends BaseAgent {
    protected setupTools(): void {
      // No tools registered
    }
  }

  let agent: EmptyAgent;
  const EMPTY_PORT = 19877;
  const EMPTY_BASE = `http://localhost:${EMPTY_PORT}`;

  beforeAll(async () => {
    agent = new EmptyAgent({
      name: "empty-agent",
      description: "An agent with no tools",
      version: "0.0.1",
      port: EMPTY_PORT,
    });
    await agent.start();
  });

  afterAll(async () => {
    await agent.stop();
  });

  it("returns 'No tools registered' when message/send is called with no tools", async () => {
    const res = await fetch(`${EMPTY_BASE}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        jsonRpcRequest("message/send", {
          message: { parts: [{ text: "anything" }] },
        }),
      ),
    });
    expect(res.status).toBe(200);

    const rpc = await res.json();
    expect(rpc.result.status).toBe("completed");
    expect(rpc.result.output.parts[0].text).toBe("No tools registered");
  });
});
