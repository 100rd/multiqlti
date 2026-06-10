/**
 * Unit tests for the orchestrator approval gate (T8/T10 contract level).
 *
 * Pins the human-gate invariant: planAndPause persists the plan and pauses at
 * `awaiting_plan_approval` WITHOUT running any step; execution only happens via
 * executeApprovedPlan. A run that is never approved never executes a step.
 *
 * Invoked by vitest unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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

function makeGateway() {
  const plan = JSON.stringify({
    steps: [{ type: "ground", query: "g" }, { type: "synthesize" }],
  });
  return {
    complete: vi.fn(async () => ({
      content: plan,
      tokensUsed: 5,
      modelSlug: "claude-opus",
      finishReason: "stop",
    })),
    resolveProvider: vi.fn(async () => "anthropic"),
  } as never;
}

function makeExecutors(onGround: () => void): StepExecutors {
  const noop = vi.fn(async () => ({ output: {}, tokensUsed: 0 }));
  return {
    research: noop,
    analyzeCode: noop,
    debate: noop,
    ground: vi.fn(async () => {
      onGround();
      return { output: {}, tokensUsed: 0 };
    }),
    synthesize: noop,
  } as unknown as StepExecutors;
}

describe("orchestrator approval gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("planAndPause persists the plan and pauses WITHOUT running any step", async () => {
    const storage = new MemStorage();
    await storage.createOrchestratorRun({ runId: "run-1", task: "t", status: "planning" });
    let ran = 0;
    const agent = new OrchestratorAgent({
      storage,
      wsManager,
      gateway: makeGateway(),
      stepExecutors: makeExecutors(() => {
        ran += 1;
      }),
      models: MODELS,
    });

    const result = await agent.planAndPause(
      "run-1",
      { task: "t" },
      caps(),
      new AbortController().signal,
    );

    expect(result.ok).toBe(true);
    const run = await storage.getOrchestratorRun("run-1");
    expect(run?.status).toBe("awaiting_plan_approval");
    const steps = await storage.getOrchestratorSteps("run-1");
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.status === "pending")).toBe(true);
    expect(ran).toBe(0); // NOTHING executed before approval
  });

  it("executeApprovedPlan runs the steps only after the gate", async () => {
    const storage = new MemStorage();
    await storage.createOrchestratorRun({ runId: "run-2", task: "t", status: "planning" });
    let ran = 0;
    const agent = new OrchestratorAgent({
      storage,
      wsManager,
      gateway: makeGateway(),
      stepExecutors: makeExecutors(() => {
        ran += 1;
      }),
      models: MODELS,
    });

    await agent.planAndPause("run-2", { task: "t" }, caps(), new AbortController().signal);
    expect(ran).toBe(0);

    const exec = await agent.executeApprovedPlan("run-2", caps(), new AbortController().signal);
    expect(exec.status).toBe("completed");
    expect(ran).toBe(1); // ground step ran after approval
  });
});
