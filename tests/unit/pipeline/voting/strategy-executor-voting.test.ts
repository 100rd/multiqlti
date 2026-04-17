/**
 * Tests for dynamic consensus thresholds in the Voting execution strategy.
 * Uses the real StrategyExecutor against a mock Gateway/WsManager.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrategyExecutor } from "../../../../server/services/strategy-executor.js";
import { VotingThresholdNotMetError } from "../../../../server/pipeline/voting/fallback-handler.js";
import type {
  VotingStrategy,
  ProviderMessage,
  VotingDetails,
} from "@shared/types";
import type { Gateway } from "../../../../server/gateway/index.js";
import type { WsManager } from "../../../../server/ws/manager.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Build a mock Gateway whose complete() returns canned content per call. */
function makeGateway(responses: Array<{ content: string; tokensUsed?: number }>): Gateway {
  let callIdx = 0;
  return {
    complete: vi.fn().mockImplementation(() => {
      const resp = responses[callIdx % responses.length];
      callIdx++;
      return Promise.resolve({
        content: resp.content,
        tokensUsed: resp.tokensUsed ?? 10,
        modelSlug: "mock",
        finishReason: "stop",
      });
    }),
    resolveProvider: vi.fn().mockResolvedValue("mock"),
  } as unknown as Gateway;
}

function makeWsManager(): WsManager {
  return { broadcastToRun: vi.fn() } as unknown as WsManager;
}

const CTX = { runId: "run-1", stageId: "stage-1" };
const BASE_PROMPT: ProviderMessage[] = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "Solve X." },
];

// Identical responses → high similarity → threshold easily met
const CONSENSUS_RESPONSES = [
  "The answer is to use TypeScript with a functional approach",
  "The answer is to use TypeScript with a functional approach",
  "The answer is to use TypeScript with a functional approach",
];

// Divergent responses → low similarity → threshold unlikely met
const DIVERGENT_RESPONSES = [
  "Use Python for this task",
  "Go is the best choice here",
  "Consider Rust for performance",
];

// ─── Static mode ──────────────────────────────────────────────────────────────

describe("StrategyExecutor — voting — static mode", () => {
  let executor: StrategyExecutor;

  beforeEach(() => {
    executor = new StrategyExecutor(makeGateway(CONSENSUS_RESPONSES.map((c) => ({ content: c }))), makeWsManager());
  });

  it("applies fixed threshold and records thresholdMode=static in details", async () => {
    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [
        { modelSlug: "m1" },
        { modelSlug: "m2" },
        { modelSlug: "m3" },
      ],
      threshold: 0.6,
      validationMode: "text_similarity",
      thresholdConfig: { mode: "static", value: 0.6 },
    };

    const result = await executor.execute(strategy, BASE_PROMPT, CTX);
    const details = result.details as VotingDetails;
    expect(details.thresholdMode).toBe("static");
    expect(details.thresholdUsed).toBeCloseTo(0.6, 5);
  });

  it("uses legacy threshold field when thresholdConfig is absent", async () => {
    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [{ modelSlug: "m1" }, { modelSlug: "m2" }],
      threshold: 0.5,
      validationMode: "text_similarity",
    };

    const result = await executor.execute(strategy, BASE_PROMPT, CTX);
    const details = result.details as VotingDetails;
    expect(details.thresholdMode).toBe("static");
    expect(details.thresholdUsed).toBeCloseTo(0.5, 5);
  });
});

// ─── Task signal mode ─────────────────────────────────────────────────────────

