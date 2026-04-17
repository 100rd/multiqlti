/**
 * Tests for packages/sdk/src/index.ts
 * Covers: defineTool, defineSkill, defineRole — validation + normalisation.
 */

import { describe, it, expect } from "vitest";
import {
  defineTool,
  defineSkill,
  defineRole,
  SDK_VERSION,
} from "../../../packages/sdk/src/index.js";

// ─── defineTool ───────────────────────────────────────────────────────────────

describe("defineTool", () => {
  it("1. returns a normalised tool definition with _kind = 'tool'", () => {
    const t = defineTool({
      name: "hello_world",
      description: "Says hello",
      inputSchema: { type: "object", properties: { name: { type: "string" } } },
      handler: async (args) => `Hello, ${args.name}!`,
    });
    expect(t._kind).toBe("tool");
    expect(t.name).toBe("hello_world");
    expect(t.description).toBe("Says hello");
    expect(t.sdkVersion).toBe(SDK_VERSION);
  });

  it("2. default scopes is empty array when none specified", () => {
    const t = defineTool({
      name: "minimal_tool",
      description: "Minimal",
      inputSchema: { type: "object", properties: {} },
      handler: async () => "ok",
    });
    expect(t.scopes).toEqual([]);
  });

  it("3. deduplicates scopes", () => {
    const t = defineTool({
      name: "scoped_tool",
      description: "Has scopes",
      inputSchema: { type: "object", properties: {} },
      scopes: ["http:outbound", "http:outbound", "read:workspace"],
      handler: async () => "ok",
    });
    expect(t.scopes).toHaveLength(2);
    expect(t.scopes).toContain("http:outbound");
    expect(t.scopes).toContain("read:workspace");
  });

  it("4. throws on invalid name (starts with digit)", () => {
    expect(() =>
      defineTool({
        name: "1invalid",
        description: "bad name",
        inputSchema: { type: "object", properties: {} },
        handler: async () => "",
      }),
    ).toThrow(/invalid/i);
  });

  it("5. throws on name with spaces", () => {
    expect(() =>
      defineTool({
        name: "my tool",
        description: "bad name",
        inputSchema: { type: "object", properties: {} },
        handler: async () => "",
      }),
    ).toThrow(/invalid/i);
  });

  it("6. throws on empty description", () => {
    expect(() =>
      defineTool({
        name: "good_name",
        description: "   ",
        inputSchema: { type: "object", properties: {} },
        handler: async () => "",
      }),
    ).toThrow(/description/i);
  });

  it("7. throws when inputSchema type is not 'object'", () => {
    expect(() =>
      defineTool({
        name: "bad_schema",
        description: "bad schema",
        inputSchema: { type: "string" as "object", properties: {} },
        handler: async () => "",
      }),
    ).toThrow(/inputSchema/i);
  });

  it("8. throws when handler is not a function", () => {
    expect(() =>
      defineTool({
        name: "no_handler",
        description: "no handler",
        inputSchema: { type: "object", properties: {} },
        handler: "not-a-function" as unknown as () => Promise<string>,
      }),
    ).toThrow(/handler/i);
  });

  it("9. trims whitespace from description", () => {
    const t = defineTool({
      name: "trim_test",
      description: "  trimmed  ",
      inputSchema: { type: "object", properties: {} },
      handler: async () => "",
    });
    expect(t.description).toBe("trimmed");
  });

  it("10. handler is the exact function passed in", () => {
    const handler = async (args: Record<string, unknown>) => String(args.x);
    const t = defineTool({
      name: "same_handler",
      description: "identity",
      inputSchema: { type: "object", properties: {} },
      handler,
    });
    expect(t.handler).toBe(handler);
  });

  it("11. accepts kebab-case names", () => {
    const t = defineTool({
      name: "my-tool-name",
      description: "kebab",
      inputSchema: { type: "object", properties: {} },
      handler: async () => "",
    });
    expect(t.name).toBe("my-tool-name");
  });

  it("12. inputSchema is stored verbatim", () => {
    const schema = {
      type: "object" as const,
      properties: { q: { type: "string" }, limit: { type: "number" } },
      required: ["q"],
    };
    const t = defineTool({
      name: "schema_test",
      description: "test",
      inputSchema: schema,
      handler: async () => "",
    });
    expect(t.inputSchema).toEqual(schema);
  });
});

// ─── defineSkill ──────────────────────────────────────────────────────────────

