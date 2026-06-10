/**
 * Unit tests for OrchestratorAgent error/edge branches (coverage + safety).
 *
 * Covers: plan-turn returns invalid JSON → run failed, no steps persisted;
 * plan-turn aborted → run cancelled (no partial); reject unknown step type via
 * plan validation. Complements bounds.test.ts.
 *
 * Invoked by vitest unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect, vi } from "vitest";
import { MemStorage } from "../../../server/storage.js";
import { OrchestratorAgent } from "../../../server/orchestrator/orchestrator-agent.js";
import type {
  StepExecutors,
  OrchestratorModels,
} from "../../../server/orchestrator/orchestrator-agent.js";
import type { OrchestratorCaps } from "../../../server/orchestrator/orchestrator-config.js";

const MODELS: OrchestratorModels = {
  planModelSlug: "claude-opus",
  synthesizeModelSlug: "claude-opus",
  proposerModelSlug: "claude-opus",
  criticModelSlug: "gemini-flash",
  judgeModelSlug: "claude-opus",
};

function caps(): OrchestratorCaps {
  return {
    maxSteps: 8,
    maxDebateRounds: 3,
    maxResearchSources: 12,
    maxResearchConcurrency: 4,
    maxResearchSourceBytes: 262_144,
    maxResearchTotalBytes: 1_048_576,
    maxTotalTokens: 400_000,
    overallTimeoutMs: 1_800_000,
    stepOutputMaxBytes: 100_000,
    geminiTurnTimeoutMs: 90_000,
  };
}

const wsManager = { broadcastToRun: vi.fn() } as never;
const noopExecutors = {
  research: vi.fn(),
  analyzeCode: vi.fn(),
  debate: vi.fn(),
  ground: vi.fn(),
  synthesize: vi.fn(),
} as unknown as StepExecutors;

function gatewayReturning(content: string) {
  return {
    complete: vi.fn(async () => ({
      content,
      tokensUsed: 1,
      modelSlug: "claude-opus",
      finishReason: "stop",
    })),
    resolveProvider: vi.fn(async () => "anthropic"),
  } as never;
}

function gatewayThrowing(err: Error) {
  return {
    complete: vi.fn(async () => {
      throw err;
    }),
    resolveProvider: vi.fn(async () => "anthropic"),
  } as never;
}

describe("OrchestratorAgent — plan-turn errors", () => {
  it("fails cleanly on invalid plan JSON and persists no steps", async () => {
    const storage = new MemStorage();
    await storage.createOrchestratorRun({ runId: "e1", task: "t", status: "planning" });
    const agent = new OrchestratorAgent({
      storage,
      wsManager,
      gateway: gatewayReturning("{not json"),
      stepExecutors: noopExecutors,
      models: MODELS,
    });

    const result = await agent.planAndPause(
      "e1",
      { task: "t" },
      caps(),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    const run = await storage.getOrchestratorRun("e1");
    expect(run?.status).toBe("failed");
    expect(await storage.getOrchestratorSteps("e1")).toHaveLength(0);
  });

  it("rejects an unknown step type at plan validation", async () => {
    const storage = new MemStorage();
    await storage.createOrchestratorRun({ runId: "e2", task: "t", status: "planning" });
    const agent = new OrchestratorAgent({
      storage,
      wsManager,
      gateway: gatewayReturning(JSON.stringify({ steps: [{ type: "exfiltrate" }] })),
      stepExecutors: noopExecutors,
      models: MODELS,
    });

    const result = await agent.planAndPause(
      "e2",
      { task: "t", needs: "x", workspaceId: "ws-1" },
      caps(),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
  });

  it("maps a plan-turn abort to cancelled (no partial)", async () => {
    const storage = new MemStorage();
    await storage.createOrchestratorRun({ runId: "e3", task: "t", status: "planning" });
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const agent = new OrchestratorAgent({
      storage,
      wsManager,
      gateway: gatewayThrowing(abortErr),
      stepExecutors: noopExecutors,
      models: MODELS,
    });

    const result = await agent.planAndPause(
      "e3",
      { task: "t" },
      caps(),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    const run = await storage.getOrchestratorRun("e3");
    expect(run?.status).toBe("cancelled");
    expect(run?.output).toBeFalsy();
  });
});