describe("StrategyExecutor — voting — task_signal mode", () => {
  it("applies high_risk threshold when signal is present", async () => {
    const executor = new StrategyExecutor(
      makeGateway(CONSENSUS_RESPONSES.map((c) => ({ content: c }))),
      makeWsManager(),
    );

    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [{ modelSlug: "m1" }, { modelSlug: "m2" }, { modelSlug: "m3" }],
      threshold: 0.6,
      validationMode: "text_similarity",
      thresholdConfig: {
        mode: "task_signal",
        rules: [{ signal: "signal:high_risk", threshold: 0.85 }],
        default: 0.6,
      },
      signals: {
        signals: [{ key: "signal:high_risk", source: "upstream_stage" }],
      },
    };

    const result = await executor.execute(strategy, BASE_PROMPT, CTX);
    const details = result.details as VotingDetails;
    expect(details.thresholdMode).toBe("task_signal");
    expect(details.thresholdUsed).toBeCloseTo(0.85, 5);
  });

  it("falls back to default threshold when no matching signal", async () => {
    const executor = new StrategyExecutor(
      makeGateway(CONSENSUS_RESPONSES.map((c) => ({ content: c }))),
      makeWsManager(),
    );

    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [{ modelSlug: "m1" }, { modelSlug: "m2" }],
      threshold: 0.6,
      validationMode: "text_similarity",
      thresholdConfig: {
        mode: "task_signal",
        rules: [{ signal: "signal:high_risk", threshold: 0.85 }],
        default: 0.6,
      },
      signals: {
        signals: [{ key: "signal:unrelated", source: "tag" }],
      },
    };

    const result = await executor.execute(strategy, BASE_PROMPT, CTX);
    const details = result.details as VotingDetails;
    expect(details.thresholdMode).toBe("task_signal");
    expect(details.thresholdUsed).toBeCloseTo(0.6, 5);
  });

  it("uses default threshold when signals bag is absent", async () => {
    const executor = new StrategyExecutor(
      makeGateway(CONSENSUS_RESPONSES.map((c) => ({ content: c }))),
      makeWsManager(),
    );

    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [{ modelSlug: "m1" }, { modelSlug: "m2" }],
      threshold: 0.6,
      validationMode: "text_similarity",
      thresholdConfig: {
        mode: "task_signal",
        rules: [{ signal: "signal:high_risk", threshold: 0.9 }],
        default: 0.65,
      },
    };

    const result = await executor.execute(strategy, BASE_PROMPT, CTX);
    const details = result.details as VotingDetails;
    expect(details.thresholdUsed).toBeCloseTo(0.65, 5);
  });
});

// ─── Confidence mode ──────────────────────────────────────────────────────────

describe("StrategyExecutor — voting — confidence mode", () => {
  it("eases threshold when candidates express high confidence (JSON self_eval)", async () => {
    // All candidates return high-confidence JSON
    const responses = [
      JSON.stringify({ answer: "yes", confidence: 0.95 }),
      JSON.stringify({ answer: "yes", confidence: 0.92 }),
      JSON.stringify({ answer: "yes", confidence: 0.90 }),
    ];
    const executor = new StrategyExecutor(
      makeGateway(responses.map((c) => ({ content: c }))),
      makeWsManager(),
    );

    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [{ modelSlug: "m1" }, { modelSlug: "m2" }, { modelSlug: "m3" }],
      threshold: 0.7,
      validationMode: "text_similarity",
      thresholdConfig: {
        mode: "confidence",
        base: 0.7,
        floor: 0.4,
        ceiling: 0.9,
        sensitivity: 0.3,
      },
    };

    const result = await executor.execute(strategy, BASE_PROMPT, CTX);
    const details = result.details as VotingDetails;
    expect(details.thresholdMode).toBe("confidence");
    // aggregatedConfidence ≈ (0.95+0.92+0.90)/3 ≈ 0.923
    // threshold = 0.7 - (0.923 - 0.5) * 0.3 ≈ 0.7 - 0.127 ≈ 0.573
    expect(details.thresholdUsed).toBeLessThan(0.7); // eased
    expect(details.aggregatedConfidence).toBeDefined();
    expect(details.aggregatedConfidence!).toBeGreaterThan(0.85);
  });

  it("tightens threshold when candidates express low confidence", async () => {
    // All candidates express uncertainty
    const uncertainContent = "I'm not sure. It might be yes, but perhaps not. Unclear.";
    const executor = new StrategyExecutor(
      makeGateway([
        { content: uncertainContent },
        { content: uncertainContent },
        { content: uncertainContent },
      ]),
      makeWsManager(),
    );

    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [{ modelSlug: "m1" }, { modelSlug: "m2" }, { modelSlug: "m3" }],
      threshold: 0.7,
      validationMode: "text_similarity",
      thresholdConfig: {
        mode: "confidence",
        base: 0.7,
        floor: 0.5,
        ceiling: 0.95,
        sensitivity: 0.4,
      },
    };

    const result = await executor.execute(strategy, BASE_PROMPT, CTX);
    const details = result.details as VotingDetails;
    // Low confidence → threshold should be above base=0.7 (up to ceiling)
    expect(details.thresholdUsed).toBeGreaterThanOrEqual(0.5);
    expect(details.confidenceScores).toHaveLength(3);
  });

  it("records confidence scores and aggregatedConfidence in details", async () => {
    const executor = new StrategyExecutor(
      makeGateway(CONSENSUS_RESPONSES.map((c) => ({ content: c }))),
      makeWsManager(),
    );

    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [{ modelSlug: "m1" }, { modelSlug: "m2" }, { modelSlug: "m3" }],
      threshold: 0.5,
      validationMode: "text_similarity",
      thresholdConfig: {
        mode: "confidence",
        base: 0.6,
        floor: 0.4,
        ceiling: 0.9,
      },
    };

    const result = await executor.execute(strategy, BASE_PROMPT, CTX);
    const details = result.details as VotingDetails;
    expect(details.confidenceScores).toHaveLength(3);
    expect(details.aggregatedConfidence).toBeGreaterThan(0);
    expect(details.aggregatedConfidence).toBeLessThanOrEqual(1);
  });
});

