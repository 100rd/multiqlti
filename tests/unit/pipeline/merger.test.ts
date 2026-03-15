/**
 * Unit tests for Merger — parallel result merging logic.
 *
 * All LLM calls are mocked to avoid real API calls.
 */
import { describe, it, expect, vi } from "vitest";
import { Merger, STAGE_MERGE_DEFAULTS } from "../../../server/pipeline/merger.js";
import type { SubTaskResult, MergeStrategy } from "../../../shared/types.js";
import type { Gateway } from "../../../server/gateway/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGateway(responseContent: string): Gateway {
  return {
    complete: vi.fn().mockResolvedValue({
      content: responseContent,
      tokensUsed: 20,
      modelSlug: "mock",
      finishReason: "stop",
    }),
    stream: vi.fn(),
    completeWithTools: vi.fn(),
  } as unknown as Gateway;
}

function makeSubtaskResult(id: string, title: string, output: string): SubTaskResult {
  return {
    subtask: {
      id,
      title,
      description: `Description for ${title}`,
      context: [],
      estimatedComplexity: "medium",
    },
    output,
    tokensUsed: 50,
    modelSlug: "mock",
    durationMs: 100,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Merger", () => {
  const merger = new Merger();

  describe("empty results", () => {
    it("returns empty string when no results provided", async () => {
      const gateway = makeGateway("anything");
      const result = await merger.merge([], "concatenate", "testing", "mock", gateway);
      expect(result).toBe("");
    });
  });

  describe("concatenate strategy", () => {
    it("joins results with headers and separator", async () => {
      const gateway = makeGateway("merged");
      const results = [
        makeSubtaskResult("1", "Auth module", "Auth output"),
        makeSubtaskResult("2", "CRUD ops", "CRUD output"),
      ];

      const merged = await merger.merge(results, "concatenate", "testing", "mock", gateway);

      expect(merged).toContain("### Auth module");
      expect(merged).toContain("Auth output");
      expect(merged).toContain("### CRUD ops");
      expect(merged).toContain("CRUD output");
      expect(merged).toContain("---");
      expect(gateway.complete).not.toHaveBeenCalled();
    });

    it("single result: no separator, just header and content", async () => {
      const gateway = makeGateway("merged");
      const results = [makeSubtaskResult("1", "Only task", "Only output")];

      const merged = await merger.merge(results, "concatenate", "testing", "mock", gateway);

      expect(merged).toContain("### Only task");
      expect(merged).toContain("Only output");
    });
  });

  describe("review strategy", () => {
    it("calls model and returns its response", async () => {
      const gateway = makeGateway("Unified output from review");
      const results = [
        makeSubtaskResult("1", "Part A", "Output A"),
        makeSubtaskResult("2", "Part B", "Output B"),
      ];

      const merged = await merger.merge(results, "review", "development", "mock", gateway);

      expect(merged).toBe("Unified output from review");
      expect(gateway.complete).toHaveBeenCalledOnce();
    });

    it("passes all subtask outputs to the merger model", async () => {
      const gateway = makeGateway("unified");
      const results = [
        makeSubtaskResult("1", "Part A", "Content from Part A"),
        makeSubtaskResult("2", "Part B", "Content from Part B"),
      ];

      await merger.merge(results, "review", "development", "mock", gateway);

      const callArgs = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const userMessage = callArgs.messages.find((m: { role: string }) => m.role === "user");
      expect(userMessage.content).toContain("Content from Part A");
      expect(userMessage.content).toContain("Content from Part B");
    });

    it("uses the provided mergerModelSlug for the LLM call", async () => {
      const gateway = makeGateway("result");
      const results = [makeSubtaskResult("1", "Task", "output")];

      await merger.merge(results, "review", "development", "my-model-slug", gateway);

      const callArgs = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.modelSlug).toBe("my-model-slug");
    });
  });

  describe("auto strategy resolution", () => {
    it("resolves 'auto' to 'review' for planning team", async () => {
      const gateway = makeGateway("reviewed output");
      const results = [makeSubtaskResult("1", "Plan part", "content")];

      await merger.merge(results, "auto", "planning", "mock", gateway);

      expect(gateway.complete).toHaveBeenCalledOnce();
    });

    it("resolves 'auto' to 'concatenate' for testing team", async () => {
      const gateway = makeGateway("would be merged");
      const results = [
        makeSubtaskResult("1", "Test A", "output A"),
        makeSubtaskResult("2", "Test B", "output B"),
      ];

      const merged = await merger.merge(results, "auto", "testing", "mock", gateway);

      expect(gateway.complete).not.toHaveBeenCalled();
      expect(merged).toContain("### Test A");
    });

    it("resolves 'auto' to 'concatenate' for code_review team", async () => {
      const gateway = makeGateway("would be merged");
      const results = [makeSubtaskResult("1", "Review", "findings")];

      await merger.merge(results, "auto", "code_review", "mock", gateway);

      expect(gateway.complete).not.toHaveBeenCalled();
    });

    it("STAGE_MERGE_DEFAULTS covers all TeamId values", () => {
      const teamIds = [
        "planning", "architecture", "development", "testing",
        "code_review", "deployment", "monitoring", "fact_check",
      ];

      for (const teamId of teamIds) {
        expect(STAGE_MERGE_DEFAULTS[teamId as keyof typeof STAGE_MERGE_DEFAULTS]).toBeDefined();
        const strategy = STAGE_MERGE_DEFAULTS[teamId as keyof typeof STAGE_MERGE_DEFAULTS];
        expect(["concatenate", "review"]).toContain(strategy);
      }
    });
  });

  describe("explicit strategy overrides auto", () => {
    it("uses concatenate even when team default is review", async () => {
      const gateway = makeGateway("would be reviewed");
      const results = [
        makeSubtaskResult("1", "A", "out A"),
        makeSubtaskResult("2", "B", "out B"),
      ];

      const strategy: MergeStrategy = "concatenate";
      const merged = await merger.merge(results, strategy, "planning", "mock", gateway);

      expect(gateway.complete).not.toHaveBeenCalled();
      expect(merged).toContain("### A");
    });
  });
});
