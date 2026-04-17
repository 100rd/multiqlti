import { describe, it, expect, vi } from "vitest";
import {
  handleFallback,
  VotingThresholdNotMetError,
} from "../../../../server/pipeline/voting/fallback-handler.js";
import type { VotingFallbackConfig, ProviderMessage } from "@shared/types";
import type { Gateway } from "../../../../server/gateway/index.js";

// ─── Mock gateway ─────────────────────────────────────────────────────────────

function makeMockGateway(responseContent = "escalated answer"): Gateway {
  return {
    complete: vi.fn().mockResolvedValue({
      content: responseContent,
      tokensUsed: 42,
      modelSlug: "claude-opus-4",
      finishReason: "stop",
    }),
    resolveProvider: vi.fn().mockResolvedValue("anthropic"),
  } as unknown as Gateway;
}

// ─── Shared test fixtures ─────────────────────────────────────────────────────

const BASE_PROMPT: ProviderMessage[] = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "Solve this problem." },
];

const CANDIDATES = [
  { modelSlug: "model-a", content: "Answer A", score: 0.4 },
  { modelSlug: "model-b", content: "Answer B", score: 0.55 },
  { modelSlug: "model-c", content: "Answer C", score: 0.3 },
];

const BASE_INPUT = {
  basePrompt: BASE_PROMPT,
  candidates: CANDIDATES,
  bestCandidateIndex: 1, // model-b has highest score
  threshold: 0.7,
  bestAgreement: 0.55,
  maxTokens: 500,
};

// ─── Escalate strategy ────────────────────────────────────────────────────────

describe("handleFallback — escalate", () => {
  it("calls gateway.complete with a stronger judge model and returns content", async () => {
    const gateway = makeMockGateway("Final synthesized answer");
    const config: VotingFallbackConfig = { strategy: "escalate", escalationModelSlug: "judge-model" };

    const result = await handleFallback(config, BASE_INPUT, gateway);

    expect(result.content).toBe("Final synthesized answer");
    expect(result.outcome).toBe("escalated");
    expect(result.escalationModelSlug).toBe("judge-model");
    expect(result.tokensUsed).toBe(42);
    expect(gateway.complete).toHaveBeenCalledOnce();
  });

  it("defaults escalation model to claude-opus-4 when not specified", async () => {
    const gateway = makeMockGateway();
    const config: VotingFallbackConfig = { strategy: "escalate" };

    const result = await handleFallback(config, BASE_INPUT, gateway);

    expect(result.escalationModelSlug).toBe("claude-opus-4");
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as { modelSlug: string };
    expect(call.modelSlug).toBe("claude-opus-4");
  });

  it("includes threshold/agreement info in the judge prompt", async () => {
    const gateway = makeMockGateway();
    const config: VotingFallbackConfig = { strategy: "escalate", escalationModelSlug: "judge-model" };

    await handleFallback(config, { ...BASE_INPUT, threshold: 0.8, bestAgreement: 0.45 }, gateway);

    const messages = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].messages as ProviderMessage[];
    const lastMsg = messages[messages.length - 1].content as string;
    expect(lastMsg).toContain("threshold=0.800");
    expect(lastMsg).toContain("best agreement=0.450");
  });

  it("includes all candidate outputs in the judge prompt", async () => {
    const gateway = makeMockGateway();
    const config: VotingFallbackConfig = { strategy: "escalate", escalationModelSlug: "j" };

    await handleFallback(config, BASE_INPUT, gateway);

    const messages = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].messages as ProviderMessage[];
    const lastMsg = messages[messages.length - 1].content as string;
    expect(lastMsg).toContain("Answer A");
    expect(lastMsg).toContain("Answer B");
    expect(lastMsg).toContain("Answer C");
  });
});

// ─── Abort strategy ───────────────────────────────────────────────────────────

describe("handleFallback — abort", () => {
  it("throws VotingThresholdNotMetError with threshold and bestAgreement", async () => {
    const gateway = makeMockGateway();
    const config: VotingFallbackConfig = { strategy: "abort" };

    await expect(
      handleFallback(config, BASE_INPUT, gateway),
    ).rejects.toThrow(VotingThresholdNotMetError);
  });

  it("does NOT call gateway.complete", async () => {
    const gateway = makeMockGateway();
    const config: VotingFallbackConfig = { strategy: "abort" };

    try {
      await handleFallback(config, BASE_INPUT, gateway);
    } catch {
      // expected
    }

    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it("error message includes threshold and agreement values", async () => {
    const gateway = makeMockGateway();
    const config: VotingFallbackConfig = { strategy: "abort" };

    let caught: Error | undefined;
    try {
      await handleFallback(config, { ...BASE_INPUT, threshold: 0.75, bestAgreement: 0.30 }, gateway);
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeInstanceOf(VotingThresholdNotMetError);
    expect(caught?.message).toContain("0.750");
    expect(caught?.message).toContain("0.300");
  });

  it("VotingThresholdNotMetError has correct name", async () => {
    const err = new VotingThresholdNotMetError(0.7, 0.4);
    expect(err.name).toBe("VotingThresholdNotMetError");
    expect(err.threshold).toBe(0.7);
    expect(err.bestAgreement).toBe(0.4);
  });
});

// ─── Partial strategy ─────────────────────────────────────────────────────────

describe("handleFallback — partial", () => {
  it("returns the best candidate content without calling gateway", async () => {
    const gateway = makeMockGateway();
    const config: VotingFallbackConfig = { strategy: "partial" };

    const result = await handleFallback(config, BASE_INPUT, gateway);

    expect(result.content).toBe("Answer B"); // bestCandidateIndex=1
    expect(result.outcome).toBe("partial");
    expect(result.tokensUsed).toBe(0);
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it("returns empty string when bestCandidateIndex out of bounds", async () => {
    const gateway = makeMockGateway();
    const config: VotingFallbackConfig = { strategy: "partial" };

    const result = await handleFallback(
      config,
      { ...BASE_INPUT, candidates: [], bestCandidateIndex: 0 },
      gateway,
    );

    expect(result.content).toBe("");
    expect(result.outcome).toBe("partial");
  });
});
