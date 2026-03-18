/**
 * Unit tests for Splitter — parallel task splitting logic.
 *
 * All LLM calls are mocked via a fake Gateway to avoid real API calls.
 */
import { describe, it, expect, vi } from "vitest";
import { Splitter } from "../../../server/pipeline/splitter.js";
import type { ParallelConfig, SplitPlan } from "../../../shared/types.js";
import type { Gateway } from "../../../server/gateway/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGateway(responseContent: string): Gateway {
  return {
    complete: vi.fn().mockResolvedValue({
      content: responseContent,
      tokensUsed: 10,
      modelSlug: "mock",
      finishReason: "stop",
    }),
    stream: vi.fn(),
    completeWithTools: vi.fn(),
  } as unknown as Gateway;
}

function makeConfig(overrides: Partial<ParallelConfig> = {}): ParallelConfig {
  return {
    enabled: true,
    mode: "auto",
    maxAgents: 3,
    mergeStrategy: "auto",
    ...overrides,
  };
}

const LONG_INPUT = "a".repeat(500);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Splitter", () => {
  describe("disabled config", () => {
    it("returns shouldSplit: false when enabled is false", async () => {
      const gateway = makeGateway("{}");
      const splitter = new Splitter(gateway, makeConfig({ enabled: false }));

      const plan = await splitter.split(LONG_INPUT, "planning");

      expect(plan.shouldSplit).toBe(false);
      expect(plan.subtasks).toHaveLength(0);
      expect(plan.reason).toBe("parallel execution disabled");
      expect(gateway.complete).not.toHaveBeenCalled();
    });
  });

  describe("short input guard", () => {
    it("returns shouldSplit: false for inputs shorter than 200 chars", async () => {
      const gateway = makeGateway("{}");
      const splitter = new Splitter(gateway, makeConfig());
      const shortInput = "Short task description.";

      const plan = await splitter.split(shortInput, "planning");

      expect(plan.shouldSplit).toBe(false);
      expect(plan.reason).toContain("short");
      expect(gateway.complete).not.toHaveBeenCalled();
    });

    it("calls the LLM for inputs >= 200 chars", async () => {
      const responseJson = JSON.stringify({
        shouldSplit: false,
        reason: "single task",
        subtasks: [],
      });
      const gateway = makeGateway(responseJson);
      const splitter = new Splitter(gateway, makeConfig());

      await splitter.split(LONG_INPUT, "planning");

      expect(gateway.complete).toHaveBeenCalledOnce();
    });
  });

  describe("LLM returns shouldSplit: true", () => {
    it("returns split plan with subtasks from LLM response", async () => {
      const llmResponse: SplitPlan = {
        shouldSplit: true,
        reason: "natural boundaries found",
        subtasks: [
          { id: "subtask-1", title: "Auth module", description: "Implement auth", context: [], estimatedComplexity: "medium" },
          { id: "subtask-2", title: "CRUD ops", description: "Implement CRUD", context: [], estimatedComplexity: "low" },
        ],
      };
      const gateway = makeGateway(JSON.stringify(llmResponse));
      const splitter = new Splitter(gateway, makeConfig({ maxAgents: 5 }));

      const plan = await splitter.split(LONG_INPUT, "development");

      expect(plan.shouldSplit).toBe(true);
      expect(plan.subtasks).toHaveLength(2);
      expect(plan.subtasks[0].id).toBe("subtask-1");
    });

    it("includes teamId in the splitter system prompt", async () => {
      const llmResponse: SplitPlan = { shouldSplit: false, reason: "no split", subtasks: [] };
      const gateway = makeGateway(JSON.stringify(llmResponse));
      const splitter = new Splitter(gateway, makeConfig());

      await splitter.split(LONG_INPUT, "testing");

      const callArgs = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMessage = callArgs.messages.find((m: { role: string }) => m.role === "system");
      expect(systemMessage.content).toContain("testing");
    });
  });

  describe("maxAgents cap", () => {
    it("caps subtasks to maxAgents when LLM returns more", async () => {
      const subtasks = Array.from({ length: 6 }, (_, i) => ({
        id: `subtask-${i + 1}`,
        title: `Task ${i + 1}`,
        description: `Description ${i + 1}`,
        context: [],
        estimatedComplexity: "low" as const,
      }));
      const llmResponse: SplitPlan = { shouldSplit: true, reason: "many tasks", subtasks };
      const gateway = makeGateway(JSON.stringify(llmResponse));
      const splitter = new Splitter(gateway, makeConfig({ maxAgents: 3 }));

      const plan = await splitter.split(LONG_INPUT, "development");

      expect(plan.subtasks).toHaveLength(3);
    });

    it("does not cap when subtasks count <= maxAgents", async () => {
      const subtasks = Array.from({ length: 2 }, (_, i) => ({
        id: `subtask-${i + 1}`,
        title: `Task ${i + 1}`,
        description: `Description ${i + 1}`,
        context: [],
        estimatedComplexity: "low" as const,
      }));
      const llmResponse: SplitPlan = { shouldSplit: true, reason: "2 tasks", subtasks };
      const gateway = makeGateway(JSON.stringify(llmResponse));
      const splitter = new Splitter(gateway, makeConfig({ maxAgents: 3 }));

      const plan = await splitter.split(LONG_INPUT, "testing");

      expect(plan.subtasks).toHaveLength(2);
    });
  });

  describe("malformed LLM response handling", () => {
    it("returns shouldSplit: false on non-JSON response", async () => {
      const gateway = makeGateway("This is not valid JSON at all!!!");
      const splitter = new Splitter(gateway, makeConfig());

      const plan = await splitter.split(LONG_INPUT, "planning");

      expect(plan.shouldSplit).toBe(false);
      expect(plan.subtasks).toHaveLength(0);
      expect(plan.reason).toBeTruthy();
    });

    it("returns shouldSplit: false on JSON missing required fields", async () => {
      const gateway = makeGateway('{"unexpected": "format"}');
      const splitter = new Splitter(gateway, makeConfig());

      const plan = await splitter.split(LONG_INPUT, "planning");

      expect(plan.shouldSplit).toBe(false);
    });

    it("filters out invalid subtasks but keeps valid ones", async () => {
      const mixedResponse = JSON.stringify({
        shouldSplit: true,
        reason: "has some valid",
        subtasks: [
          { id: "subtask-1", title: "Valid", description: "ok", context: [], estimatedComplexity: "low" },
          { notValid: true },  // missing required fields
          null,
          42,
        ],
      });
      const gateway = makeGateway(mixedResponse);
      const splitter = new Splitter(gateway, makeConfig({ maxAgents: 10 }));

      const plan = await splitter.split(LONG_INPUT, "planning");

      expect(plan.shouldSplit).toBe(true);
      expect(plan.subtasks).toHaveLength(1);
      expect(plan.subtasks[0].id).toBe("subtask-1");
    });
  });
});

