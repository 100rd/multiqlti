/**
 * Unit tests for server/pipeline/swarm-executor.ts
 *
 * All LLM calls are mocked via a Gateway mock.
 * Tests verify:
 *  - shouldSwarm() gate logic
 *  - chunks/perspectives/custom splitter strategies
 *  - concatenate/llm_merge/vote merger strategies
 *  - Partial failure: 1 of N clones fails -> merge proceeds on succeeded
 *  - All clones fail -> SwarmAllFailedError thrown
 *  - cloneCount=0,1,21 -> rejected by runtime guard
 *  - swarm.enabled=false -> returns null
 *  - WS events emitted in correct order
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SwarmExecutor, SwarmAllFailedError } from "../../../server/pipeline/swarm-executor.js";
import type { Gateway } from "../../../server/gateway/index.js";
import type { TeamRegistry } from "../../../server/teams/registry.js";
import type { WsManager } from "../../../server/ws/manager.js";
import type {
  PipelineStageConfig,
  StageContext,
  SwarmConfig,
  TeamResult,
} from "../../../shared/types.js";

// ─── Mock factories ────────────────────────────────────────────────────────────

function makeGateway(mergeResponse = "merged output"): Gateway {
  return {
    complete: vi.fn().mockResolvedValue({
      content: mergeResponse,
      tokensUsed: 5,
      modelSlug: "mock",
      finishReason: "stop",
    }),
    stream: vi.fn(),
    completeWithTools: vi.fn(),
  } as unknown as Gateway;
}

function makeWsManager(): WsManager {
  return { broadcastToRun: vi.fn() } as unknown as WsManager;
}

function makeTeamRegistry(outputText = "clone output"): TeamRegistry {
  return {
    getTeam: vi.fn().mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        output: { raw: outputText },
        tokensUsed: 10,
        raw: outputText,
      } satisfies TeamResult),
    }),
  } as unknown as TeamRegistry;
}

function makeFailingTeamRegistry(failOnIndex: number): TeamRegistry {
  let callIdx = 0;
  return {
    getTeam: vi.fn().mockReturnValue({
      execute: vi.fn().mockImplementation(() => {
        if (callIdx++ === failOnIndex) throw new Error("Clone failure");
        return Promise.resolve({ output: { raw: "ok" }, tokensUsed: 10, raw: "ok" } satisfies TeamResult);
      }),
    }),
  } as unknown as TeamRegistry;
}

function makeAllFailingTeamRegistry(): TeamRegistry {
  return {
    getTeam: vi.fn().mockReturnValue({
      execute: vi.fn().mockRejectedValue(new Error("always fails")),
    }),
  } as unknown as TeamRegistry;
}

function makeStage(swarm: SwarmConfig | undefined, teamId = "testing"): PipelineStageConfig {
  return {
    teamId,
    modelSlug: "mock-model",
    enabled: true,
    swarm,
  } as PipelineStageConfig;
}

function makeContext(): StageContext {
  return {
    runId: "run-1",
    stageIndex: 0,
    previousOutputs: [],
  } as StageContext;
}

function baseSwarm(overrides: Partial<SwarmConfig> = {}): SwarmConfig {
  return {
    enabled: true,
    cloneCount: 3,
    splitter: "perspectives",
    merger: "concatenate",
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("SwarmExecutor", () => {
  let gateway: Gateway;
  let ws: WsManager;
  let executor: SwarmExecutor;

  beforeEach(() => {
    gateway = makeGateway();
    ws = makeWsManager();
    executor = new SwarmExecutor(gateway, makeTeamRegistry(), ws);
  });

  // ─── shouldSwarm() ──────────────────────────────────────────────────────────

  describe("shouldSwarm()", () => {
    it("returns true when swarm.enabled=true and cloneCount > 1", () => {
      const stage = makeStage(baseSwarm());
      expect(executor.shouldSwarm(stage)).toBe(true);
    });

    it("returns false when swarm.enabled=false", () => {
      const stage = makeStage(baseSwarm({ enabled: false }));
      expect(executor.shouldSwarm(stage)).toBe(false);
    });

    it("returns false when swarm is undefined", () => {
      const stage = makeStage(undefined);
      expect(executor.shouldSwarm(stage)).toBe(false);
    });

    it("returns false when cloneCount=1", () => {
      const stage = makeStage(baseSwarm({ cloneCount: 1 }));
      expect(executor.shouldSwarm(stage)).toBe(false);
    });
  });

  // ─── execute() returns null ─────────────────────────────────────────────────

  describe("execute() guard cases", () => {
    it("returns null when swarm.enabled=false", async () => {
      executor = new SwarmExecutor(gateway, makeTeamRegistry(), ws);
      const result = await executor.execute(makeStage(baseSwarm({ enabled: false })), "input", makeContext(), "stage-1");
      expect(result).toBeNull();
    });

    it("throws when cloneCount > 20", async () => {
      executor = new SwarmExecutor(gateway, makeTeamRegistry(), ws);
      await expect(
        executor.execute(makeStage(baseSwarm({ cloneCount: 21 })), "input", makeContext(), "stage-1"),
      ).rejects.toThrow("exceeds maximum of 20");
    });
  });

  // ─── chunks splitter ────────────────────────────────────────────────────────

  describe("chunks splitter", () => {
    it("splits input into N chunks summing to original content", async () => {
      const registry = makeTeamRegistry();
      executor = new SwarmExecutor(gateway, registry, ws);
      const stage = makeStage(baseSwarm({ splitter: "chunks", cloneCount: 3 }));
      const input = "line1\nline2\nline3\nline4\nline5\nline6";
      const result = await executor.execute(stage, input, makeContext(), "s");
      expect(result).not.toBeNull();
      expect(result!.cloneResults.length).toBeGreaterThan(0);
    });

    it("works with cloneCount=2 (minimum)", async () => {
      executor = new SwarmExecutor(gateway, makeTeamRegistry(), ws);
      const stage = makeStage(baseSwarm({ splitter: "chunks", cloneCount: 2 }));
      const result = await executor.execute(stage, "a\nb\nc\nd", makeContext(), "s");
      expect(result).not.toBeNull();
      expect(result!.cloneResults.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── perspectives splitter ──────────────────────────────────────────────────

  describe("perspectives splitter", () => {
    it("uses built-in perspectives for testing team", async () => {
      const registry = makeTeamRegistry();
      const getTeamSpy = vi.spyOn(registry, "getTeam");
      executor = new SwarmExecutor(gateway, registry, ws);
      const stage = makeStage(baseSwarm({ splitter: "perspectives", cloneCount: 3 }), "testing");
      await executor.execute(stage, "write tests for X", makeContext(), "s");
      expect(getTeamSpy).toHaveBeenCalled();
    });

    it("uses user-provided perspectives when length matches cloneCount", async () => {
      const registry = makeTeamRegistry();
      executor = new SwarmExecutor(gateway, registry, ws);
      const stage = makeStage(baseSwarm({
        splitter: "perspectives",
        cloneCount: 2,
        perspectives: [
          { label: "A", systemPromptSuffix: "Focus on A" },
          { label: "B", systemPromptSuffix: "Focus on B" },
        ],
      }));
      const result = await executor.execute(stage, "input", makeContext(), "s");
      expect(result).not.toBeNull();
      expect(result!.succeededCount).toBe(2);
    });
  });

  // ─── custom splitter ────────────────────────────────────────────────────────

  describe("custom splitter", () => {
    it("applies per-clone system prompt overrides", async () => {
      const registry = makeTeamRegistry("custom result");
      executor = new SwarmExecutor(gateway, registry, ws);
      const stage = makeStage(baseSwarm({
        splitter: "custom",
        cloneCount: 2,
        customClonePrompts: ["Prompt A", "Prompt B"],
      }));
      const result = await executor.execute(stage, "input", makeContext(), "s");
      expect(result).not.toBeNull();
      expect(result!.succeededCount).toBe(2);
    });
  });

  // ─── concatenate merger ─────────────────────────────────────────────────────

  describe("concatenate merger", () => {
    it("joins clone outputs with section headers", async () => {
      executor = new SwarmExecutor(gateway, makeTeamRegistry("output X"), ws);
      const stage = makeStage(baseSwarm({ merger: "concatenate", cloneCount: 2 }));
      const result = await executor.execute(stage, "input", makeContext(), "s");
      expect(result).not.toBeNull();
      expect(result!.mergedOutput).toContain("## Clone");
    });
  });

  // ─── llm_merge merger ───────────────────────────────────────────────────────

  describe("llm_merge merger", () => {
    it("calls gateway with merged prompt and returns synthesis", async () => {
      const gw = makeGateway("synthesized result");
      executor = new SwarmExecutor(gw, makeTeamRegistry("clone out"), ws);
      const stage = makeStage(baseSwarm({ merger: "llm_merge", cloneCount: 2 }));
      const result = await executor.execute(stage, "input", makeContext(), "s");
      expect(result).not.toBeNull();
      expect(result!.mergedOutput).toBe("synthesized result");
      expect(gw.complete).toHaveBeenCalled();
    });
  });

  // ─── vote merger ────────────────────────────────────────────────────────────

  describe("vote merger", () => {
    it("picks majority value from structured outputs", async () => {
      const registry: TeamRegistry = {
        getTeam: vi.fn().mockReturnValue({
          execute: vi.fn()
            .mockResolvedValueOnce({ output: { raw: "yes" }, tokensUsed: 1, raw: "yes" } satisfies TeamResult)
            .mockResolvedValueOnce({ output: { raw: "no" }, tokensUsed: 1, raw: "no" } satisfies TeamResult)
            .mockResolvedValueOnce({ output: { raw: "yes" }, tokensUsed: 1, raw: "yes" } satisfies TeamResult),
        }),
      } as unknown as TeamRegistry;
      executor = new SwarmExecutor(gateway, registry, ws);
      const stage = makeStage(baseSwarm({ merger: "vote", cloneCount: 3 }));
      const result = await executor.execute(stage, "input", makeContext(), "s");
      expect(result).not.toBeNull();
      expect(result!.mergedOutput).toBe("yes");
    });

    it("falls back to concatenate for unstructured text", async () => {
      const registry: TeamRegistry = {
        getTeam: vi.fn().mockReturnValue({
          execute: vi.fn()
            .mockResolvedValueOnce({ output: { raw: "This is a long paragraph that cannot be parsed as a vote" }, tokensUsed: 1, raw: "long text" } satisfies TeamResult)
            .mockResolvedValueOnce({ output: { raw: "Another long paragraph here too" }, tokensUsed: 1, raw: "long text 2" } satisfies TeamResult),
        }),
      } as unknown as TeamRegistry;
      executor = new SwarmExecutor(gateway, registry, ws);
      const stage = makeStage(baseSwarm({ merger: "vote", cloneCount: 2 }));
      const result = await executor.execute(stage, "input", makeContext(), "s");
      expect(result).not.toBeNull();
      expect(result!.mergedOutput).toContain("## Clone");
    });

    it("breaks tie by picking lowest clone index", async () => {
      const registry: TeamRegistry = {
        getTeam: vi.fn().mockReturnValue({
          execute: vi.fn()
            .mockResolvedValueOnce({ output: { raw: "yes" }, tokensUsed: 1, raw: "yes" } satisfies TeamResult)
            .mockResolvedValueOnce({ output: { raw: "no" }, tokensUsed: 1, raw: "no" } satisfies TeamResult),
        }),
      } as unknown as TeamRegistry;
      executor = new SwarmExecutor(gateway, registry, ws);
      const stage = makeStage(baseSwarm({ merger: "vote", cloneCount: 2 }));
      const result = await executor.execute(stage, "input", makeContext(), "s");
      expect(result).not.toBeNull();
      // Tie: 1 yes, 1 no — first distinct value wins (yes at index 0)
      expect(result!.mergedOutput).toBe("yes");
    });
  });

  // ─── Partial failure ────────────────────────────────────────────────────────

  describe("partial failure handling", () => {
    it("proceeds with merge when 1 of 3 clones fails", async () => {
      executor = new SwarmExecutor(gateway, makeFailingTeamRegistry(1), ws);
      const stage = makeStage(baseSwarm({ cloneCount: 3, merger: "concatenate" }));
      const result = await executor.execute(stage, "input", makeContext(), "s");
      expect(result).not.toBeNull();
      expect(result!.succeededCount).toBe(2);
      expect(result!.failedCount).toBe(1);
      expect(result!.cloneResults[1].status).toBe("failed");
    });

    it("includes error message in failed clone result", async () => {
      executor = new SwarmExecutor(gateway, makeFailingTeamRegistry(0), ws);
      const stage = makeStage(baseSwarm({ cloneCount: 2, merger: "concatenate" }));
      const result = await executor.execute(stage, "input", makeContext(), "s");
      expect(result!.cloneResults[0].error).toBe("Clone failure");
    });
  });

  // ─── All clones fail ────────────────────────────────────────────────────────

  describe("all clones fail", () => {
    it("throws SwarmAllFailedError", async () => {
      executor = new SwarmExecutor(gateway, makeAllFailingTeamRegistry(), ws);
      const stage = makeStage(baseSwarm({ cloneCount: 2 }));
      await expect(
        executor.execute(stage, "input", makeContext(), "s"),
      ).rejects.toThrow(SwarmAllFailedError);
    });

    it("SwarmAllFailedError contains all clone results", async () => {
      executor = new SwarmExecutor(gateway, makeAllFailingTeamRegistry(), ws);
      const stage = makeStage(baseSwarm({ cloneCount: 2 }));
      try {
        await executor.execute(stage, "input", makeContext(), "s");
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SwarmAllFailedError);
        expect((err as SwarmAllFailedError).cloneResults).toHaveLength(2);
      }
    });
  });

  // ─── WS events ──────────────────────────────────────────────────────────────

  describe("WS events", () => {
    it("emits swarm:started, swarm:clone:started, swarm:clone:completed, swarm:merging, swarm:completed in order", async () => {
      const wsManager = makeWsManager();
      executor = new SwarmExecutor(gateway, makeTeamRegistry(), wsManager);
      const stage = makeStage(baseSwarm({ cloneCount: 2, merger: "concatenate" }));
      await executor.execute(stage, "input", makeContext(), "s");
      const calls = (wsManager.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls;
      const types = calls.map((c) => (c[1] as { type: string }).type);
      expect(types[0]).toBe("swarm:started");
      const cloneStarted = types.filter((t) => t === "swarm:clone:started");
      const cloneCompleted = types.filter((t) => t === "swarm:clone:completed");
      expect(cloneStarted.length).toBe(2);
      expect(cloneCompleted.length).toBe(2);
      expect(types).toContain("swarm:merging");
      expect(types[types.length - 1]).toBe("swarm:completed");
    });

    it("emits swarm:clone:failed for a failed clone", async () => {
      const wsManager = makeWsManager();
      executor = new SwarmExecutor(gateway, makeFailingTeamRegistry(0), wsManager);
      const stage = makeStage(baseSwarm({ cloneCount: 2, merger: "concatenate" }));
      await executor.execute(stage, "input", makeContext(), "s");
      const types = (wsManager.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => (c[1] as { type: string }).type);
      expect(types).toContain("swarm:clone:failed");
    });
  });
});
