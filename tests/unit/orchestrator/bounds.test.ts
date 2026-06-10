/**
 * bounds.test.ts — THE HARD SAFETY GATE for the debate-research orchestrator.
 *
 * Every cost/runaway bound is exercised deterministically (fake timers + mock
 * providers + mock step executors; NO real CLI/network/DB):
 *   - maxSteps        — a plan longer than the cap is rejected at plan-validation.
 *   - token ceiling   — checked BEFORE each step; terminates with `token_ceiling`,
 *                       partial output NOT promoted.
 *   - overall-timeout — wall-clock cap terminates the loop.
 *   - abort           — signal → status `cancelled`, never `failed`, no partial.
 *   - step byte cap   — persisted step output truncated to stepOutputMaxBytes.
 *
 * Invoked by vitest unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemStorage } from "../../../server/storage.js";
import { OrchestratorAgent } from "../../../server/orchestrator/orchestrator-agent.js";
import type { OrchestratorCaps } from "../../../server/orchestrator/orchestrator-config.js";
import type { StepExecutors } from "../../../server/orchestrator/orchestrator-agent.js";

const MODELS = {
  planModelSlug: "claude-opus",
  synthesizeModelSlug: "claude-opus",
  proposerModelSlug: "claude-opus",
  criticModelSlug: "gemini-flash",
  judgeModelSlug: "claude-opus",
};

function caps(overrides: Partial<OrchestratorCaps> = {}): OrchestratorCaps {
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
    ...overrides,
  };
}

const wsManager = { broadcastToRun: vi.fn() } as never;

/** Gateway double: plan turn returns a scripted plan JSON; synth returns text. */
function makeGateway(planJson: string, tokensPerCall = 10) {
  return {
    complete: vi.fn(async (req: { messages: Array<{ content: string }> }) => {
      const isPlan = req.messages.some((m) =>
        /produce.*plan|ordered plan|decompose/i.test(m.content),
      );
      return {
        content: isPlan ? planJson : "final synthesis",
        tokensUsed: tokensPerCall,
        modelSlug: "claude-opus",
        finishReason: "stop",
      };
    }),
    resolveProvider: vi.fn(async () => "anthropic"),
  } as never;
}

/** Step executors that record calls and return a small fixed output. */
function makeStepExecutors(): StepExecutors & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    research: vi.fn(async () => {
      calls.push("research");
      return { output: { findings: [] }, tokensUsed: 5 };
    }),
    analyzeCode: vi.fn(async () => {
      calls.push("analyze-code");
      return { output: { hits: [] }, tokensUsed: 5 };
    }),
    debate: vi.fn(async () => {
      calls.push("debate");
      return { output: { verdict: "x" }, tokensUsed: 5 };
    }),
    ground: vi.fn(async () => {
      calls.push("ground");
      return { output: { grounded: false }, tokensUsed: 0 };
    }),
    synthesize: vi.fn(async () => {
      calls.push("synthesize");
      return { output: { recommendation: "x" }, tokensUsed: 5 };
    }),
  } as StepExecutors & { calls: string[] };
}

function planWith(steps: Array<Record<string, unknown>>): string {
  return JSON.stringify({ steps });
}

async function seedRun(storage: MemStorage, runId: string) {
  await storage.createOrchestratorRun({ runId, task: "t", status: "planning" });
}

function makeAgent(storage: MemStorage, gateway: never, executors: StepExecutors) {
  return new OrchestratorAgent({
    storage,
    wsManager,
    gateway,
    stepExecutors: executors,
    models: MODELS,
  });
}

describe("OrchestratorAgent bounds — maxSteps", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a plan longer than maxSteps at plan-validation (extra steps never run)", async () => {
    const storage = new MemStorage();
    await seedRun(storage, "run-1");
    const steps = Array.from({ length: 6 }, () => ({ type: "ground", query: "g" }));
    const gateway = makeGateway(planWith(steps));
    const executors = makeStepExecutors();
    const agent = makeAgent(storage, gateway, executors);

    const planResult = await agent.planAndPause(
      "run-1",
      { task: "t" },
      caps({ maxSteps: 3 }),
      new AbortController().signal,
    );
    expect(planResult.ok).toBe(false);
    expect(executors.calls).toHaveLength(0);
  });

  it("runs exactly the planned steps when within maxSteps", async () => {
    const storage = new MemStorage();
    await seedRun(storage, "run-2");
    const steps = [{ type: "ground", query: "g" }, { type: "synthesize" }];
    const gateway = makeGateway(planWith(steps));
    const executors = makeStepExecutors();
    const agent = makeAgent(storage, gateway, executors);

    await agent.planAndPause("run-2", { task: "t" }, caps(), new AbortController().signal);
    const result = await agent.executeApprovedPlan("run-2", caps(), new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(executors.calls).toContain("ground");
  });
});

