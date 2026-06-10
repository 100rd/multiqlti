/**
 * Unit tests for DebateRunner — the orchestrator-boundary wrapper over the
 * UNCHANGED StrategyExecutor.executeDebate. Covers, deterministically (scripted
 * gateway doubles / scripted streaming providers + fake timers; NO CLI/network):
 *
 *   - happy path + round clamp;
 *   - C2 token ceiling (per call), incl. mid-debate halt under STREAMING;
 *   - Q1 Gemini timeout → retry → degrade-to-Opus (blocking AND streaming);
 *   - L-1 a genuine NON-timeout error (e.g. [budget-exceeded], auth) is NOT
 *     classified degradable; L-2 an aborted turn is never retried/degraded;
 *   - CORE fake-timer regression: a streamed turn emitting deltas PAST 90_000ms
 *     virtual time COMPLETES (idle timer resets per delta) — no 90s wall-clock;
 *   - novelty dry-streak early-exit at K=1 / K=2; a new argument resets the streak;
 *   - hard-cap absolute backstop when every round is "new" (bounded ≤ maxRounds);
 *   - abort → no partial; mid-stream error distinct from a timeout;
 *   - transcript hygiene: NO <<<NOVELTY>>> marker in persisted rounds or WS payloads.
 *
 * Invoked by vitest unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DebateRunner } from "../../../server/orchestrator/debate-runner.js";
import { TokenBudget, TokenCeilingError } from "../../../server/orchestrator/orchestrator-config.js";
import { NOVELTY_SENTINEL } from "../../../server/orchestrator/novelty-marker.js";
import { buildTestGateway, TEST_MODEL_SLUG } from "../helpers/streaming-test-utils.js";
import type {
  GatewayRequest,
  GatewayResponse,
  ILLMProvider,
  ILLMProviderOptions,
  ProviderMessage,
} from "../../../shared/types.js";
import type { Gateway } from "../../../server/gateway/index.js";
import type { WsManager } from "../../../server/ws/manager.js";

const OPUS = "claude-opus";
const GEMINI = "gemini-flash";
const JUDGE_MARKER = "You are the judge.";

/** Append a terminal novelty marker to a turn body. */
function withMarker(body: string, newArgument: boolean): string {
  return `${body}\n${NOVELTY_SENTINEL}{"newArgument": ${newArgument}}`;
}

/** A gateway double that maps a request → scripted behavior per call. */
class ScriptedGateway {
  public calls: GatewayRequest[] = [];

  constructor(
    private readonly behavior: (
      req: GatewayRequest,
      n: number,
    ) => GatewayResponse | Promise<GatewayResponse>,
  ) {}

  async complete(request: GatewayRequest): Promise<GatewayResponse> {
    this.calls.push(request);
    return this.behavior(request, this.calls.length);
  }

  // Streaming path mirrors complete() for the doubles that opt into streaming.
  async completeStreaming(request: GatewayRequest): Promise<GatewayResponse> {
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

const STREAM_CFG = {
  enabled: true,
  idleTimeoutMs: 60_000,
  overallTimeoutMs: 600_000,
  maxOutputBytes: 8_388_608,
};

function isJudge(req: GatewayRequest): boolean {
  const last = [...req.messages].reverse().find((m) => m.role === "user");
  return !!last && last.content.includes(JUDGE_MARKER);
}

// ── Happy path + clamp ──────────────────────────────────────────────────────

describe("DebateRunner — happy path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs a 2-round debate (blocking) and returns transcript + verdict", async () => {
    const gateway = makeGateway((req) =>
      isJudge(req)
        ? { content: "verdict", tokensUsed: 10, modelSlug: OPUS, finishReason: "stop" }
        : {
            content: withMarker("a response", true),
            tokensUsed: 10,
            modelSlug: OPUS,
            finishReason: "stop",
          },
    );
    const runner = makeRunner(gateway);
    const budget = new TokenBudget(100_000);

    const result = await runner.run({
      runId: "run-1",
      stepId: "step-1",
      question: "Which framework?",
      rounds: 2,
      budget,
      geminiTurnTimeoutMs: 90_000,
      noveltyPatience: 1,
    });

    expect(result.details.rounds.length).toBeGreaterThanOrEqual(2);
    expect(result.verdict).toBe("verdict");
    expect(result.degraded).toBe(false);
    expect(budget.total).toBeGreaterThan(0);
  });

  it("clamps rounds to the maximum allowed (5) and never exceeds it", async () => {
    const gateway = makeGateway((req) =>
      isJudge(req)
        ? { content: "verdict", tokensUsed: 1, modelSlug: OPUS, finishReason: "stop" }
        : { content: withMarker("x", true), tokensUsed: 1, modelSlug: OPUS, finishReason: "stop" },
    );
    const runner = makeRunner(gateway);
    const result = await runner.run({
      runId: "run-1",
      stepId: "step-1",
      question: "q",
      rounds: 99,
      budget: new TokenBudget(100_000),
      geminiTurnTimeoutMs: 90_000,
      noveltyPatience: 5, // never trigger novelty early-exit → run to cap
    });
    expect(result.roundsRun).toBeLessThanOrEqual(5);
    const maxRound = Math.max(...result.details.rounds.map((r) => r.round));
    expect(maxRound).toBeLessThanOrEqual(5);
  });
});

