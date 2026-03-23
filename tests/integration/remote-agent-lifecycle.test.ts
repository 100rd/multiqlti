/**
 * Integration tests for the Remote Agent lifecycle (Phase 8.12).
 *
 * Self-contained tests that start in-process test agents and communicate
 * with them via A2AClient. No database or main app required.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { startTestAgent, type TestAgentHandle, type AgentToolHandler } from "../helpers/test-agent.js";
import { A2AClient } from "../../server/remote-agents/a2a-client.js";

// ─── Single Agent Lifecycle ─────────────────────────────────────────────────

describe("Remote Agent Lifecycle", () => {
  let handle: TestAgentHandle;
  let client: A2AClient;

  beforeAll(async () => {
    handle = await startTestAgent();
    client = new A2AClient({ endpoint: handle.url });
  });

  afterAll(async () => {
    await handle.stop();
  });

  it("discovers agent card via A2AClient", async () => {
    const card = await client.discover();

    expect(card.name).toBe("test-agent");
    expect(card.version).toBe("0.1.0");
    expect(card.capabilities).toEqual({ streaming: false });
    expect(card.skills).toBeDefined();
    expect(card.skills!.length).toBeGreaterThanOrEqual(1);
    expect(card.skills![0].id).toBe("echo");
  });

  it("sends a task and receives completed response", async () => {
    const result = await client.sendTask({
      message: {
        role: "user",
        parts: [{ type: "text", text: "hello integration" }],
      },
    });

    expect(result.id).toBeTruthy();
    expect(result.status).toBe("completed");
    expect(result.output).toBeDefined();
    expect(result.output!.parts[0].text).toContain("Echo:");
    expect(result.output!.parts[0].text).toContain("hello integration");
  });

  it("sends a task with skill routing", async () => {
    const result = await client.sendTask({
      skill: "echo",
      message: {
        role: "user",
        parts: [{ type: "text", text: "routed message" }],
      },
    });

    expect(result.status).toBe("completed");
    expect(result.output!.parts[0].text).toBe("Echo: routed message");
  });

  it("getTask returns RPC error for stateless agent", async () => {
    await expect(client.getTask("some-task-id")).rejects.toThrow(
      /Stateless agent/,
    );
  });

  it("cancelTask returns RPC error for stateless agent", async () => {
    await expect(client.cancelTask("some-task-id")).rejects.toThrow(
      /Stateless agent/,
    );
  });

  it("handles multi-part messages", async () => {
    const result = await client.sendTask({
      message: {
        role: "user",
        parts: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      },
    });

    expect(result.status).toBe("completed");
    // BaseAgent concatenates parts with newline
    expect(result.output!.parts[0].text).toContain("line one");
    expect(result.output!.parts[0].text).toContain("line two");
  });

  it("each task gets a unique ID", async () => {
    const msg = {
      role: "user" as const,
      parts: [{ type: "text" as const, text: "id check" }],
    };

    const [r1, r2, r3] = await Promise.all([
      client.sendTask({ message: msg }),
      client.sendTask({ message: msg }),
      client.sendTask({ message: msg }),
    ]);

    const ids = new Set([r1.id, r2.id, r3.id]);
    expect(ids.size).toBe(3);
  });
});

// ─── Health Check (online/offline) ──────────────────────────────────────────

describe("Remote Agent Health Check", () => {
  it("health endpoint reports OK when running", async () => {
    const handle = await startTestAgent();
    try {
      const res = await fetch(`${handle.url}/healthz`);
      const body = (await res.json()) as { status: string; agent: string; tools: number };

      expect(res.status).toBe(200);
      expect(body.status).toBe("ok");
      expect(body.tools).toBeGreaterThanOrEqual(1);
    } finally {
      await handle.stop();
    }
  });

  it("connection fails after agent stops", async () => {
    const handle = await startTestAgent();
    const url = handle.url;
    await handle.stop();

    // After stopping, connection should fail
    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
  });

  it("A2AClient discover fails for unreachable endpoint", async () => {
    const client = new A2AClient({
      endpoint: "http://localhost:19999",
      timeoutMs: 2000,
    });

    await expect(client.discover()).rejects.toThrow();
  });
});

// ─── Agent Card Caching via Multiple Discover Calls ─────────────────────────

describe("Agent Card Discovery", () => {
  let handle: TestAgentHandle;

  beforeAll(async () => {
    handle = await startTestAgent();
  });

  afterAll(async () => {
    await handle.stop();
  });

  it("multiple discover calls return consistent card", async () => {
    const client = new A2AClient({ endpoint: handle.url });
    const [card1, card2, card3] = await Promise.all([
      client.discover(),
      client.discover(),
      client.discover(),
    ]);

    expect(card1.name).toBe(card2.name);
    expect(card2.name).toBe(card3.name);
    expect(card1.skills).toEqual(card2.skills);
    expect(card2.skills).toEqual(card3.skills);
  });

  it("agent card contains correct default output modes", async () => {
    const client = new A2AClient({ endpoint: handle.url });
    const card = await client.discover();

    expect(card).toHaveProperty("defaultInputModes");
    expect(card).toHaveProperty("defaultOutputModes");
  });
});

// ─── Multiple Agents on Different Ports ─────────────────────────────────────

describe("Multiple Agents", () => {
  const handles: TestAgentHandle[] = [];

  afterAll(async () => {
    await Promise.all(handles.map((h) => h.stop()));
  });

  it("three agents run concurrently on different ports", async () => {
    const h1 = await startTestAgent();
    const h2 = await startTestAgent();
    const h3 = await startTestAgent();
    handles.push(h1, h2, h3);

    // All on different ports
    const ports = new Set([h1.port, h2.port, h3.port]);
    expect(ports.size).toBe(3);

    // All respond to health check
    const results = await Promise.all([
      fetch(`${h1.url}/healthz`).then((r) => r.json()),
      fetch(`${h2.url}/healthz`).then((r) => r.json()),
      fetch(`${h3.url}/healthz`).then((r) => r.json()),
    ]);

    for (const r of results as Array<{ status: string }>) {
      expect(r.status).toBe("ok");
    }
  });

  it("each agent can be addressed independently via A2AClient", async () => {
    // Use the agents started above (via handles)
    expect(handles.length).toBe(3);

    const clients = handles.map((h) => new A2AClient({ endpoint: h.url }));
    const cards = await Promise.all(clients.map((c) => c.discover()));

    for (const card of cards) {
      expect(card.name).toBe("test-agent");
    }

    // Send different messages to each
    const results = await Promise.all(
      clients.map((c, i) =>
        c.sendTask({
          message: {
            role: "user",
            parts: [{ type: "text", text: `msg-${i}` }],
          },
        }),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      expect(results[i].status).toBe("completed");
      expect(results[i].output!.parts[0].text).toContain(`msg-${i}`);
    }
  });
});

// ─── Custom Tool Agents ─────────────────────────────────────────────────────

describe("Custom Tool Agent", () => {
  let handle: TestAgentHandle;

  beforeAll(async () => {
    const tools: AgentToolHandler[] = [
      {
        name: "reverse",
        description: "Reverse a string",
        handler: async (input) => ({
          content: String(input.input).split("").reverse().join(""),
        }),
      },
      {
        name: "count",
        description: "Count characters",
        handler: async (input) => ({
          content: String(String(input.input).length),
        }),
      },
    ];
    handle = await startTestAgent(undefined, tools);
  });

  afterAll(async () => {
    await handle.stop();
  });

  it("custom tools appear in agent card skills", async () => {
    const client = new A2AClient({ endpoint: handle.url });
    const card = await client.discover();

    const skillIds = card.skills!.map((s) => s.id);
    expect(skillIds).toContain("echo");
    expect(skillIds).toContain("reverse");
    expect(skillIds).toContain("count");
  });

  it("custom tool executes via skill routing", async () => {
    const client = new A2AClient({ endpoint: handle.url });
    const result = await client.sendTask({
      skill: "reverse",
      message: {
        role: "user",
        parts: [{ type: "text", text: "abcde" }],
      },
    });

    expect(result.status).toBe("completed");
    expect(result.output!.parts[0].text).toBe("edcba");
  });

  it("count tool returns character count", async () => {
    const client = new A2AClient({ endpoint: handle.url });
    const result = await client.sendTask({
      skill: "count",
      message: {
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
    });

    expect(result.status).toBe("completed");
    expect(result.output!.parts[0].text).toBe("5");
  });
});

// ─── Auth Token Tests ───────────────────────────────────────────────────────

describe("Agent Auth Token", () => {
  let handle: TestAgentHandle;
  const TOKEN = "integration-test-secret";

  beforeAll(async () => {
    process.env.AUTH_TOKEN = TOKEN;
    handle = await startTestAgent();
  });

  afterAll(async () => {
    await handle.stop();
    delete process.env.AUTH_TOKEN;
  });

  it("A2AClient with correct token succeeds", async () => {
    const client = new A2AClient({
      endpoint: handle.url,
      authToken: TOKEN,
    });

    const result = await client.sendTask({
      message: {
        role: "user",
        parts: [{ type: "text", text: "authed" }],
      },
    });

    expect(result.status).toBe("completed");
  });

  it("A2AClient without token gets RPC error", async () => {
    const client = new A2AClient({ endpoint: handle.url });

    // The agent returns 401, which A2AClient treats as HTTP error
    await expect(
      client.sendTask({
        message: {
          role: "user",
          parts: [{ type: "text", text: "no auth" }],
        },
      }),
    ).rejects.toThrow(/401/);
  });

  it("A2AClient with wrong token gets RPC error", async () => {
    const client = new A2AClient({
      endpoint: handle.url,
      authToken: "wrong-token",
    });

    // Agent returns 401 JSON-RPC response, client reads it
    await expect(
      client.sendTask({
        message: {
          role: "user",
          parts: [{ type: "text", text: "wrong auth" }],
        },
      }),
    ).rejects.toThrow();
  });

  it("discover (GET) works without auth token", async () => {
    // Discovery endpoint does not require auth
    const client = new A2AClient({ endpoint: handle.url });
    const card = await client.discover();
    expect(card.name).toBe("test-agent");
  });
});
