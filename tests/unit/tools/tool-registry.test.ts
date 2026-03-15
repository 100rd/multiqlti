/**
 * Unit tests for ToolRegistry and the toolRegistry singleton (server/tools/index.ts).
 *
 * No external I/O is performed. Tests verify:
 *   - getAvailableTools() returns all registered tools
 *   - getToolByName() returns the correct tool definition
 *   - getToolByName("nonexistent") returns undefined (no crash)
 *   - All builtin tools in the singleton registry have required fields: name, description, execute
 *   - Registering a duplicate name overwrites the previous handler
 *   - unregister() removes the tool
 *   - execute() returns ToolResult with isError:false on success
 *   - execute() returns ToolResult with isError:true when tool not found
 *   - execute() returns ToolResult with isError:true when handler throws
 *   - getAvailableTools() filter by source works
 *   - getAvailableTools() filter by tags works
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolDefinition, ToolCall } from "../../../shared/types.js";
import { ToolRegistry } from "../../../server/tools/registry.js";
import type { ToolHandler } from "../../../server/tools/registry.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeHandler(
  name: string,
  source: "builtin" | "mcp" = "builtin",
  tags: string[] = [],
  executeResult = `result-from-${name}`,
): ToolHandler {
  return {
    definition: {
      name,
      description: `Description for ${name}`,
      inputSchema: { type: "object", properties: {} },
      source,
      tags,
    } satisfies ToolDefinition,
    execute: vi.fn<[Record<string, unknown>], Promise<string>>().mockResolvedValue(executeResult),
  };
}

function makeToolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `call-${name}`, name, arguments: args };
}

// ─── ToolRegistry — registration & retrieval ─────────────────────────────────

describe("ToolRegistry — register and retrieve", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("getAvailableTools() returns all registered tool definitions", () => {
    registry.register(makeHandler("tool_a"));
    registry.register(makeHandler("tool_b"));

    const tools = registry.getAvailableTools();

    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toContain("tool_a");
    expect(tools.map((t) => t.name)).toContain("tool_b");
  });

  it("getAvailableTools() returns empty array when registry is empty", () => {
    const tools = registry.getAvailableTools();

    expect(tools).toEqual([]);
  });

  it("getToolByName() returns correct definition for registered tool", () => {
    registry.register(makeHandler("search_tool", "builtin", ["search"]));

    const def = registry.getToolByName("search_tool");

    expect(def).toBeDefined();
    expect(def!.name).toBe("search_tool");
    expect(def!.source).toBe("builtin");
  });

  it("getToolByName() returns undefined for unregistered name — no crash", () => {
    const def = registry.getToolByName("nonexistent_tool");

    expect(def).toBeUndefined();
  });

  it("registering duplicate name overwrites the previous handler", () => {
    const original = makeHandler("my_tool", "builtin", [], "original");
    const replacement = makeHandler("my_tool", "builtin", [], "replacement");

    registry.register(original);
    registry.register(replacement);

    const tools = registry.getAvailableTools();
    // Should only have one entry for this name
    const matching = tools.filter((t) => t.name === "my_tool");
    expect(matching).toHaveLength(1);
  });

  it("registering duplicate name — latest handler is used for execute()", async () => {
    const original = makeHandler("my_tool", "builtin", [], "original");
    const replacement = makeHandler("my_tool", "builtin", [], "replacement");

    registry.register(original);
    registry.register(replacement);

    const result = await registry.execute(makeToolCall("my_tool"));

    expect(result.content).toBe("replacement");
    expect(result.isError).toBe(false);
  });
});

// ─── ToolRegistry — unregister ────────────────────────────────────────────────

describe("ToolRegistry — unregister()", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("removes a registered tool", () => {
    registry.register(makeHandler("removable"));
    registry.unregister("removable");

    expect(registry.getToolByName("removable")).toBeUndefined();
  });

  it("unregister on unknown name does not throw", () => {
    expect(() => registry.unregister("does-not-exist")).not.toThrow();
  });
});

// ─── ToolRegistry — filtering ─────────────────────────────────────────────────

describe("ToolRegistry — getAvailableTools() filtering", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(makeHandler("builtin_search", "builtin", ["search", "internet"]));
    registry.register(makeHandler("builtin_file", "builtin", ["filesystem"]));
    registry.register(makeHandler("mcp_github", "mcp", ["scm", "code"]));
  });

  it("filter by source 'builtin' returns only builtin tools", () => {
    const tools = registry.getAvailableTools({ source: "builtin" });

    expect(tools.every((t) => t.source === "builtin")).toBe(true);
    expect(tools.map((t) => t.name)).not.toContain("mcp_github");
  });

  it("filter by source 'mcp' returns only mcp tools", () => {
    const tools = registry.getAvailableTools({ source: "mcp" });

    expect(tools.every((t) => t.source === "mcp")).toBe(true);
    expect(tools.map((t) => t.name)).toContain("mcp_github");
  });

  it("filter by tags returns tools having at least one matching tag", () => {
    const tools = registry.getAvailableTools({ tags: ["search"] });

    expect(tools.map((t) => t.name)).toContain("builtin_search");
    expect(tools.map((t) => t.name)).not.toContain("builtin_file");
  });

  it("filter by tags with no match returns empty array", () => {
    const tools = registry.getAvailableTools({ tags: ["nonexistent-tag"] });

    expect(tools).toEqual([]);
  });

  it("no filter returns all tools", () => {
    const tools = registry.getAvailableTools();

    expect(tools).toHaveLength(3);
  });
});

// ─── ToolRegistry — execute() ─────────────────────────────────────────────────

describe("ToolRegistry — execute()", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    vi.clearAllMocks();
  });

  it("returns ToolResult with isError:false and correct content on success", async () => {
    registry.register(makeHandler("echo_tool", "builtin", [], "echo output"));

    const result = await registry.execute(makeToolCall("echo_tool", { input: "hello" }));

    expect(result.isError).toBe(false);
    expect(result.content).toBe("echo output");
    expect(result.toolCallId).toBe("call-echo_tool");
  });

  it("passes arguments to the handler execute function", async () => {
    const handler = makeHandler("arg_tool");
    registry.register(handler);

    const args = { key: "value", num: 42 };
    await registry.execute(makeToolCall("arg_tool", args));

    expect(handler.execute).toHaveBeenCalledWith(args);
  });

  it("returns ToolResult with isError:true when tool is not found", async () => {
    const result = await registry.execute(makeToolCall("missing_tool"));

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not found/i);
    expect(result.toolCallId).toBe("call-missing_tool");
  });

  it("returns ToolResult with isError:true when handler throws", async () => {
    const errorHandler: ToolHandler = {
      definition: {
        name: "throwing_tool",
        description: "Always throws",
        inputSchema: {},
        source: "builtin",
      },
      execute: vi.fn().mockRejectedValue(new Error("Execution exploded")),
    };
    registry.register(errorHandler);

    const result = await registry.execute(makeToolCall("throwing_tool"));

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/execution exploded/i);
    expect(result.toolCallId).toBe("call-throwing_tool");
  });

  it("does not throw when handler throws — wraps error in ToolResult", async () => {
    const errorHandler: ToolHandler = {
      definition: {
        name: "boom",
        description: "Boom",
        inputSchema: {},
        source: "builtin",
      },
      execute: vi.fn().mockRejectedValue(new Error("BOOM")),
    };
    registry.register(errorHandler);

    await expect(registry.execute(makeToolCall("boom"))).resolves.toBeDefined();
  });
});

// ─── ToolRegistry — required fields validation ───────────────────────────────

describe("ToolRegistry — tool definition shape", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(makeHandler("tool_x", "builtin", ["tag1"]));
  });

  it("each tool definition has 'name' field", () => {
    const tools = registry.getAvailableTools();
    for (const tool of tools) {
      expect(tool.name).toBeDefined();
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
    }
  });

  it("each tool definition has 'description' field", () => {
    const tools = registry.getAvailableTools();
    for (const tool of tools) {
      expect(tool.description).toBeDefined();
      expect(typeof tool.description).toBe("string");
    }
  });

  it("each tool definition has 'inputSchema' field", () => {
    const tools = registry.getAvailableTools();
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it("each registered handler has an 'execute' function", () => {
    const handler = makeHandler("exec_check");
    registry.register(handler);

    expect(typeof handler.execute).toBe("function");
  });
});

// ─── toolRegistry singleton — builtin tools ───────────────────────────────────

describe("toolRegistry singleton — builtin tool registration", () => {
  it("getAvailableTools() returns a non-empty array", async () => {
    // Mock storage and config to avoid import-side-effects from the builtins
    vi.mock("../../../server/storage.js", () => ({
      storage: {
        getLlmRequests: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
        searchMemories: vi.fn().mockResolvedValue([]),
      },
    }));
    vi.mock("../../../server/config/loader.js", () => ({
      configLoader: {
        get: vi.fn().mockReturnValue({ providers: { tavily: undefined } }),
      },
    }));

    const { toolRegistry } = await import("../../../server/tools/index.js");

    const tools = toolRegistry.getAvailableTools();

    expect(tools.length).toBeGreaterThan(0);
  });

  it("all registered builtin tools have required fields", async () => {
    const { toolRegistry } = await import("../../../server/tools/index.js");

    const tools = toolRegistry.getAvailableTools();

    for (const tool of tools) {
      expect(tool.name, `tool ${tool.name} missing name`).toBeTruthy();
      expect(tool.description, `tool ${tool.name} missing description`).toBeTruthy();
      expect(tool.inputSchema, `tool ${tool.name} missing inputSchema`).toBeDefined();
      expect(
        tool.source,
        `tool ${tool.name} missing source`,
      ).toMatch(/^(builtin|mcp)$/);
    }
  });

  it("getToolByName('web_search') returns the web search tool", async () => {
    const { toolRegistry } = await import("../../../server/tools/index.js");

    const tool = toolRegistry.getToolByName("web_search");

    expect(tool).toBeDefined();
    expect(tool!.name).toBe("web_search");
  });

  it("getToolByName('url_reader') returns the URL reader tool", async () => {
    const { toolRegistry } = await import("../../../server/tools/index.js");

    const tool = toolRegistry.getToolByName("url_reader");

    expect(tool).toBeDefined();
    expect(tool!.name).toBe("url_reader");
  });

  it("getToolByName('knowledge_search') returns the knowledge search tool", async () => {
    const { toolRegistry } = await import("../../../server/tools/index.js");

    const tool = toolRegistry.getToolByName("knowledge_search");

    expect(tool).toBeDefined();
    expect(tool!.name).toBe("knowledge_search");
  });

  it("getToolByName('memory_search') returns the memory search tool", async () => {
    const { toolRegistry } = await import("../../../server/tools/index.js");

    const tool = toolRegistry.getToolByName("memory_search");

    expect(tool).toBeDefined();
    expect(tool!.name).toBe("memory_search");
  });

  it("getToolByName('nonexistent') returns undefined", async () => {
    const { toolRegistry } = await import("../../../server/tools/index.js");

    const tool = toolRegistry.getToolByName("nonexistent_tool_xyz");

    expect(tool).toBeUndefined();
  });
});