// ── C2 token ceiling ────────────────────────────────────────────────────────

describe("DebateRunner — C2 token ceiling (per call)", () => {
  it("throws TokenCeilingError when the budget is exhausted before a turn", async () => {
    const gateway = makeGateway((req) =>
      isJudge(req)
        ? { content: "v", tokensUsed: 10_000, modelSlug: OPUS, finishReason: "stop" }
        : {
            content: withMarker("x", true),
            tokensUsed: 10_000,
            modelSlug: OPUS,
            finishReason: "stop",
          },
    );
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
        noveltyPatience: 5,
      }),
    ).rejects.toBeInstanceOf(TokenCeilingError);
  });

  it("C2 halts a STREAMING debate mid-flight once the ceiling is reached", async () => {
    const gateway = makeGateway((req) =>
      isJudge(req)
        ? { content: "v", tokensUsed: 3_000, modelSlug: OPUS, finishReason: "stop" }
        : {
            content: withMarker("x", true),
            tokensUsed: 3_000,
            modelSlug: OPUS,
            finishReason: "stop",
          },
    );
    const runner = makeRunner(gateway);
    const budget = new TokenBudget(5_000);
    await expect(
      runner.run({
        runId: "run-1",
        stepId: "step-1",
        question: "q",
        rounds: 4,
        budget,
        geminiTurnTimeoutMs: 90_000,
        noveltyPatience: 5,
        streamingDebate: STREAM_CFG,
      }),
    ).rejects.toBeInstanceOf(TokenCeilingError);
  });
});

// ── Q1 Gemini degrade ───────────────────────────────────────────────────────

