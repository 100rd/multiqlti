/**
 * Unit tests for DebateRunner — the orchestrator-boundary wrapper over the
 * UNCHANGED StrategyExecutor.executeDebate, now MIGRATED onto the shared
 * adaptive-stability deliberation engine (stop-policy + stability-judge).
 * Deterministic (scripted gateway doubles / scripted streaming providers + fake
 * timers; NO CLI/network):
 *
 *   - happy path + round clamp;
 *   - C2 token ceiling (per call), incl. mid-debate halt under STREAMING;
 *   - Q1 Gemini timeout → retry → degrade-to-Opus (blocking AND streaming);
 *   - L-1 a genuine NON-timeout error ([budget-exceeded], auth) is NOT degradable;
 *     L-2 an aborted turn is never retried/degraded;
 *   - CORE fake-timer regression (#366 carried): a streamed turn emitting deltas
 *     PAST 90_000ms virtual time COMPLETES (idle timer resets per delta);
 *   - ANTI-PREMATURE (T-DEB-1): an immediate stable signal at round 1 CANNOT
 *     stop the debate — the min-rounds floor (>=2) blocks it;
 *   - stable at round 2 → stop with high confidence; hard-cap backstop;
 *   - abort/budget backstops; transcript hygiene (C-1: no <<<STABILITY>>> marker
 *     in persisted rounds or WS payloads).
 *
 * Invoked by vitest unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DebateRunner } from "../../../server/orchestrator/debate-runner.js";
import { TokenBudget, TokenCeilingError } from "../../../server/orchestrator/orchestrator-config.js";
import { STABILITY_SENTINEL } from "../../../server/orchestrator/deliberation/stability-judge.js";
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

/** Append a terminal stability marker to a turn body. */
function withMarker(body: string, explored: boolean, stabilized: boolean): string {
  return `${body}\n${STABILITY_SENTINEL}{"explored": ${explored}, "stabilized": ${stabilized}}`;
}

/** A stable terminal marker (explored && stabilized) — a candidate stop signal. */
function stable(body: string): string {
  return withMarker(body, true, true);
}
/** A still-diverging terminal marker. */
function diverging(body: string): string {
  return withMarker(body, true, false);
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

/** Default never-trip overall timeout for non-timeout tests. */
const OVERALL = 1_800_000;

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
        : { content: diverging("a response"), tokensUsed: 10, modelSlug: OPUS, finishReason: "stop" },
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
      minRounds: 2,
      overallTimeoutMs: OVERALL,
    });

    expect(result.details.rounds.length).toBeGreaterThanOrEqual(2);
    expect(result.verdict).toBe("verdict");
    expect(result.degraded).toBe(false);
    expect(budget.total).toBeGreaterThan(0);
    expect(result.stopReason).toBe("hard-cap");
  });

  it("clamps rounds to the maximum allowed (5) and never exceeds it", async () => {
    const gateway = makeGateway((req) =>
      isJudge(req)
        ? { content: "verdict", tokensUsed: 1, modelSlug: OPUS, finishReason: "stop" }
        : { content: diverging("x"), tokensUsed: 1, modelSlug: OPUS, finishReason: "stop" },
    );
    const runner = makeRunner(gateway);
    const result = await runner.run({
      runId: "run-1",
      stepId: "step-1",
      question: "q",
      rounds: 99,
      budget: new TokenBudget(100_000),
      geminiTurnTimeoutMs: 90_000,
      minRounds: 2,
      overallTimeoutMs: OVERALL,
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
        : { content: diverging("x"), tokensUsed: 10_000, modelSlug: OPUS, finishReason: "stop" },
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
        minRounds: 2,
        overallTimeoutMs: OVERALL,
      }),
    ).rejects.toBeInstanceOf(TokenCeilingError);
  });

  it("C2 halts a STREAMING debate mid-flight once the ceiling is reached", async () => {
    const gateway = makeGateway((req) =>
      isJudge(req)
        ? { content: "v", tokensUsed: 3_000, modelSlug: OPUS, finishReason: "stop" }
        : { content: diverging("x"), tokensUsed: 3_000, modelSlug: OPUS, finishReason: "stop" },
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
        minRounds: 2,
        overallTimeoutMs: OVERALL,
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
        content: diverging("opus says"),
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
      minRounds: 1,
      overallTimeoutMs: OVERALL,
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
        content: diverging("opus content"),
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
      minRounds: 1,
      overallTimeoutMs: OVERALL,
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
        content: diverging("opus"),
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
        minRounds: 1,
        overallTimeoutMs: OVERALL,
      }),
    ).rejects.toThrow(/budget-exceeded/);
  });

  it("L-1: an auth error is NOT degradable — it propagates", async () => {
    const gateway = makeGateway((req) => {
      if (req.modelSlug === GEMINI) {
        return Promise.reject(new Error("401 Unauthorized: invalid credentials"));
      }
      return Promise.resolve({
        content: diverging("opus"),
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
        minRounds: 1,
        overallTimeoutMs: OVERALL,
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
        content: diverging("opus"),
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
        minRounds: 1,
        overallTimeoutMs: OVERALL,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
    expect(geminiCalls).toBe(1); // aborted → no retry
  });
});

// ── CORE fake-timer streaming regression (#366 carried) ─────────────────────

/**
 * A streaming provider that emits a growing assistant text every chunkDelayMs of
 * (fake) time, ending with a terminal stability marker. The idle timer in the
 * real Gateway never fires because deltas arrive inside every idle window — so a
 * turn spanning far more than 90_000ms of virtual time COMPLETES.
 */
class TimedStabilityStreamProvider implements ILLMProvider {
  constructor(
    private readonly chunkDelayMs: number,
    private readonly chunks: number,
  ) {}

  async complete(): Promise<{ content: string; tokensUsed: number; finishReason: "stop" }> {
    return { content: diverging("done"), tokensUsed: 5, finishReason: "stop" };
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
    yield `\n${STABILITY_SENTINEL}{"explored": true, "stabilized": false}`;
  }
}

describe("DebateRunner — CORE fake-timer streaming regression (>90s turn completes)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a streamed turn emitting deltas past 90_000ms virtual time COMPLETES (no wall-clock kill)", async () => {
    const provider = new TimedStabilityStreamProvider(50_000, 12);
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
        minRounds: 1,
        // Per-turn streaming uses STREAM_CFG.overallTimeoutMs (600s); the engine's
        // overall is huge so only the per-turn idle/overall matter here.
        overallTimeoutMs: 1_000_000_000,
        streamingDebate: STREAM_CFG,
      })
      .finally(() => {
        settled = true;
      });

    for (let i = 0; i < 200 && !settled; i++) {
      await vi.advanceTimersByTimeAsync(50_000);
    }
    const result = await runPromise;

    expect(result.roundsRun).toBe(1);
    expect(result.details.rounds.length).toBeGreaterThanOrEqual(2);
    const proposer = result.details.rounds.find((r) => r.role === "proposer");
    expect(proposer?.content).toContain("tok1");
    expect(proposer?.content).not.toContain(STABILITY_SENTINEL);
  });
});