describe("defineSkill", () => {
  it("13. returns a normalised skill definition with _kind = 'skill'", () => {
    const s = defineSkill({
      name: "code_reviewer",
      description: "Reviews code",
      prompts: [{ id: "default", label: "Default", systemPrompt: "You are a code reviewer." }],
    });
    expect(s._kind).toBe("skill");
    expect(s.name).toBe("code_reviewer");
    expect(s.sdkVersion).toBe(SDK_VERSION);
  });

  it("14. default tools is empty array", () => {
    const s = defineSkill({
      name: "no_tools",
      description: "No tools",
      prompts: [{ id: "p1", label: "P1", systemPrompt: "Hi" }],
    });
    expect(s.tools).toEqual([]);
  });

  it("15. tools array is cloned, not mutated", () => {
    const tools = ["web_search"];
    const s = defineSkill({
      name: "has_tools",
      description: "Has tools",
      prompts: [{ id: "p1", label: "P1", systemPrompt: "Hi" }],
      tools,
    });
    tools.push("extra");
    expect(s.tools).toHaveLength(1);
  });

  it("16. defaults are preserved", () => {
    const s = defineSkill({
      name: "with_defaults",
      description: "With defaults",
      prompts: [{ id: "p1", label: "P1", systemPrompt: "Hi" }],
      defaults: { modelPreference: "claude-sonnet-4-6", temperature: 0.3 },
    });
    expect(s.defaults.modelPreference).toBe("claude-sonnet-4-6");
    expect(s.defaults.temperature).toBe(0.3);
  });

  it("17. tags default to empty array", () => {
    const s = defineSkill({
      name: "no_tags",
      description: "No tags",
      prompts: [{ id: "p1", label: "P1", systemPrompt: "Hi" }],
    });
    expect(s.tags).toEqual([]);
  });

  it("18. throws when prompts is empty array", () => {
    expect(() =>
      defineSkill({
        name: "no_prompts",
        description: "No prompts",
        prompts: [] as never,
      }),
    ).toThrow(/prompts/i);
  });

  it("19. throws on duplicate prompt ids", () => {
    expect(() =>
      defineSkill({
        name: "dup_prompts",
        description: "Dup prompts",
        prompts: [
          { id: "same", label: "A", systemPrompt: "..." },
          { id: "same", label: "B", systemPrompt: "..." },
        ],
      }),
    ).toThrow(/duplicate/i);
  });

  it("20. throws when a prompt is missing systemPrompt", () => {
    expect(() =>
      defineSkill({
        name: "bad_prompt",
        description: "Bad prompt",
        prompts: [{ id: "p1", label: "P1", systemPrompt: "" } as never],
      }),
    ).toThrow(/prompt/i);
  });

  it("21. multiple prompts are all preserved", () => {
    const s = defineSkill({
      name: "multi_prompt",
      description: "Multi prompts",
      prompts: [
        { id: "p1", label: "P1", systemPrompt: "First" },
        { id: "p2", label: "P2", systemPrompt: "Second" },
      ],
    });
    expect(s.prompts).toHaveLength(2);
  });
});

// ─── defineRole ───────────────────────────────────────────────────────────────

describe("defineRole", () => {
  it("22. returns a normalised role definition with _kind = 'role'", () => {
    const r = defineRole({
      name: "senior_reviewer",
      systemPrompt: "You are a senior reviewer.",
    });
    expect(r._kind).toBe("role");
    expect(r.name).toBe("senior_reviewer");
    expect(r.sdkVersion).toBe(SDK_VERSION);
  });

  it("23. allowedTools defaults to null when not specified", () => {
    const r = defineRole({
      name: "no_tools_role",
      systemPrompt: "You do things.",
    });
    expect(r.allowedTools).toBeNull();
  });

  it("24. allowedTools is cloned, not mutated", () => {
    const tools = ["code_search"];
    const r = defineRole({
      name: "tools_role",
      systemPrompt: "You review.",
      allowedTools: tools,
    });
    tools.push("extra");
    expect(r.allowedTools).toHaveLength(1);
  });

  it("25. model defaults to null when not specified", () => {
    const r = defineRole({
      name: "default_model",
      systemPrompt: "You do things.",
    });
    expect(r.model).toBeNull();
  });

  it("26. model is preserved when specified", () => {
    const r = defineRole({
      name: "specific_model",
      systemPrompt: "You do things.",
      model: "claude-opus-4",
    });
    expect(r.model).toBe("claude-opus-4");
  });

  it("27. throws on empty systemPrompt", () => {
    expect(() =>
      defineRole({
        name: "empty_prompt",
        systemPrompt: "   ",
      }),
    ).toThrow(/systemPrompt/i);
  });

  it("28. throws on invalid name (uppercase)", () => {
    expect(() =>
      defineRole({
        name: "Senior_Reviewer",
        systemPrompt: "You review.",
      }),
    ).toThrow(/invalid/i);
  });

  it("29. systemPrompt is trimmed", () => {
    const r = defineRole({
      name: "trim_role",
      systemPrompt: "  trimmed  ",
    });
    expect(r.systemPrompt).toBe("trimmed");
  });

  it("30. empty allowedTools array is stored as empty array (not null)", () => {
    const r = defineRole({
      name: "empty_tools",
      systemPrompt: "You do things.",
      allowedTools: [],
    });
    expect(r.allowedTools).toEqual([]);
    expect(r.allowedTools).not.toBeNull();
  });
});
