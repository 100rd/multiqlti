/**
 * consult-service.test.ts — the standalone multi-model Q&A orchestration.
 *
 * Drives the service with a FAKE gateway (no real LLM), asserting the contract:
 *   - answers run in parallel, one per selected model, in input order;
 *   - one model failing (throw / empty) isolates to that model's errorMessage —
 *     the batch still returns every other model's answer;
 *   - a debate round feeds each model the OTHER models' answers (not its own);
 *   - the handoff instruction carries the question + usable answers.
 */
import { describe, it, expect } from "vitest";
import {
  answerIndependently,
  debate,
  buildHandoffInstruction,
  type ConsultGateway,
  type ConsultModelAnswer,
} from "../../../server/services/consult/consult-service";

type Handler = (modelSlug: string, userContent: string) => Promise<{ content: string }>;

/** A fake gateway that records calls and delegates to a per-model handler. */
class FakeGateway implements ConsultGateway {
  public readonly calls: Array<{ modelSlug: string; user: string; system: string }> = [];
  constructor(private readonly handler: Handler) {}

  async completeStreaming(request: {
    modelSlug: string;
    messages: Array<{ role: string; content: string }>;
  }): Promise<{ content: string }> {
    const user = request.messages.find((m) => m.role === "user")?.content ?? "";
    const system = request.messages.find((m) => m.role === "system")?.content ?? "";
    this.calls.push({ modelSlug: request.modelSlug, user, system });
    return this.handler(request.modelSlug, user);
  }
}

describe("answerIndependently", () => {
  it("returns one answer per model, in input order", async () => {
    const gw = new FakeGateway(async (slug) => ({ content: `answer from ${slug}` }));
    const out = await answerIndependently(gw, "use cloud WAN?", ["gpt-x", "claude-y"]);

    expect(out.map((a) => a.modelSlug)).toEqual(["gpt-x", "claude-y"]);
    expect(out[0]).toEqual({ modelSlug: "gpt-x", content: "answer from gpt-x", errorMessage: null });
    expect(out[1].content).toBe("answer from claude-y");
    expect(out.every((a) => a.errorMessage === null)).toBe(true);
  });

  it("isolates a failing model without failing the batch", async () => {
    const gw = new FakeGateway(async (slug) => {
      if (slug === "bad") throw new Error("provider exploded");
      return { content: `ok ${slug}` };
    });
    const out = await answerIndependently(gw, "q", ["good", "bad", "also-good"]);

    expect(out[0]).toMatchObject({ modelSlug: "good", content: "ok good", errorMessage: null });
    expect(out[1]).toMatchObject({ modelSlug: "bad", content: null });
    expect(out[1].errorMessage).toContain("provider exploded");
    expect(out[2]).toMatchObject({ modelSlug: "also-good", content: "ok also-good" });
  });

  it("treats empty/whitespace output as a per-model error", async () => {
    const gw = new FakeGateway(async () => ({ content: "   " }));
    const out = await answerIndependently(gw, "q", ["m1"]);
    expect(out[0].content).toBeNull();
    expect(out[0].errorMessage).toBe("the model returned an empty answer");
  });
});

describe("debate", () => {
  it("feeds each model the OTHER models' answers, not its own", async () => {
    const prior: ConsultModelAnswer[] = [
      { modelSlug: "alpha", content: "ALPHA_SAYS_YES", errorMessage: null },
      { modelSlug: "beta", content: "BETA_SAYS_NO", errorMessage: null },
    ];
    const gw = new FakeGateway(async (slug) => ({ content: `refined ${slug}` }));
    await debate(gw, "the question", prior, ["alpha", "beta"]);

    const alphaCall = gw.calls.find((c) => c.modelSlug === "alpha")!;
    const betaCall = gw.calls.find((c) => c.modelSlug === "beta")!;

    // alpha sees beta's answer but not its own text quoted as a "peer"
    expect(alphaCall.user).toContain("BETA_SAYS_NO");
    expect(alphaCall.user).toContain("Peer model beta");
    expect(alphaCall.user).not.toContain("Peer model alpha");
    // beta sees alpha's answer
    expect(betaCall.user).toContain("ALPHA_SAYS_YES");
    expect(betaCall.user).toContain("the question");
  });

  it("still runs a model whose prior answer errored", async () => {
    const prior: ConsultModelAnswer[] = [
      { modelSlug: "alpha", content: null, errorMessage: "timed out" },
      { modelSlug: "beta", content: "BETA_ANSWER", errorMessage: null },
    ];
    const gw = new FakeGateway(async (slug) => ({ content: `refined ${slug}` }));
    const out = await debate(gw, "q", prior, ["alpha", "beta"]);

    expect(out.map((a) => a.modelSlug)).toEqual(["alpha", "beta"]);
    const alphaCall = gw.calls.find((c) => c.modelSlug === "alpha")!;
    expect(alphaCall.user).toContain("BETA_ANSWER");
    expect(out[0].content).toBe("refined alpha");
  });
});

describe("buildHandoffInstruction", () => {
  it("carries the question and each usable answer, skips failed ones", () => {
    const answers: ConsultModelAnswer[] = [
      { modelSlug: "alpha", content: "recommend option A", errorMessage: null },
      { modelSlug: "beta", content: null, errorMessage: "failed" },
    ];
    const text = buildHandoffInstruction("should I use cloud WAN?", answers);

    expect(text).toContain("should I use cloud WAN?");
    expect(text).toContain("## alpha");
    expect(text).toContain("recommend option A");
    expect(text).not.toContain("## beta");
    expect(text).toContain("# Task");
  });

  it("degrades gracefully when no answers are usable", () => {
    const text = buildHandoffInstruction("q", [
      { modelSlug: "m", content: null, errorMessage: "x" },
    ]);
    expect(text).toContain("(no model answers were captured)");
  });
});