// ── Adaptive-stability termination (the engine) ─────────────────────────────

/**
 * A blocking scripted gateway whose participant turns carry a per-round
 * (explored, stabilized) decision driven by a script keyed on round index
 * (1-based). The judge turn is short-circuited by the runner.
 */
function stabilityGateway(roundDecisions: Array<{ e: boolean; s: boolean }>) {
  let participantTurn = 0;
  return makeGateway((req) => {
    if (isJudge(req)) {
      return { content: "final verdict", tokensUsed: 1, modelSlug: OPUS, finishReason: "stop" };
    }
    const round = Math.floor(participantTurn / 2);
    participantTurn += 1;
    const dec = roundDecisions[Math.min(round, roundDecisions.length - 1)];
    return {
      content: withMarker(`round-${round + 1} turn`, dec.e, dec.s),
      tokensUsed: 1,
      modelSlug: OPUS,
      finishReason: "stop",
    };
  });
}

describe("DebateRunner — adaptive-stability termination (engine)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("T-DEB-1 ANTI-PREMATURE: an immediate stable signal at round 1 does NOT stop (floor>=2)", async () => {
    // Every round is explored+stabilized (a stop candidate). The min-rounds floor
    // (2) blocks round 1; round 2 stable then stops with high confidence.
    const gateway = stabilityGateway([
      { e: true, s: true },
      { e: true, s: true },
      { e: true, s: true },
    ]);
    const runner = makeRunner(gateway);
    const result = await runner.run({
      runId: "run-1",
      stepId: "step-1",
      question: "q",
      rounds: 5,
      budget: new TokenBudget(1_000_000),
      geminiTurnTimeoutMs: 90_000,
      minRounds: 2,
      overallTimeoutMs: OVERALL,
    });
    expect(result.roundsRun).toBe(2);
    expect(result.stopReason).toBe("stable");
    expect(result.confidence).toBe("high");
  });

  it("T-DEB-2 stable at round 2 stops with high confidence", async () => {
    const gateway = stabilityGateway([
      { e: true, s: false }, // round 1 diverging
      { e: true, s: true }, // round 2 stable → stop
      { e: true, s: true },
    ]);
    const runner = makeRunner(gateway);
    const result = await runner.run({
      runId: "run-1",
      stepId: "step-1",
      question: "q",
      rounds: 5,
      budget: new TokenBudget(1_000_000),
      geminiTurnTimeoutMs: 90_000,
      minRounds: 2,
      overallTimeoutMs: OVERALL,
    });
    expect(result.roundsRun).toBe(2);
    expect(result.confidence).toBe("high");
    const judgeCalls = (gateway as unknown as ScriptedGateway).calls.filter(isJudge);
    expect(judgeCalls).toHaveLength(1);
  });

  it("'stabilized but NOT explored' keeps diverging (double-duty) — runs to cap", async () => {
    // stabilized=true but explored=false ⇒ still-diverging ⇒ no stop. The case
    // K=1 novelty could NOT express. Runs to the hard cap.
    const gateway = stabilityGateway([
      { e: false, s: true },
      { e: false, s: true },
      { e: false, s: true },
    ]);
    const runner = makeRunner(gateway);
    const result = await runner.run({
      runId: "run-1",
      stepId: "step-1",
      question: "q",
      rounds: 3,
      budget: new TokenBudget(1_000_000),
      geminiTurnTimeoutMs: 90_000,
      minRounds: 2,
      overallTimeoutMs: OVERALL,
    });
    expect(result.roundsRun).toBe(3);
    expect(result.stopReason).toBe("hard-cap");
    expect(result.confidence).toBe("low");
  });

  it("T-DEB-3 hard-cap backstop: every round diverging → runs exactly maxRounds then stops", async () => {
    const gateway = stabilityGateway([
      { e: true, s: false },
      { e: true, s: false },
      { e: true, s: false },
    ]);
    const runner = makeRunner(gateway);
    const result = await runner.run({
      runId: "run-1",
      stepId: "step-1",
      question: "q",
      rounds: 3,
      budget: new TokenBudget(1_000_000),
      geminiTurnTimeoutMs: 90_000,
      minRounds: 2,
      overallTimeoutMs: OVERALL,
    });
    expect(result.roundsRun).toBe(3);
    expect(result.stopReason).toBe("hard-cap");
    const judgeCalls = (gateway as unknown as ScriptedGateway).calls.filter(isJudge);
    expect(judgeCalls).toHaveLength(1);
  });

  it("a fail-open (no marker) round keeps diverging → does NOT stop early", async () => {
    let participantTurn = 0;
    const gateway = makeGateway((req) => {
      if (isJudge(req)) {
        return { content: "verdict", tokensUsed: 1, modelSlug: OPUS, finishReason: "stop" };
      }
      const round = Math.floor(participantTurn / 2);
      participantTurn += 1;
      // No marker at all (fail-open = continue) on every round.
      return { content: "round no marker", tokensUsed: 1, modelSlug: OPUS, finishReason: "stop" };
    });
    const runner = makeRunner(gateway);
    const result = await runner.run({
      runId: "run-1",
      stepId: "step-1",
      question: "q",
      rounds: 3,
      budget: new TokenBudget(1_000_000),
      geminiTurnTimeoutMs: 90_000,
      minRounds: 2,
      overallTimeoutMs: OVERALL,
    });
    expect(result.roundsRun).toBe(3); // fail-open never stops early
    expect(result.stopReason).toBe("hard-cap");
  });
});

