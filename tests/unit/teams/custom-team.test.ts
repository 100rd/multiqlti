/**
 * Unit tests — CustomTeam and TeamRegistry fallback (Phase 5)
 */
import { describe, it, expect, vi } from "vitest";
import { CustomTeam } from "../../../server/teams/custom.js";
import { TeamRegistry } from "../../../server/teams/registry.js";
import type { StageContext, TeamConfig } from "../../../shared/types.js";

// ─── Minimal mock gateway ─────────────────────────────────────────────────────

const mockGateway = {
  complete: vi.fn().mockResolvedValue({ content: "mock output", tokensUsed: 10 }),
  stream: vi.fn(),
  getModel: vi.fn(),
  createLlmRequest: vi.fn(),
} as unknown as import("../../../server/gateway/index.js").Gateway;

const baseConfig: TeamConfig = {
  id: "custom_test",
  name: "Test Custom",
  description: "Test",
  defaultModelSlug: "mock",
  systemPromptTemplate: "Default template prompt.",
  inputSchema: {},
  outputSchema: {},
  tools: [],
  color: "violet",
  icon: "⚙️",
};

function makeContext(overrides?: Partial<StageContext>): StageContext {
  return {
    runId: "run-1",
    stageIndex: 0,
    modelSlug: "mock",
    previousOutputs: [],
    ...overrides,
  };
}

// ─── CustomTeam.buildPrompt ───────────────────────────────────────────────────

describe("CustomTeam.buildPrompt", () => {
  it("uses systemPromptOverride from stageConfig when provided", () => {
    const team = new CustomTeam(mockGateway, baseConfig);
    const ctx = makeContext({
      stageConfig: {
        teamId: "custom_test",
        modelSlug: "mock",
        enabled: true,
        systemPromptOverride: "Custom override prompt.",
      },
    });
    const messages = team.buildPrompt({ taskDescription: "Do something" }, ctx);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe("Custom override prompt.");
  });

  it("falls back to config.systemPromptTemplate when no override", () => {
    const team = new CustomTeam(mockGateway, baseConfig);
    const ctx = makeContext();
    const messages = team.buildPrompt({ taskDescription: "Do something" }, ctx);
    expect(messages[0].content).toBe("Default template prompt.");
  });

  it("falls back to hardcoded default when template is empty", () => {
    const team = new CustomTeam(mockGateway, { ...baseConfig, systemPromptTemplate: "" });
    const ctx = makeContext();
    const messages = team.buildPrompt({ taskDescription: "Do something" }, ctx);
    expect(messages[0].content).toContain("helpful AI assistant");
  });

  it("passes taskDescription as the user message", () => {
    const team = new CustomTeam(mockGateway, baseConfig);
    const ctx = makeContext();
    const messages = team.buildPrompt({ taskDescription: "Build a REST API" }, ctx);
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Build a REST API");
  });

  it("JSON-stringifies non-string input when taskDescription not present", () => {
    const team = new CustomTeam(mockGateway, baseConfig);
    const ctx = makeContext();
    const messages = team.buildPrompt({ someField: "value" }, ctx);
    expect(messages[1].content).toContain("someField");
  });
});

// ─── CustomTeam.parseOutput ───────────────────────────────────────────────────

describe("CustomTeam.parseOutput", () => {
  it("parses valid JSON string to object", () => {
    const team = new CustomTeam(mockGateway, baseConfig);
    const result = team.parseOutput('{"answer": "42"}');
    expect(result).toEqual({ answer: "42" });
  });

  it("wraps plain text in output key when JSON parse fails", () => {
    const team = new CustomTeam(mockGateway, baseConfig);
    const result = team.parseOutput("This is plain text.");
    expect(result).toEqual({ output: "This is plain text." });
  });
});

// ─── TeamRegistry fallback ────────────────────────────────────────────────────

describe("TeamRegistry — custom team fallback", () => {
  it("returns a built-in team for known IDs", () => {
    const registry = new TeamRegistry(mockGateway);
    const planningTeam = registry.getTeam("planning");
    expect(planningTeam).toBeDefined();
    expect(planningTeam.constructor.name).toBe("PlanningTeam");
  });

  it("returns a CustomTeam instance for unknown IDs", () => {
    const registry = new TeamRegistry(mockGateway);
    const customTeam = registry.getTeam("custom_my_stage_abc123");
    expect(customTeam).toBeDefined();
    expect(customTeam.constructor.name).toBe("CustomTeam");
  });

  it("returns a distinct CustomTeam instance for each unknown ID call", () => {
    const registry = new TeamRegistry(mockGateway);
    const t1 = registry.getTeam("custom_a");
    const t2 = registry.getTeam("custom_b");
    expect(t1).not.toBe(t2);
  });
});