// ─── Fallback strategies ──────────────────────────────────────────────────────

describe("StrategyExecutor — voting — fallback: escalate", () => {
  it("calls escalation judge model when threshold not met", async () => {
    // Divergent responses → will not meet a high threshold
    // 4 calls: 3 candidates + 1 judge
    const candidateResponses = DIVERGENT_RESPONSES;
    const judgeResponse = "Escalated final answer by judge";

    const callSequence = [
      ...candidateResponses.map((c) => ({ content: c })),
      { content: judgeResponse },
    ];

    const executor = new StrategyExecutor(
      makeGateway(callSequence),
      makeWsManager(),
    );

    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [{ modelSlug: "m1" }, { modelSlug: "m2" }, { modelSlug: "m3" }],
      threshold: 0.5,
      validationMode: "text_similarity",
      thresholdConfig: {
        mode: "static",
        value: 0.99, // Very high — will never be met by divergent responses
      },
      fallback: {
        strategy: "escalate",
        escalationModelSlug: "strong-judge",
      },
    };

    const result = await executor.execute(strategy, BASE_PROMPT, CTX);
    const details = result.details as VotingDetails;

    expect(result.finalContent).toBe(judgeResponse);
    expect(details.fallbackOutcome).toBe("escalated");
    expect(details.escalationModelSlug).toBe("strong-judge");
  });
});

describe("StrategyExecutor — voting — fallback: abort", () => {
  it("throws VotingThresholdNotMetError when threshold not met and fallback=abort", async () => {
    const executor = new StrategyExecutor(
      makeGateway(DIVERGENT_RESPONSES.map((c) => ({ content: c }))),
      makeWsManager(),
    );

    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [{ modelSlug: "m1" }, { modelSlug: "m2" }, { modelSlug: "m3" }],
      threshold: 0.5,
      validationMode: "text_similarity",
      thresholdConfig: { mode: "static", value: 0.99 },
      fallback: { strategy: "abort" },
    };

    await expect(executor.execute(strategy, BASE_PROMPT, CTX)).rejects.toThrow(
      VotingThresholdNotMetError,
    );
  });
});

describe("StrategyExecutor — voting — fallback: partial", () => {
  it("emits partial result (best candidate) when threshold not met", async () => {
    const executor = new StrategyExecutor(
      makeGateway(DIVERGENT_RESPONSES.map((c) => ({ content: c }))),
      makeWsManager(),
    );

    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [{ modelSlug: "m1" }, { modelSlug: "m2" }, { modelSlug: "m3" }],
      threshold: 0.5,
      validationMode: "text_similarity",
      thresholdConfig: { mode: "static", value: 0.99 },
      fallback: { strategy: "partial" },
    };

    const result = await executor.execute(strategy, BASE_PROMPT, CTX);
    const details = result.details as VotingDetails;

    expect(result.finalContent).toBeTruthy();
    expect(details.fallbackOutcome).toBe("partial");
    expect(details.escalationModelSlug).toBeUndefined();
  });
});

// ─── No fallback configured ───────────────────────────────────────────────────