// ── Transcript hygiene (C-1) ────────────────────────────────────────────────

describe("DebateRunner — transcript hygiene (C-1)", () => {
  it("strips the <<<STABILITY>>> marker from persisted rounds AND WS payloads", async () => {
    const broadcast = vi.fn();
    const ws = { broadcastToRun: broadcast } as unknown as WsManager;
    const gateway = makeGateway((req) =>
      isJudge(req)
        ? { content: "verdict", tokensUsed: 1, modelSlug: OPUS, finishReason: "stop" }
        : { content: stable("genuine reasoning"), tokensUsed: 1, modelSlug: OPUS, finishReason: "stop" },
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
      rounds: 2,
      budget: new TokenBudget(1_000_000),
      geminiTurnTimeoutMs: 90_000,
      minRounds: 2,
      overallTimeoutMs: OVERALL,
    });

    expect(JSON.stringify(result.details.rounds)).not.toContain(STABILITY_SENTINEL);
    expect(result.details.rounds[0].content).toContain("genuine reasoning");

    for (const call of broadcast.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(STABILITY_SENTINEL);
    }
  });
});

// ── Abort + budget backstops ────────────────────────────────────────────────

describe("DebateRunner — abort + backstops", () => {
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
        minRounds: 2,
        overallTimeoutMs: OVERALL,
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
        minRounds: 2,
        overallTimeoutMs: OVERALL,
      }),
    ).rejects.toThrow(/boom/);
  });

  it("overall-timeout backstop: a debate whose elapsed exceeds the overall cap stops with timeout/low", async () => {
    // Each diverging participant turn advances fake time by 40s; with a 60s overall
    // cap, the engine's decideStop sees elapsed > overall after round 2 and stops
    // with the timeout backstop (always low confidence), short of the 3-round cap.
    vi.useFakeTimers();
    try {
      const gateway = makeGateway((req) => {
        if (isJudge(req)) {
          return { content: "verdict", tokensUsed: 1, modelSlug: OPUS, finishReason: "stop" };
        }
        // Advance virtual wall-clock so Date.now() grows between turns.
        vi.advanceTimersByTime(40_000);
        return { content: diverging("turn"), tokensUsed: 1, modelSlug: OPUS, finishReason: "stop" };
      });
      const runner = makeRunner(gateway);
      const result = await runner.run({
        runId: "run-1",
        stepId: "step-1",
        question: "q",
        rounds: 3,
        budget: new TokenBudget(1_000_000),
        geminiTurnTimeoutMs: 90_000,
        minRounds: 1,
        overallTimeoutMs: 60_000,
      });
      expect(result.stopReason).toBe("timeout");
      expect(result.confidence).toBe("low");
      expect(result.roundsRun).toBeLessThan(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
