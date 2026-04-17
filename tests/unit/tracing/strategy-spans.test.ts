import { describe, it, expect } from "vitest";
import { LlmSpanEnricher } from "../../../server/tracing/llm-span.js";
import { Tracer } from "../../../server/tracing/tracer.js";
import { OI_SPAN_KIND, OI } from "../../../server/tracing/openinference.js";

function makeEnricher() {
  const testTracer = new Tracer();
  const enricher = new LlmSpanEnricher({}, testTracer);
  return { testTracer, enricher };
}

/**
 * Tests that verify strategy (debate / voting / MoA) spans wrap their
 * candidate and judge/merge child spans correctly.
 */
describe("Strategy span grouping", () => {
  it("1. debate strategy span wraps proposer + judge child spans", () => {
    const { testTracer, enricher } = makeEnricher();
    const runId = "strategy-debate-run-1";
    const tid = testTracer.startTrace(runId);

    // Parent: strategy.debate span
    const stratSpanId = enricher.startStrategySpan({
      traceId: tid,
      strategyType: "debate",
      runId,
      stageId: "development",
    });

    // Child 1: proposer LLM call
    const p1SpanId = enricher.startLlmCall({
      traceId: tid,
      parentSpanId: stratSpanId,
      modelSlug: "claude-sonnet-4-6",
      prompt: "Proposer turn 1",
      stageRole: "proposer",
      runId,
    });
    enricher.endLlmCall(p1SpanId, tid, { response: "My proposal", totalTokens: 100 }, "ok", "claude-sonnet-4-6");

    // Child 2: critic LLM call
    const p2SpanId = enricher.startLlmCall({
      traceId: tid,
      parentSpanId: stratSpanId,
      modelSlug: "gpt-4o",
      prompt: "Critic turn 1",
      stageRole: "critic",
      runId,
    });
    enricher.endLlmCall(p2SpanId, tid, { response: "I disagree", totalTokens: 80 }, "ok", "gpt-4o");

    // Child 3: judge LLM call
    const judgeSpanId = enricher.startLlmCall({
      traceId: tid,
      parentSpanId: stratSpanId,
      modelSlug: "claude-opus-4",
      prompt: "Judge final verdict",
      stageRole: "judge",
      runId,
    });
    enricher.endLlmCall(judgeSpanId, tid, { response: "Verdict: option A", totalTokens: 50 }, "ok", "claude-opus-4");

    // End strategy span
    enricher.endStrategySpan(stratSpanId, "ok", { candidateCount: 2, rounds: 1 });

    const trace = testTracer.getTrace(tid);
    expect(trace).not.toBeNull();

    const stratSpan = trace!.spans.find((s) => s.spanId === stratSpanId);
    expect(stratSpan).toBeDefined();
    expect(stratSpan!.name).toBe("strategy.debate");
    expect(stratSpan!.attributes["openinference.span.kind"]).toBe(OI_SPAN_KIND.CHAIN);
    expect(stratSpan!.attributes["strategy.type"]).toBe("debate");
    expect(stratSpan!.attributes["strategy.candidate_count"]).toBe(2);

    // Verify children have correct parentSpanId pointing to strategy span
    const proposer = trace!.spans.find((s) => s.spanId === p1SpanId);
    const critic   = trace!.spans.find((s) => s.spanId === p2SpanId);
    const judge    = trace!.spans.find((s) => s.spanId === judgeSpanId);

    expect(proposer!.parentSpanId).toBe(stratSpanId);
    expect(critic!.parentSpanId).toBe(stratSpanId);
    expect(judge!.parentSpanId).toBe(stratSpanId);

    // Verify role attributes
    expect(proposer!.attributes[OI.STAGE_ROLE]).toBe("proposer");
    expect(critic!.attributes[OI.STAGE_ROLE]).toBe("critic");
    expect(judge!.attributes[OI.STAGE_ROLE]).toBe("judge");
  });

  it("2. MoA strategy span wraps proposers + aggregator", () => {
    const { testTracer, enricher } = makeEnricher();
    const runId = "strategy-moa-run-2";
    const tid = testTracer.startTrace(runId);

    const stratSpanId = enricher.startStrategySpan({ traceId: tid, strategyType: "moa", runId });

    // 3 proposers
    for (let i = 0; i < 3; i++) {
      const sid = enricher.startLlmCall({
        traceId: tid,
        parentSpanId: stratSpanId,
        modelSlug: "claude-sonnet-4-6",
        prompt: `Proposer ${i}`,
        stageRole: "proposer",
        runId,
      });
      enricher.endLlmCall(sid, tid, { response: `response ${i}`, totalTokens: 50 }, "ok", "claude-sonnet-4-6");
    }

    // Aggregator
    const aggSpanId = enricher.startLlmCall({
      traceId: tid,
      parentSpanId: stratSpanId,
      modelSlug: "claude-opus-4",
      prompt: "Aggregate proposals",
      stageRole: "aggregator",
      runId,
    });
    enricher.endLlmCall(aggSpanId, tid, { response: "Final merged result", totalTokens: 200 }, "ok", "claude-opus-4");

    enricher.endStrategySpan(stratSpanId, "ok", { candidateCount: 3 });

    const trace = testTracer.getTrace(tid);
    const stratSpan = trace!.spans.find((s) => s.spanId === stratSpanId);

    expect(stratSpan!.attributes["strategy.type"]).toBe("moa");
    expect(stratSpan!.attributes["strategy.candidate_count"]).toBe(3);

    // All children point to strategy span
    const childrenOfStrat = trace!.spans.filter((s) => s.parentSpanId === stratSpanId);
    expect(childrenOfStrat).toHaveLength(4); // 3 proposers + 1 aggregator
  });

  it("3. voting strategy span wraps 3 candidates", () => {
    const { testTracer, enricher } = makeEnricher();
    const runId = "strategy-voting-run-3";
    const tid = testTracer.startTrace(runId);

    const stratSpanId = enricher.startStrategySpan({ traceId: tid, strategyType: "voting", runId });

    const candidateModels = ["claude-sonnet-4-6", "gpt-4o", "gemini-1.5-pro"];
    for (const model of candidateModels) {
      const sid = enricher.startLlmCall({
        traceId: tid,
        parentSpanId: stratSpanId,
        modelSlug: model,
        prompt: "Vote candidate prompt",
        stageRole: "candidate",
        runId,
      });
      enricher.endLlmCall(sid, tid, { response: "candidate answer", totalTokens: 30 }, "ok", model);
    }

    enricher.endStrategySpan(stratSpanId, "ok", {
      candidateCount: 3,
      winnerModel: "claude-sonnet-4-6",
    });

    const trace = testTracer.getTrace(tid);
    const stratSpan = trace!.spans.find((s) => s.spanId === stratSpanId);

    expect(stratSpan!.attributes["strategy.type"]).toBe("voting");
    expect(stratSpan!.attributes["strategy.winner_model"]).toBe("claude-sonnet-4-6");

    const children = trace!.spans.filter((s) => s.parentSpanId === stratSpanId);
    expect(children).toHaveLength(3);
  });

  it("4. strategy span status=error when judge fails", () => {
    const { testTracer, enricher } = makeEnricher();
    const runId = "strategy-error-run-4";
    const tid = testTracer.startTrace(runId);

    const stratSpanId = enricher.startStrategySpan({ traceId: tid, strategyType: "debate", runId });
    enricher.endStrategySpan(stratSpanId, "error");

    const trace = testTracer.getTrace(tid);
    const span = trace!.spans.find((s) => s.spanId === stratSpanId);
    expect(span!.status).toBe("error");
  });

  it("5. token totals accumulate correctly across all strategy child spans", () => {
    const { testTracer, enricher } = makeEnricher();
    const runId = "strategy-tokens-run-5";
    const tid = testTracer.startTrace(runId);

    const stratSpanId = enricher.startStrategySpan({ traceId: tid, strategyType: "moa", runId });

    const tokenCounts = [100, 150, 200, 250]; // sum = 700
    for (const toks of tokenCounts) {
      const sid = enricher.startLlmCall({
        traceId: tid,
        parentSpanId: stratSpanId,
        modelSlug: "claude-sonnet-4-6",
        prompt: "test",
        runId,
      });
      enricher.endLlmCall(sid, tid, { response: "r", totalTokens: toks }, "ok", "claude-sonnet-4-6");
    }

    enricher.endStrategySpan(stratSpanId, "ok");

    const trace = testTracer.getTrace(tid);
    const totalTokens = trace!.spans
      .filter((s) => s.parentSpanId === stratSpanId)
      .reduce((sum, s) => {
        const t = s.attributes[OI.LLM_TOTAL_TOKENS];
        return sum + (typeof t === "number" ? t : 0);
      }, 0);

    expect(totalTokens).toBe(700);
  });
});
