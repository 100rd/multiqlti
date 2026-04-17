/**
 * Tests for server/tools/workspace-registry.ts
 * Covers: per-workspace isolation, overlay management, execution dispatch,
 * rollback, HTTP opt-in, timeout enforcement, result truncation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRegistry } from "../../../server/tools/registry.js";
import { WorkspaceToolRegistry } from "../../../server/tools/workspace-registry.js";
import type { SdkModule, NormalisedToolDefinition } from "../../../packages/sdk/src/types.js";
import type { SandboxLimits } from "../../../server/tools/sandbox-vm.js";

function makeTool(name: string, handler?: () => Promise<string>): NormalisedToolDefinition {
  return {
    _kind: "tool",
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    scopes: [],
    handler: handler ?? (async () => `result from ${name}`),
    sdkVersion: "0.1.0",
  };
}

function makeModule(tools: NormalisedToolDefinition[]): SdkModule {
  return { tools };
}

const FAST_LIMITS: SandboxLimits = {
  executionTimeoutMs: 2_000,
  maxResultLength: 512_000,
};

describe("WorkspaceToolRegistry — isolation", () => {
  let globalReg: ToolRegistry;
  let wsReg: WorkspaceToolRegistry;

  beforeEach(() => {
    globalReg = new ToolRegistry();
    wsReg = new WorkspaceToolRegistry(globalReg, FAST_LIMITS);
  });

  it("1. workspace A tools are NOT visible to workspace B", () => {
    wsReg.setWorkspaceOverlay("ws-a", "src1", makeModule([makeTool("tool_a")]));
    wsReg.setWorkspaceOverlay("ws-b", "src1", makeModule([makeTool("tool_b")]));

    const wsATools = wsReg.getCustomToolDefs("ws-a").map((t) => t.name);
    const wsBTools = wsReg.getCustomToolDefs("ws-b").map((t) => t.name);

    expect(wsATools).toContain("tool_a");
    expect(wsATools).not.toContain("tool_b");
    expect(wsBTools).toContain("tool_b");
    expect(wsBTools).not.toContain("tool_a");
  });

  it("2. workspace with no overlays returns only global tools", () => {
    globalReg.register({
      definition: {
        name: "global_tool",
        description: "Global",
        inputSchema: { type: "object", properties: {} },
        source: "builtin",
      },
      execute: async () => "global",
    });

    const tools = wsReg.getAvailableTools("empty-ws");
    expect(tools.map((t) => t.name)).toContain("global_tool");
  });

  it("3. workspace overlay tool shadows global tool with same name", () => {
    globalReg.register({
      definition: {
        name: "shared_tool",
        description: "Global version",
        inputSchema: { type: "object", properties: {} },
        source: "builtin",
      },
      execute: async () => "from-global",
    });

    wsReg.setWorkspaceOverlay("ws-custom", "src1", makeModule([
      makeTool("shared_tool"),
    ]));

    const tools = wsReg.getAvailableTools("ws-custom");
    const sharedDef = tools.find((t) => t.name === "shared_tool");
    expect(sharedDef).toBeDefined();
    // Should have 'custom' tag from the overlay version
    expect(sharedDef!.tags).toContain("custom");
  });

  it("4. removeWorkspaceOverlay removes only that source", () => {
    wsReg.setWorkspaceOverlay("ws-test", "src1", makeModule([makeTool("tool_src1")]));
    wsReg.setWorkspaceOverlay("ws-test", "src2", makeModule([makeTool("tool_src2")]));

    wsReg.removeWorkspaceOverlay("ws-test", "src1");

    const tools = wsReg.getCustomToolDefs("ws-test").map((t) => t.name);
    expect(tools).not.toContain("tool_src1");
    expect(tools).toContain("tool_src2");
  });

  it("5. clearWorkspaceOverlays removes all workspace tools", () => {
    wsReg.setWorkspaceOverlay("ws-clear", "src1", makeModule([makeTool("tool1")]));
    wsReg.setWorkspaceOverlay("ws-clear", "src2", makeModule([makeTool("tool2")]));

    wsReg.clearWorkspaceOverlays("ws-clear");

    const tools = wsReg.getCustomToolDefs("ws-clear");
    expect(tools).toHaveLength(0);
  });

  it("6. duplicate tool names across sources — first source wins (Set dedup)", () => {
    wsReg.setWorkspaceOverlay("ws-dedup", "src1", makeModule([makeTool("dup_tool")]));
    wsReg.setWorkspaceOverlay("ws-dedup", "src2", makeModule([makeTool("dup_tool")]));

    const tools = wsReg.getCustomToolDefs("ws-dedup").filter((t) => t.name === "dup_tool");
    expect(tools).toHaveLength(1);
  });
});

describe("WorkspaceToolRegistry — execution", () => {
  let globalReg: ToolRegistry;
  let wsReg: WorkspaceToolRegistry;

  beforeEach(() => {
    globalReg = new ToolRegistry();
    wsReg = new WorkspaceToolRegistry(globalReg, FAST_LIMITS);
  });

  it("7. execute dispatches to custom workspace tool", async () => {
    wsReg.setWorkspaceOverlay("ws-exec", "src1", makeModule([
      makeTool("custom_echo", async (args) => `ECHO: ${args.msg}`),
    ]));

    const result = await wsReg.execute("ws-exec", {
      id: "call-1",
      name: "custom_echo",
      arguments: { msg: "hello" },
    });

    expect(result.isError).toBe(false);
    expect(result.content).toBe("ECHO: hello");
  });

  it("8. execute falls through to global registry when tool not in overlay", async () => {
    globalReg.register({
      definition: { name: "global_fallback", description: "G", inputSchema: { type: "object", properties: {} }, source: "builtin" },
      execute: async () => "from-global",
    });

    const result = await wsReg.execute("ws-noop", {
      id: "call-2",
      name: "global_fallback",
      arguments: {},
    });

    expect(result.isError).toBe(false);
    expect(result.content).toBe("from-global");
  });

  it("9. execute returns isError=true when tool not found anywhere", async () => {
    const result = await wsReg.execute("ws-noop", {
      id: "call-3",
      name: "nonexistent_tool",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("10. execute returns isError=true when handler throws", async () => {
    wsReg.setWorkspaceOverlay("ws-throw", "src1", makeModule([
      makeTool("throw_tool", async () => { throw new Error("boom"); }),
    ]));

    const result = await wsReg.execute("ws-throw", {
      id: "call-4",
      name: "throw_tool",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("boom");
  });

  it("11. execute enforces timeout on slow handlers", async () => {
    const shortLimits: SandboxLimits = { executionTimeoutMs: 100, maxResultLength: 512_000 };
    const wsRegShort = new WorkspaceToolRegistry(globalReg, shortLimits);

    wsRegShort.setWorkspaceOverlay("ws-slow", "src1", makeModule([
      makeTool("slow_tool", async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return "done";
      }),
    ]));

    const result = await wsRegShort.execute("ws-slow", {
      id: "call-5",
      name: "slow_tool",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/timeout|exceeded/i);
  });

  it("12. result is truncated when it exceeds maxResultLength", async () => {
    const tinyLimits: SandboxLimits = { executionTimeoutMs: 2_000, maxResultLength: 10 };
    const wsRegTiny = new WorkspaceToolRegistry(globalReg, tinyLimits);

    wsRegTiny.setWorkspaceOverlay("ws-big", "src1", makeModule([
      makeTool("big_tool", async () => "A".repeat(1000)),
    ]));

    const result = await wsRegTiny.execute("ws-big", {
      id: "call-6",
      name: "big_tool",
      arguments: {},
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("[result truncated");
    expect(result.content.startsWith("AAAAAAAAAA")).toBe(true);
  });
});

describe("WorkspaceToolRegistry — HTTP opt-in", () => {
  let globalReg: ToolRegistry;
  let wsReg: WorkspaceToolRegistry;

  beforeEach(() => {
    globalReg = new ToolRegistry();
    wsReg = new WorkspaceToolRegistry(globalReg, FAST_LIMITS);
  });

  it("13. undeclared http:outbound — ctx.fetch throws when called", async () => {
    wsReg.setWorkspaceOverlay("ws-nohttp", "src1", makeModule([{
      _kind: "tool",
      name: "no_http_tool",
      description: "No HTTP",
      inputSchema: { type: "object", properties: {} },
      scopes: [], // no http:outbound
      handler: async (_args, ctx) => {
        try {
          await ctx.fetch("https://example.com");
          return "fetched";
        } catch (e) {
          return `blocked: ${(e as Error).message}`;
        }
      },
      sdkVersion: "0.1.0",
    }]));

    const result = await wsReg.execute("ws-nohttp", {
      id: "call-7",
      name: "no_http_tool",
      arguments: {},
    });

    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/blocked|http:outbound/i);
  });

  it("14. declared http:outbound — ctx.fetch is callable (HTTPS public)", async () => {
    // We cannot actually make a real HTTP call in tests,
    // but we can verify the fetch reference is present (not a throwing stub)
    let fetchWasCalled = false;

    const mockFetch = vi.fn(async () => new Response("mock response"));
    // Monkey-patch globalThis.fetch for the duration of this test
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    wsReg.setWorkspaceOverlay("ws-http", "src1", makeModule([{
      _kind: "tool",
      name: "http_tool",
      description: "Has HTTP",
      inputSchema: { type: "object", properties: {} },
      scopes: ["http:outbound"],
      handler: async (_args, ctx) => {
        const resp = await ctx.fetch("https://api.example.com/data");
        fetchWasCalled = true;
        return await resp.text();
      },
      sdkVersion: "0.1.0",
    }]));

    const result = await wsReg.execute("ws-http", {
      id: "call-8",
      name: "http_tool",
      arguments: {},
    });

    globalThis.fetch = original;

    expect(result.isError).toBe(false);
    expect(fetchWasCalled).toBe(true);
    expect(result.content).toBe("mock response");
  });
});

describe("WorkspaceToolRegistry — skills and roles", () => {
  let globalReg: ToolRegistry;
  let wsReg: WorkspaceToolRegistry;

  beforeEach(() => {
    globalReg = new ToolRegistry();
    wsReg = new WorkspaceToolRegistry(globalReg, FAST_LIMITS);
  });

  it("15. getCustomSkills returns skills from workspace overlays", () => {
    wsReg.setWorkspaceOverlay("ws-skills", "src1", {
      skills: [{
        _kind: "skill",
        name: "my_skill",
        description: "A skill",
        prompts: [{ id: "default", label: "Default", systemPrompt: "You are helpful." }],
        tools: [],
        defaults: {},
        tags: [],
        sdkVersion: "0.1.0",
      }],
    });

    const skills = wsReg.getCustomSkills("ws-skills");
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("my_skill");
  });

  it("16. getCustomRoles returns roles from workspace overlays", () => {
    wsReg.setWorkspaceOverlay("ws-roles", "src1", {
      roles: [{
        _kind: "role",
        name: "my_role",
        systemPrompt: "You are an expert.",
        allowedTools: ["code_search"],
        model: "claude-opus-4",
        sdkVersion: "0.1.0",
      }],
    });

    const roles = wsReg.getCustomRoles("ws-roles");
    expect(roles).toHaveLength(1);
    expect(roles[0].name).toBe("my_role");
    expect(roles[0].model).toBe("claude-opus-4");
  });

  it("17. skills and roles are workspace-isolated", () => {
    wsReg.setWorkspaceOverlay("ws-a2", "src1", {
      skills: [{
        _kind: "skill",
        name: "skill_a",
        description: "Skill A",
        prompts: [{ id: "d", label: "D", systemPrompt: "A" }],
        tools: [],
        defaults: {},
        tags: [],
        sdkVersion: "0.1.0",
      }],
    });

    const skillsB = wsReg.getCustomSkills("ws-b2");
    expect(skillsB).toHaveLength(0);
  });
});