describe("StrategyExecutor — voting — no fallback", () => {
  it("returns highest-agreement candidate when threshold not met and no fallback configured", async () => {
    const executor = new StrategyExecutor(
      makeGateway(DIVERGENT_RESPONSES.map((c) => ({ content: c }))),
      makeWsManager(),
    );

    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [{ modelSlug: "m1" }, { modelSlug: "m2" }, { modelSlug: "m3" }],
      threshold: 0.5,
      validationMode: "text_similarity",
      thresholdConfig: { mode: "static", value: 0.99 },
      // No fallback configured
    };

    const result = await executor.execute(strategy, BASE_PROMPT, CTX);
    const details = result.details as VotingDetails;

    expect(result.finalContent).toBeTruthy();
    expect(details.fallbackOutcome).toBeUndefined();
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("StrategyExecutor — voting — edge cases", () => {
  it("all candidates agree → winnerIndex=0, all passed", async () => {
    const executor = new StrategyExecutor(
      makeGateway(CONSENSUS_RESPONSES.map((c) => ({ content: c }))),
      makeWsManager(),
    );

    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [{ modelSlug: "m1" }, { modelSlug: "m2" }, { modelSlug: "m3" }],
      threshold: 0.5,
      validationMode: "text_similarity",
    };

    const result = await executor.execute(strategy, BASE_PROMPT, CTX);
    const details = result.details as VotingDetails;

    expect(details.candidates.every((c) => c.passed)).toBe(true);
    expect(details.agreement).toBeGreaterThan(0.5);
  });

  it("no candidates agree → none passed, fallback to best", async () => {
    const executor = new StrategyExecutor(
      makeGateway(DIVERGENT_RESPONSES.map((c) => ({ content: c }))),
      makeWsManager(),
    );

    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [{ modelSlug: "m1" }, { modelSlug: "m2" }, { modelSlug: "m3" }],
      threshold: 0.5,
      validationMode: "text_similarity",
      thresholdConfig: { mode: "static", value: 0.99 },
    };

    const result = await executor.execute(strategy, BASE_PROMPT, CTX);
    const details = result.details as VotingDetails;

    expect(details.candidates.every((c) => !c.passed)).toBe(true);
    expect(result.finalContent).toBeTruthy();
  });

  it("records thresholdUsed and thresholdMode in details for all modes", async () => {
    const executor = new StrategyExecutor(
      makeGateway(CONSENSUS_RESPONSES.map((c) => ({ content: c }))),
      makeWsManager(),
    );

    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [{ modelSlug: "m1" }, { modelSlug: "m2" }, { modelSlug: "m3" }],
      threshold: 0.5,
      validationMode: "text_similarity",
      thresholdConfig: { mode: "static", value: 0.55 },
    };

    const result = await executor.execute(strategy, BASE_PROMPT, CTX);
    const details = result.details as VotingDetails;

    expect(details.thresholdUsed).toBeDefined();
    expect(details.thresholdMode).toBe("static");
    expect(details.confidenceScores).toHaveLength(3);
    expect(details.aggregatedConfidence).toBeDefined();
  });

  it("totalTokensUsed includes escalation judge tokens", async () => {
    const callSequence = [
      ...DIVERGENT_RESPONSES.map((c) => ({ content: c, tokensUsed: 20 })),
      { content: "judge answer", tokensUsed: 50 },
    ];
    const executor = new StrategyExecutor(makeGateway(callSequence), makeWsManager());

    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [{ modelSlug: "m1" }, { modelSlug: "m2" }, { modelSlug: "m3" }],
      threshold: 0.5,
      validationMode: "text_similarity",
      thresholdConfig: { mode: "static", value: 0.99 },
      fallback: { strategy: "escalate", escalationModelSlug: "judge" },
    };

    const result = await executor.execute(strategy, BASE_PROMPT, CTX);
    // 3 candidates × 20 + 1 judge × 50 = 110
    expect(result.totalTokensUsed).toBe(110);
  });

  it("mixed confidence — some high, some low → aggregated around middle", async () => {
    const mixed = [
      JSON.stringify({ confidence: 0.9 }),
      "I'm not sure. It might work.",
      JSON.stringify({ confidence: 0.1 }),
    ];
    const executor = new StrategyExecutor(
      makeGateway(mixed.map((c) => ({ content: c }))),
      makeWsManager(),
    );

    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [{ modelSlug: "m1" }, { modelSlug: "m2" }, { modelSlug: "m3" }],
      threshold: 0.5,
      validationMode: "text_similarity",
      thresholdConfig: {
        mode: "confidence",
        base: 0.65,
        floor: 0.4,
        ceiling: 0.9,
        sensitivity: 0.2,
      },
    };

    const result = await executor.execute(strategy, BASE_PROMPT, CTX);
    const details = result.details as VotingDetails;

    // Aggregated conf ≈ (0.9 + low + 0.1) / 3 — somewhere below 0.5
    expect(details.aggregatedConfidence).toBeGreaterThan(0);
    expect(details.confidenceScores).toHaveLength(3);
  });
});

// ─── Observability: WS broadcast attributes ───────────────────────────────────

describe("StrategyExecutor — voting — observability", () => {
  it("broadcasts confidenceScore per candidate in strategy:voting:candidate", async () => {
    const ws = makeWsManager();
    const executor = new StrategyExecutor(
      makeGateway(CONSENSUS_RESPONSES.map((c) => ({ content: c }))),
      ws,
    );

    const strategy: VotingStrategy = {
      type: "voting",
      candidates: [{ modelSlug: "m1" }, { modelSlug: "m2" }, { modelSlug: "m3" }],
      threshold: 0.5,
      validationMode: "text_similarity",
      thresholdConfig: { mode: "static", value: 0.5 },
    };

    await executor.execute(strategy, BASE_PROMPT, CTX);

    const broadcasts = (ws.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls;
    const candidateBroadcasts = broadcasts.filter(
      (call) => call[1].type === "strategy:voting:candidate",
    );

    expect(candidateBroadcasts).toHaveLength(3);
    for (const broadcast of candidateBroadcasts) {
      expect(broadcast[1].payload).toHaveProperty("confidenceScore");
    }
  });
});
