/**
 * Test agent helper for E2E and integration tests.
 *
 * Provides an in-process A2A-compliant HTTP agent built on top of BaseAgent.
 * Starts on a random high port (30000-40000) to avoid conflicts with
 * parallel test runs.
 */
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

/** Pick a random port in the 30000-40000 range. */
function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 10000);
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
  const p = port ?? randomPort();
  const agent = new TestAgent(p, tools ?? []);
  await agent.start();
  return {
    agent,
    port: p,
    url: `http://localhost:${p}`,
    stop: () => agent.stop(),
  };
}
