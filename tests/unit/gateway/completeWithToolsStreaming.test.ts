/**
 * Unit tests for Gateway.completeWithToolsStreaming (streaming-stage-execution, T11b).
 *
 * Asserts: a streamed tool turn runs end-to-end (tool-call → toolRegistry →
 * tool result → final text); maxIterations is honored; a provider WITHOUT a
 * streamEvents channel falls back to the blocking completeWithTools path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildTestGateway,
  ScriptedToolStreamProvider,
  SlowMockStreamingProvider,
  ev,
  TEST_MODEL_SLUG,
} from "../helpers/streaming-test-utils.js";
import { toolRegistry } from "../../../server/tools/index.js";
import type { ToolDefinition } from "../../../shared/types.js";

const TOOL: ToolDefinition = {
  name: "echo_tool",
  description: "echoes its input",
  inputSchema: { type: "object", properties: { value: { type: "string" } } },
  source: "builtin",
};

function params() {
  return {
    modelSlug: TEST_MODEL_SLUG,
    messages: [{ role: "user" as const, content: "use the tool" }],
    tools: [TOOL],
    maxIterations: 5,
  };
}

describe("Gateway.completeWithToolsStreaming", () => {
  beforeEach(() => {
    toolRegistry.register({
      definition: TOOL,
      execute: async (args) => `echoed:${String(args.value ?? "")}`,
    });
  });
  afterEach(() => toolRegistry.unregister("echo_tool"));

  it("runs a streamed tool turn end-to-end and returns the final assistant text", async () => {
    const provider = new ScriptedToolStreamProvider([
      // Turn 1: model asks for the tool.
      [
        ev.text("let me check"),
        ev.tool({ id: "c1", name: "echo_tool", arguments: { value: "hi" } }),
        ev.done("tool_use", 7),
      ],
      // Turn 2: model produces the final answer.
      [ev.text("final answer"), ev.done("stop", 5)],
    ]);
    const gateway = buildTestGateway(provider);
    const res = await gateway.completeWithToolsStreaming(params());
    expect(res.content).toBe("final answer");
    expect(res.toolCallLog).toHaveLength(1);
    expect(res.toolCallLog[0].result.content).toBe("echoed:hi");
    expect(res.tokensUsed).toBe(12);
  });

  it("forwards onDelta text from each streamed turn", async () => {
    const provider = new ScriptedToolStreamProvider([[ev.text("hello"), ev.done("stop", 3)]]);
    const gateway = buildTestGateway(provider);
    const seen: string[] = [];
    const res = await gateway.completeWithToolsStreaming(params(), {
      onDelta: (d) => seen.push(d),
    });
    expect(seen.join("")).toBe("hello");
    expect(res.content).toBe("hello");
  });

  it("terminates at maxIterations when the model never stops calling tools", async () => {
    // Every turn keeps asking for the tool.
    const provider = new ScriptedToolStreamProvider([
      [ev.tool({ id: "c", name: "echo_tool", arguments: { value: "loop" } }), ev.done("tool_use", 1)],
    ]);
    const gateway = buildTestGateway(provider);
    const res = await gateway.completeWithToolsStreaming({
      ...params(),
      maxIterations: 3,
    });
    // Loop bounded: 3 tool executions, then a terminal return.
    expect(res.toolCallLog.length).toBe(3);
  });

  it("falls back to the blocking tool path for a provider without streamEvents", async () => {
    // SlowMockStreamingProvider has no streamEvents → capability fallback.
    const gateway = buildTestGateway(new SlowMockStreamingProvider(["ignored"], 0, 9));
    const res = await gateway.completeWithToolsStreaming(params());
    // Fallback uses complete() (no tool calls) → returns its content.
    expect(typeof res.content).toBe("string");
    expect(res.toolCallLog).toEqual([]);
  });

  it("REJECTS an oversized tool-call (>64KiB args) and does NOT execute the tool (C1)", async () => {
    // Re-register echo_tool with a spy so we can assert it is never executed.
    const execSpy = vi.fn(async (args: Record<string, unknown>) => `echoed:${String(args.value ?? "")}`);
    toolRegistry.unregister("echo_tool");
    toolRegistry.register({ definition: TOOL, execute: execSpy });

    const huge = "x".repeat(70 * 1024); // > 64 KiB serialized
    const provider = new ScriptedToolStreamProvider([
      [ev.tool({ id: "big", name: "echo_tool", arguments: { value: huge } }), ev.done("tool_use", 1)],
    ]);
    const gateway = buildTestGateway(provider);

    await expect(gateway.completeWithToolsStreaming(params())).rejects.toThrow(/\[tool-validation\].*64KiB/);
    expect(execSpy).not.toHaveBeenCalled();
  });

  it("merges workspaceDefaults into a tool-call missing workspaceId before executing", async () => {
    // Capture the args the tool actually received.
    const execSpy = vi.fn(async (args: Record<string, unknown>) => `ws:${String(args.workspaceId ?? "none")}`);
    toolRegistry.unregister("echo_tool");
    // Allow workspaceId on the schema so the C1 validator does not reject it.
    const wsTool: ToolDefinition = {
      ...TOOL,
      inputSchema: { type: "object", properties: { value: { type: "string" }, workspaceId: { type: "string" } } },
    };
    toolRegistry.register({ definition: wsTool, execute: execSpy });

    const provider = new ScriptedToolStreamProvider([
      // Tool-call omits workspaceId → should be filled from workspaceDefaults.
      [ev.tool({ id: "w1", name: "echo_tool", arguments: { value: "v" } }), ev.done("tool_use", 1)],
      [ev.text("done"), ev.done("stop", 1)],
    ]);
    const gateway = buildTestGateway(provider);

    const res = await gateway.completeWithToolsStreaming({
      ...params(),
      tools: [wsTool],
      workspaceDefaults: { workspaceId: "ws-1" },
    });

    // The merged workspaceId reached the executed tool...
    expect(execSpy).toHaveBeenCalledOnce();
    expect(execSpy.mock.calls[0][0].workspaceId).toBe("ws-1");
    // ...and is recorded in the toolCallLog's call arguments.
    expect(res.toolCallLog[0].call.arguments.workspaceId).toBe("ws-1");
  });
});
