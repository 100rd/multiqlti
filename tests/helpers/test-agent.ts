/**
 * Test agent helper for E2E and integration tests.
 *
 * Provides an in-process A2A-compliant HTTP agent built on top of BaseAgent.
 * Each agent binds an OS-assigned ephemeral port (via listen(0)) so it can
 * never collide with a sibling agent or a leftover socket from a prior test.
 */
import { createServer as createNetServer } from "node:net";
import { BaseAgent } from "../../packages/remote-agent/src/base-agent.js";
import type { AgentToolHandler } from "../../packages/remote-agent/src/base-agent.js";

export { type AgentToolHandler } from "../../packages/remote-agent/src/base-agent.js";

class TestAgent extends BaseAgent {
  private customTools: AgentToolHandler[];

  constructor(port: number, tools: AgentToolHandler[] = []) {
    super({
      name: "test-agent",
      description: "Test agent for E2E tests",
      version: "0.1.0",
      port,
    });
    this.customTools = tools;
  }

  protected setupTools(): void {
    // Default echo tool
    this.registerTool({
      name: "echo",
      description: "Echo the input back",
      handler: async (input) => ({ content: `Echo: ${input.input}` }),
    });

    // Custom tools passed via constructor
    for (const tool of this.customTools) {
      this.registerTool(tool);
    }
  }
}

/**
 * Ask the OS for a free ephemeral port by binding a throwaway server to port 0
 * and reading back the assigned port. This is the same technique the `get-port`
 * family of libraries uses: the kernel guarantees the port is currently free,
 * and it will not re-hand the same ephemeral port to a second listener that
 * quickly, so serial test runs never collide.
 *
 * `portsHandedOut` additionally guards against the OS returning a port we have
 * already given to a still-running agent in this process (e.g. the "three
 * agents concurrently" test), eliminating the residual TOCTOU window entirely.
 */
const portsHandedOut = new Set<number>();

function freeEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function getEphemeralPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await freeEphemeralPort();
    if (port !== 0 && !portsHandedOut.has(port)) {
      portsHandedOut.add(port);
      return port;
    }
  }
  throw new Error("could not obtain a free ephemeral port after 20 attempts");
}

export interface TestAgentHandle {
  agent: TestAgent;
  port: number;
  url: string;
  stop: () => Promise<void>;
}

/**
 * Start a test agent on a random (or specified) port.
 *
 * Returns a handle with the agent instance, port, base URL, and a stop()
 * function that gracefully shuts the server down.
 *
 * Usage:
 * ```ts
 * const handle = await startTestAgent();
 * // ... test against handle.url ...
 * await handle.stop();
 * ```
 */
export async function startTestAgent(
  port?: number,
  tools?: AgentToolHandler[],
): Promise<TestAgentHandle> {
  const p = port ?? (await getEphemeralPort());
  const agent = new TestAgent(p, tools ?? []);
  await agent.start();
  return {
    agent,
    port: p,
    url: `http://localhost:${p}`,
    stop: async () => {
      await agent.stop();
      portsHandedOut.delete(p);
    },
  };
}