// ─── Phase 6.12 additions ─────────────────────────────────────────────────────

describe("Phase 6.12 — dynamic sharding + cost routing", () => {
  describe("preCheck", () => {
    it("returns sharding metadata without calling the LLM", () => {
      const gateway = makeGateway("{}");
      const splitter = new Splitter(gateway, makeConfig({ maxAgents: 5, shardTargetSize: 100 }));

      const check = splitter.preCheck(LONG_INPUT, "claude-sonnet-4-6");

      expect(check.shardCount).toBeGreaterThanOrEqual(1);
      expect(check.shardCount).toBeLessThanOrEqual(5);
      expect(check.shardingMode).toBe("equal");
      expect(check.cheapModelSlug).toBe("claude-haiku-4-5");
      expect(gateway.complete).not.toHaveBeenCalled();
    });

    it("respects custom shardingStrategy in config", () => {
      const gateway = makeGateway("{}");
      const splitter = new Splitter(gateway, makeConfig({ shardingStrategy: "natural" }));
      const check = splitter.preCheck(LONG_INPUT, "mock");
      expect(check.shardingMode).toBe("natural");
    });
  });

  describe("cost blocking", () => {
    it("blocks split and does not call LLM when cost exceeds blockUsd", async () => {
      const gateway = makeGateway("{}");
      const splitter = new Splitter(
        gateway,
        makeConfig({
          maxAgents: 5,
          costThreshold: { blockUsd: 0.000001 }, // absurdly small threshold
        }),
      );

      const plan = await splitter.split(LONG_INPUT, "development", "claude-sonnet-4-6");

      expect(plan.shouldSplit).toBe(false);
      expect(plan.reason).toContain("blocked");
      expect(plan.preCheck?.costAction).toBe("block");
      expect(gateway.complete).not.toHaveBeenCalled();
    });

    it("proceeds (and calls LLM) when cost is below blockUsd", async () => {
      const llmResponse = JSON.stringify({ shouldSplit: false, reason: "single task", subtasks: [] });
      const gateway = makeGateway(llmResponse);
      const splitter = new Splitter(
        gateway,
        makeConfig({
          costThreshold: { blockUsd: 1000 }, // generous threshold
        }),
      );

      await splitter.split(LONG_INPUT, "development", "claude-sonnet-4-6");

      expect(gateway.complete).toHaveBeenCalledOnce();
    });

    it("attaches preCheck to result even for allowed splits", async () => {
      const llmResponse = JSON.stringify({ shouldSplit: false, reason: "ok", subtasks: [] });
      const gateway = makeGateway(llmResponse);
      const splitter = new Splitter(gateway, makeConfig());

      const plan = await splitter.split(LONG_INPUT, "planning", "mock");

      expect(plan.preCheck).toBeDefined();
      expect(plan.preCheck?.shardCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("sharding hint in system prompt", () => {
    it("includes sharding mode hint in the LLM system prompt", async () => {
      const llmResponse = JSON.stringify({ shouldSplit: false, reason: "ok", subtasks: [] });
      const gateway = makeGateway(llmResponse);
      const splitter = new Splitter(
        gateway,
        makeConfig({ shardingStrategy: "weighted", maxAgents: 4 }),
      );

      await splitter.split(LONG_INPUT, "development");

      const callArgs = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMsg = callArgs.messages.find((m: { role: string }) => m.role === "system");
      expect(systemMsg.content).toContain("weight by estimated effort");
    });
  });
});
