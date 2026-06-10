/**
 * Unit tests for DebateRunner (T4) — the thin wrapper that builds a
 * DebateStrategy (Opus proposer+judge, gemini-flash critic) and runs it via
 * StrategyExecutor, threading the run signal + per-Gemini-turn timeout + token
 * budget, persisting a scrubbed transcript, and degrading to Opus-only critic
 * on a Gemini timeout (Lead Q1).
 *
 * Deterministic: scripted gateway double (no CLI/network). Invoked by vitest
 * unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DebateRunner } from "../../../server/orchestrator/debate-runner.js";
import { TokenBudget, TokenCeilingError } from "../../../server/orchestrator/orchestrator-config.js";
import type { GatewayRequest, GatewayResponse } from "../../../shared/types.js";
import type { Gateway } from "../../../server/gateway/index.js";
import type { WsManager } from "../../../server/ws/manager.js";

const OPUS = "claude-opus";
const GEMINI = "gemini-flash";

/** A gateway double that maps modelSlug → scripted behavior per call. */
class ScriptedGateway {
  public calls: GatewayRequest[] = [];

  constructor(
    private readonly behavior: (req: GatewayRequest, n: number) => GatewayResponse | Promise<GatewayResponse>,
  ) {}

  async complete(request: GatewayRequest): Promise<GatewayResponse> {
    this.calls.push(request);
    return this.behavior(request, this.calls.length);
  }

  async resolveProvider(modelSlug: string): Promise<string> {
    return modelSlug === GEMINI ? "antigravity" : "anthropic";
  }
}

function makeGateway(
  behavior: (req: GatewayRequest, n: number) => GatewayResponse | Promise<GatewayResponse>,
): Gateway {
  return new ScriptedGateway(behavior) as unknown as Gateway;
}

const wsManagerStub = { broadcastToRun: vi.fn() } as unknown as WsManager;

function makeRunner(gateway: Gateway): DebateRunner {
  return new DebateRunner(gateway, wsManagerStub, {
    proposerModelSlug: OPUS,
    criticModelSlug: GEMINI,
    judgeModelSlug: OPUS,
  });
}

describe("DebateRunner — happy path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds a valid 2-round debate and returns transcript + verdict", async () => {
    const gateway = makeGateway(() => ({
      content: "a response",
      tokensUsed: 10,
      modelSlug: OPUS,
      finishReason: "stop",
    }));
    const runner = makeRunner(gateway);
    const budget = new TokenBudget(100_000);

    const result = await runner.run({
      runId: "run-1",
      stepId: "step-1",
      question: "Which framework?",
      rounds: 2,
      budget,
      geminiTurnTimeoutMs: 90_000,
    });

    expect(result.details.rounds.length).toBeGreaterThanOrEqual(2);
    expect(result.verdict).toBe("a response");
    expect(result.degraded).toBe(false);
    expect(budget.total).toBeGreaterThan(0);
  });

  it("clamps rounds to the maximum allowed by validateDebateStrategy", async () => {
    const gateway = makeGateway(() => ({
      content: "x",
      tokensUsed: 1,
      modelSlug: OPUS,
      finishReason: "stop",
    }));
    const runner = makeRunner(gateway);
    const result = await runner.run({
      runId: "run-1",
      stepId: "step-1",
      question: "q",
      rounds: 99,
      budget: new TokenBudget(100_000),
      geminiTurnTimeoutMs: 90_000,
    });
    const maxRound = Math.max(...result.details.rounds.map((r) => r.round));
    expect(maxRound).toBeLessThanOrEqual(5);
  });
});

describe("DebateRunner — C2 token ceiling (per call)", () => {
  it("throws TokenCeilingError when the budget is exhausted before a turn", async () => {
    const gateway = makeGateway(() => ({
      content: "x",
      tokensUsed: 10_000,
      modelSlug: OPUS,
      finishReason: "stop",
    }));
    const runner = makeRunner(gateway);
    const budget = new TokenBudget(5_000);
    await expect(
      runner.run({
        runId: "run-1",
        stepId: "step-1",
        question: "q",
        rounds: 3,
        budget,
        geminiTurnTimeoutMs: 90_000,
      }),
    ).rejects.toBeInstanceOf(TokenCeilingError);
  });
});

describe("DebateRunner — Gemini timeout degrade to Opus-only (Q1)", () => {
  it("retries once then degrades the critic turn to Opus, never silently", async () => {
    let geminiCalls = 0;
    const gateway = makeGateway((req) => {
      if (req.modelSlug === GEMINI) {
        geminiCalls += 1;
        return Promise.reject(new Error("Antigravity CLI request timed out"));
      }
      return Promise.resolve({
        content: "opus says",
        tokensUsed: 5,
        modelSlug: OPUS,
        finishReason: "stop",
      });
    });
    const runner = makeRunner(gateway);
    const result = await runner.run({
      runId: "run-1",
      stepId: "step-1",
      question: "q",
      rounds: 1,
      budget: new TokenBudget(100_000),
      geminiTurnTimeoutMs: 90_000,
    });

    expect(geminiCalls).toBe(2); // 1 try + 1 retry, then degrade
    expect(result.degraded).toBe(true);
    const criticTurns = result.details.rounds.filter((r) => r.role === "critic");
    expect(criticTurns.length).toBeGreaterThanOrEqual(1);
  });
});