describe("OrchestratorAgent bounds — token ceiling (C2, before each step)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("terminates with token_ceiling and does NOT promote partial output", async () => {
    const storage = new MemStorage();
    await seedRun(storage, "run-3");
    const steps = [
      { type: "ground", query: "g" },
      { type: "ground", query: "g2" },
      { type: "synthesize" },
    ];
    const gateway = makeGateway(planWith(steps), 100);
    const executors = makeStepExecutors();
    const agent = makeAgent(storage, gateway, executors);

    await agent.planAndPause(
      "run-3",
      { task: "t" },
      caps({ maxTotalTokens: 50 }),
      new AbortController().signal,
    );
    const result = await agent.executeApprovedPlan(
      "run-3",
      caps({ maxTotalTokens: 50 }),
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("token_ceiling");
    const run = await storage.getOrchestratorRun("run-3");
    expect(run?.output).toBeFalsy();
  });
});

describe("OrchestratorAgent bounds — overall timeout (wall-clock)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("terminates the loop when overallTimeoutMs is exceeded", async () => {
    const storage = new MemStorage();
    await seedRun(storage, "run-4");
    const steps = Array.from({ length: 5 }, () => ({ type: "ground", query: "g" }));
    const gateway = makeGateway(planWith(steps), 1);
    const executors = makeStepExecutors();
    let stepNo = 0;
    (executors.ground as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      stepNo += 1;
      vi.advanceTimersByTime(20_000);
      return { output: { grounded: false }, tokensUsed: 0 };
    });
    const agent = makeAgent(storage, gateway, executors);

    await agent.planAndPause(
      "run-4",
      { task: "t" },
      caps({ overallTimeoutMs: 10_000 }),
      new AbortController().signal,
    );
    const result = await agent.executeApprovedPlan(
      "run-4",
      caps({ overallTimeoutMs: 10_000 }),
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("overall_timeout");
    expect(stepNo).toBeLessThan(5);
  });
});

describe("OrchestratorAgent bounds — abort → cancelled (no partial)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps an aborted run to status cancelled, never failed, no partial output", async () => {
    const storage = new MemStorage();
    await seedRun(storage, "run-5");
    const steps = [
      { type: "ground", query: "g" },
      { type: "ground", query: "g2" },
      { type: "synthesize" },
    ];
    const gateway = makeGateway(planWith(steps), 1);
    const controller = new AbortController();
    const executors = makeStepExecutors();
    (executors.ground as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      controller.abort();
      return { output: { grounded: false }, tokensUsed: 0 };
    });
    const agent = makeAgent(storage, gateway, executors);

    await agent.planAndPause("run-5", { task: "t" }, caps(), controller.signal);
    const result = await agent.executeApprovedPlan("run-5", caps(), controller.signal);

    expect(result.status).toBe("cancelled");
    const run = await storage.getOrchestratorRun("run-5");
    expect(run?.status).toBe("cancelled");
    expect(run?.output).toBeFalsy();
  });
});

describe("OrchestratorAgent bounds — step output byte cap (storage DoS)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("truncates persisted step output to stepOutputMaxBytes", async () => {
    const storage = new MemStorage();
    await seedRun(storage, "run-6");
    const steps = [{ type: "ground", query: "g" }, { type: "synthesize" }];
    const gateway = makeGateway(planWith(steps), 1);
    const executors = makeStepExecutors();
    (executors.ground as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      output: { blob: "x".repeat(500_000) },
      tokensUsed: 0,
    }));
    const agent = makeAgent(storage, gateway, executors);

    await agent.planAndPause(
      "run-6",
      { task: "t" },
      caps({ stepOutputMaxBytes: 4096 }),
      new AbortController().signal,
    );
    await agent.executeApprovedPlan(
      "run-6",
      caps({ stepOutputMaxBytes: 4096 }),
      new AbortController().signal,
    );

    const persisted = await storage.getOrchestratorSteps("run-6");
    const groundStep = persisted.find((s) => s.type === "ground");
    const serialized = JSON.stringify(groundStep?.output ?? {});
    expect(serialized.length).toBeLessThanOrEqual(4096 + 256);
  });
});