describe("DebateRunner — Gemini timeout degrade to Opus (Q1)", () => {
  it("retries once then degrades the critic turn to Opus, never silently (blocking)", async () => {
    let geminiCalls = 0;
    const gateway = makeGateway((req) => {
      if (isJudge(req)) {
        return { content: "verdict", tokensUsed: 5, modelSlug: OPUS, finishReason: "stop" };
      }
      if (req.modelSlug === GEMINI) {
        geminiCalls += 1;
        return Promise.reject(new Error("Antigravity CLI request timed out"));
      }
      return Promise.resolve({
        content: withMarker("opus says", true),
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
      noveltyPatience: 5,
    });

    expect(geminiCalls).toBe(2); // 1 try + 1 retry, then degrade
    expect(result.degraded).toBe(true);
    const criticTurns = result.details.rounds.filter((r) => r.role === "critic");
    expect(criticTurns.length).toBeGreaterThanOrEqual(1);
  });

  it("degrades under STREAMING when the Gemini turn idle-times-out twice", async () => {
    let geminiCalls = 0;
    const gateway = makeGateway((req) => {
      if (isJudge(req)) {
        return { content: "verdict", tokensUsed: 5, modelSlug: OPUS, finishReason: "stop" };
      }
      if (req.modelSlug === GEMINI) {
        geminiCalls += 1;
        return Promise.reject(new Error("stream idle timeout after 60000ms"));
      }
      return Promise.resolve({
        content: withMarker("opus content", true),
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
      noveltyPatience: 5,
      streamingDebate: STREAM_CFG,
    });
    expect(geminiCalls).toBe(2);
    expect(result.degraded).toBe(true);
  });

  it("L-1: a genuine non-timeout error ([budget-exceeded]) is NOT degradable — it propagates", async () => {
    const gateway = makeGateway((req) => {
      if (req.modelSlug === GEMINI) {
        return Promise.reject(new Error("[budget-exceeded] daily cost cap reached"));
      }
      return Promise.resolve({
        content: withMarker("opus", true),
        tokensUsed: 1,
        modelSlug: OPUS,
        finishReason: "stop",
      });
    });
    const runner = makeRunner(gateway);
    await expect(
      runner.run({
        runId: "run-1",
        stepId: "step-1",
        question: "q",
        rounds: 1,
        budget: new TokenBudget(100_000),
        geminiTurnTimeoutMs: 90_000,
        noveltyPatience: 5,
      }),
    ).rejects.toThrow(/budget-exceeded/);
  });

  it("L-1: an auth error is NOT degradable — it propagates", async () => {
    const gateway = makeGateway((req) => {
      if (req.modelSlug === GEMINI) {
        return Promise.reject(new Error("401 Unauthorized: invalid credentials"));
      }
      return Promise.resolve({
        content: withMarker("opus", true),
        tokensUsed: 1,
        modelSlug: OPUS,
        finishReason: "stop",
      });
    });
    const runner = makeRunner(gateway);
    await expect(
      runner.run({
        runId: "run-1",
        stepId: "step-1",
        question: "q",
        rounds: 1,
        budget: new TokenBudget(100_000),
        geminiTurnTimeoutMs: 90_000,
        noveltyPatience: 5,
      }),
    ).rejects.toThrow(/Unauthorized/);
  });

  it("L-2: an aborted Gemini turn is re-thrown, never retried/degraded", async () => {
    const controller = new AbortController();
    let geminiCalls = 0;
    const gateway = makeGateway((req) => {
      if (req.modelSlug === GEMINI) {
        geminiCalls += 1;
        controller.abort();
        return Promise.reject(new Error("CLI request aborted"));
      }
      return Promise.resolve({
        content: withMarker("opus", true),
        tokensUsed: 1,
        modelSlug: OPUS,
        finishReason: "stop",
      });
    });
    const runner = makeRunner(gateway);
    await expect(
      runner.run({
        runId: "run-1",
        stepId: "step-1",
        question: "q",
        rounds: 1,
        budget: new TokenBudget(100_000),
        geminiTurnTimeoutMs: 90_000,
        noveltyPatience: 5,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
    expect(geminiCalls).toBe(1); // aborted → no retry
  });
});

// ── CORE fake-timer streaming regression ────────────────────────────────────

/**
 * A streaming provider that emits a growing assistant text every chunkDelayMs of
 * (fake) time, ending with a terminal novelty marker. The idle timer in the real
 * Gateway never fires because deltas arrive inside every idle window — so a turn
 * spanning far more than 90_000ms of virtual time COMPLETES.
 */
class TimedNoveltyStreamProvider implements ILLMProvider {
  constructor(
    private readonly chunkDelayMs: number,
    private readonly chunks: number,
    private readonly newArgument: boolean,
  ) {}

  async complete(): Promise<{ content: string; tokensUsed: number; finishReason: "stop" }> {
    return { content: withMarker("done", this.newArgument), tokensUsed: 5, finishReason: "stop" };
  }

  async *stream(
    _modelId: string,
    _messages: ProviderMessage[],
    _options?: ILLMProviderOptions,
  ): AsyncGenerator<string> {
    for (let i = 1; i <= this.chunks; i++) {
      await new Promise((r) => setTimeout(r, this.chunkDelayMs));
      yield `tok${i} `;
    }
    // Terminal marker line (its own delta).
    yield `\n${NOVELTY_SENTINEL}{"newArgument": ${this.newArgument}}`;
  }
}

describe("DebateRunner — CORE fake-timer streaming regression (>90s turn completes)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a streamed turn emitting deltas past 90_000ms virtual time COMPLETES (no wall-clock kill)", async () => {
    // 50s between deltas (< 60s idle window) for ~600s total — far beyond the old 90s cap.
    const provider = new TimedNoveltyStreamProvider(50_000, 12, true);
    const gateway = buildTestGateway(provider);
    const runner = new DebateRunner(gateway, wsManagerStub, {
      proposerModelSlug: TEST_MODEL_SLUG,
      criticModelSlug: "no-gemini", // not the critic slug → no Q1 path, both stream
      judgeModelSlug: TEST_MODEL_SLUG,
    });

    let settled = false;
    const runPromise = runner
      .run({
        runId: "run-1",
        stepId: "step-1",
        question: "long reasoning",
        rounds: 1,
        budget: new TokenBudget(1_000_000),
        geminiTurnTimeoutMs: 90_000,
        noveltyPatience: 1,
        streamingDebate: STREAM_CFG,
      })
      .finally(() => {
        settled = true;
      });

    // Drive virtual time in steps until the run settles. Three streamed turns
    // (proposer + critic + final judge) each emit 12 deltas at 50s spacing; each
    // delta arrives inside the 60s idle window, so no timeout fires across the
    // ~1950s of virtual time the whole debate spans (far beyond the old 90s cap).
    for (let i = 0; i < 200 && !settled; i++) {
      await vi.advanceTimersByTimeAsync(50_000);
    }
    const result = await runPromise;

    expect(result.roundsRun).toBe(1);
    expect(result.details.rounds.length).toBeGreaterThanOrEqual(2);
    // The assembled content is present and the marker was stripped (C-1).
    const proposer = result.details.rounds.find((r) => r.role === "proposer");
    expect(proposer?.content).toContain("tok1");
    expect(proposer?.content).not.toContain(NOVELTY_SENTINEL);
  });
});

// ── Novelty dry-streak termination ──────────────────────────────────────────

/**
 * A blocking scripted gateway whose participant turns carry a per-round novelty
 * decision driven by a script keyed on round index (1-based). The judge turn is
 * short-circuited by the runner; we only script participant content.
 */
function noveltyGateway(roundDecisions: boolean[]) {
  let participantTurn = 0;
  const gateway = makeGateway((req) => {
    if (isJudge(req)) {
      return { content: "final verdict", tokensUsed: 1, modelSlug: OPUS, finishReason: "stop" };
    }
    // Two participants per round; map the turn index to a round (0-based).
    const round = Math.floor(participantTurn / 2);
    participantTurn += 1;
    const newArg = roundDecisions[Math.min(round, roundDecisions.length - 1)];
    return {
      content: withMarker(`round-${round + 1} turn`, newArg),
      tokensUsed: 1,
      modelSlug: OPUS,
      finishReason: "stop",
    };
  });
  return gateway;
}

describe("DebateRunner — novelty dry-streak early termination", () => {
  beforeEach(() => vi.clearAllMocks());

  it("K=1: stops after the FIRST dry round (all participants newArgument:false)", async () => {
    const gateway = noveltyGateway([false, false, false, false, false]);
    const runner = makeRunner(gateway);
    const result = await runner.run({
      runId: "run-1",
      stepId: "step-1",
      question: "q",
      rounds: 5,
      budget: new TokenBudget(1_000_000),
      geminiTurnTimeoutMs: 90_000,
      noveltyPatience: 1,
    });
    expect(result.roundsRun).toBe(1);
    // Exactly one judge call (the final one).
    const judgeCalls = (gateway as unknown as ScriptedGateway).calls.filter(isJudge);
    expect(judgeCalls).toHaveLength(1);
  });

  it("K=2: requires TWO consecutive dry rounds; a 'true' in between resets the streak", async () => {
    // round1 dry, round2 NEW (resets), round3 dry, round4 dry → stop after round4.
    const gateway = noveltyGateway([false, true, false, false, false]);
    const runner = makeRunner(gateway);
    const result = await runner.run({
      runId: "run-1",
      stepId: "step-1",
      question: "q",
      rounds: 5,
      budget: new TokenBudget(1_000_000),
      geminiTurnTimeoutMs: 90_000,
      noveltyPatience: 2,
    });
    expect(result.roundsRun).toBe(4);
  });

  it("hard-cap backstop: when EVERY round is 'new', runs exactly maxRounds (≤5) then stops", async () => {
    const gateway = noveltyGateway([true, true, true, true, true]);
    const runner = makeRunner(gateway);
    const result = await runner.run({
      runId: "run-1",
      stepId: "step-1",
      question: "q",
      rounds: 5,
      budget: new TokenBudget(1_000_000),
      geminiTurnTimeoutMs: 90_000,
      noveltyPatience: 1,
    });
    expect(result.roundsRun).toBe(5);
    const judgeCalls = (gateway as unknown as ScriptedGateway).calls.filter(isJudge);
    expect(judgeCalls).toHaveLength(1);
  });

  it("a fail-open (no marker) round is treated as 'new argument' → does NOT stop early", async () => {
    let participantTurn = 0;
    const gateway = makeGateway((req) => {
      if (isJudge(req)) {
        return { content: "verdict", tokensUsed: 1, modelSlug: OPUS, finishReason: "stop" };
      }
      const round = Math.floor(participantTurn / 2);
      participantTurn += 1;
      // No marker at all on round 1 (fail-open = continue); dry from round 2 on.
      const content = round === 0 ? "round-1 no marker" : withMarker("round dry", false);
      return { content, tokensUsed: 1, modelSlug: OPUS, finishReason: "stop" };
    });
    const runner = makeRunner(gateway);
    const result = await runner.run({
      runId: "run-1",
      stepId: "step-1",
      question: "q",
      rounds: 5,
      budget: new TokenBudget(1_000_000),
      geminiTurnTimeoutMs: 90_000,
      noveltyPatience: 1,
    });
    // round1 fail-open (not dry) → round2 dry → stop after round2.
    expect(result.roundsRun).toBe(2);
  });
});

// ── Transcript hygiene (C-1) ────────────────────────────────────────────────

describe("DebateRunner — transcript hygiene (C-1)", () => {
  it("strips the <<<NOVELTY>>> marker from persisted rounds AND WS payloads", async () => {
    const broadcast = vi.fn();
    const ws = { broadcastToRun: broadcast } as unknown as WsManager;
    const gateway = makeGateway((req) =>
      isJudge(req)
        ? { content: "verdict", tokensUsed: 1, modelSlug: OPUS, finishReason: "stop" }
        : {
            content: withMarker("genuine reasoning", false),
            tokensUsed: 1,
            modelSlug: OPUS,
            finishReason: "stop",
          },
    );
    const runner = new DebateRunner(gateway, ws, {
      proposerModelSlug: OPUS,
      criticModelSlug: GEMINI,
      judgeModelSlug: OPUS,
    });

    const result = await runner.run({
      runId: "run-1",
      stepId: "step-1",
      question: "q",
      rounds: 1,
      budget: new TokenBudget(1_000_000),
      geminiTurnTimeoutMs: 90_000,
      noveltyPatience: 1,
    });

    // Persisted rounds carry NO marker.
    expect(JSON.stringify(result.details.rounds)).not.toContain(NOVELTY_SENTINEL);
    expect(result.details.rounds[0].content).toContain("genuine reasoning");

    // Every WS round broadcast carries NO marker (the executor broadcast the
    // already-stripped content the decorator returned).
    for (const call of broadcast.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(NOVELTY_SENTINEL);
    }
  });
});

// ── Abort + mid-stream error ────────────────────────────────────────────────

describe("DebateRunner — abort + mid-stream error", () => {
  it("an aborted Opus turn propagates and produces no partial result", async () => {
    const controller = new AbortController();
    const gateway = makeGateway(() => {
      controller.abort();
      return Promise.reject(new Error("CLI request aborted"));
    });
    const runner = makeRunner(gateway);
    await expect(
      runner.run({
        runId: "run-1",
        stepId: "step-1",
        question: "q",
        rounds: 2,
        budget: new TokenBudget(100_000),
        geminiTurnTimeoutMs: 90_000,
        noveltyPatience: 1,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });

  it("a mid-stream (non-timeout) error on an Opus turn propagates (not degraded)", async () => {
    const gateway = makeGateway((req) => {
      if (req.modelSlug === OPUS && !isJudge(req)) {
        return Promise.reject(new Error("mid-stream boom"));
      }
      return Promise.resolve({ content: "x", tokensUsed: 1, modelSlug: OPUS, finishReason: "stop" });
    });
    const runner = makeRunner(gateway);
    await expect(
      runner.run({
        runId: "run-1",
        stepId: "step-1",
        question: "q",
        rounds: 1,
        budget: new TokenBudget(100_000),
        geminiTurnTimeoutMs: 90_000,
        noveltyPatience: 1,
      }),
    ).rejects.toThrow(/boom/);
  });
});
