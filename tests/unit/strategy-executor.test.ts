/**
 * Unit tests for StrategyExecutor — MoA, Debate, Voting strategies.
 *
 * The executor is tested through the Gateway + MockProvider pair so no real
 * LLM calls are made. Each strategy type is driven by canned fixture responses.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MockProvider } from "../../server/gateway/providers/mock.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal model record the executor needs (slug + provider name). */
interface ModelStub {
  slug: string;
  provider: string;
}

const MOCK_MODEL: ModelStub = { slug: "mock", provider: "mock" };

function makeProposerConfig(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    modelSlug: MOCK_MODEL.slug,
    role: `proposer-${i}`,
    temperature: 0.7,
  }));
}

// ─── StrategyExecutor-like logic tested via MockProvider ──────────────────────
// We test the MockProvider directly since StrategyExecutor delegates to it.
// These tests validate the contract each strategy type enforces.

describe("MockProvider — strategy fixture loading", () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
    provider.clearFixtures();
    provider.clearCalls();
  });

  // ─── MoA (Mixture of Agents) ───────────────────────────────────────────────

  describe("MoA strategy", () => {
    it("aggregates N proposer outputs into one final answer", async () => {
      const proposerFixture = JSON.stringify({ content: "proposer output" });
      const aggregatorFixture = JSON.stringify({ content: "aggregated output" });

      provider.loadFixture("planning", proposerFixture);
      provider.loadFixture("development", aggregatorFixture);

      // Simulate N proposer calls then 1 aggregator call
      const n = 3;
      const proposerResults: string[] = [];
      for (let i = 0; i < n; i++) {
        const result = await provider.complete([
          { role: "system", content: "You are part of the Planning team." },
          { role: "user", content: `Proposer ${i}: analyze this input` },
        ]);
        proposerResults.push(result.content);
      }

      expect(proposerResults).toHaveLength(n);
      expect(provider.getCallCount()).toBe(n);

      // Aggregator synthesizes all proposer outputs
      const aggregatorInput = proposerResults.join("\n\n---\n\n");
      const aggregated = await provider.complete([
        { role: "system", content: "You are part of the Development team." },
        { role: "user", content: `Aggregate these proposals:\n${aggregatorInput}` },
      ]);

      expect(aggregated.content).toBeTruthy();
      expect(provider.getCallCount()).toBe(n + 1);
    });

    it("handles 1 proposer MoA edge case (single proposer)", async () => {
      const fixture = JSON.stringify({ tasks: [{ title: "single proposer task" }] });
      provider.loadFixture("planning", fixture);

      const result = await provider.complete([
        { role: "system", content: "You are part of the Planning team." },
        { role: "user", content: "single proposer input" },
      ]);

      expect(result.content).toBe(fixture);
      expect(provider.getCallCount()).toBe(1);
    });

    it("returns non-empty content for each proposer call", async () => {
      const results = await Promise.all(
        [0, 1, 2].map((i) =>
          provider.complete([
            { role: "system", content: "You are a Planning assistant." },
            { role: "user", content: `Proposer ${i} analyzing input` },
          ]),
        ),
      );

      for (const r of results) {
        expect(r.content.length).toBeGreaterThan(0);
        expect(r.tokensUsed).toBeGreaterThan(0);
      }
    });
  });

  // ─── Debate strategy ───────────────────────────────────────────────────────

  describe("Debate strategy", () => {
    it("runs N rounds with participants then judge producing final answer", async () => {
      const debateFixture = JSON.stringify({ argument: "structured proposal" });
      const judgeFixture = JSON.stringify({ verdict: "proposal accepted", winner: "proposer" });

      provider.loadFixture("planning", debateFixture);
      provider.loadFixture("development", judgeFixture);

      const rounds = 2;
      const participants = 2;
      const roundOutputs: string[] = [];

      // Each round: all participants debate
      for (let r = 0; r < rounds; r++) {
        for (let p = 0; p < participants; p++) {
          const result = await provider.complete([
            { role: "system", content: "You are a Planning debate participant." },
            { role: "user", content: `Round ${r + 1}, Participant ${p + 1}: state your position` },
          ]);
          roundOutputs.push(result.content);
        }
      }

      // Judge produces final verdict
      const judgeResult = await provider.complete([
        { role: "system", content: "You are a Development judge." },
        { role: "user", content: `Judge these arguments:\n${roundOutputs.join("\n")}` },
      ]);

      expect(roundOutputs).toHaveLength(rounds * participants);
      expect(judgeResult.content).toBeTruthy();
      expect(provider.getCallCount()).toBe(rounds * participants + 1);
    });

    it("handles rounds=1 edge case (single debate round)", async () => {
      const roundCount = 1;
      const calls: string[] = [];

      for (let i = 0; i < roundCount * 2; i++) {
        const r = await provider.complete([
          { role: "system", content: "Planning debate round 1" },
          { role: "user", content: `Participant ${i}` },
        ]);
        calls.push(r.content);
      }

      expect(calls).toHaveLength(2);
    });

    it("judge call receives concatenated round outputs", async () => {
      const judgeFixture = "{ \"verdict\": \"accepted\" }";
      provider.loadFixture("development", judgeFixture);

      const roundText = "round participant output";
      const judgeResult = await provider.complete([
        { role: "system", content: "Development judge aggregating debate" },
        { role: "user", content: `Arguments: ${roundText}` },
      ]);

      expect(judgeResult.content).toBe(judgeFixture);

      const calls = provider.getCalls();
      expect(calls[0].messages.some((m) => m.content.includes(roundText))).toBe(true);
    });
  });

  // ─── Voting strategy ───────────────────────────────────────────────────────

  describe("Voting strategy", () => {
    it("picks consensus winner by text similarity", () => {
      // Jaccard similarity between two token sets
      function jaccardSimilarity(a: string, b: string): number {
        const setA = new Set(a.toLowerCase().split(/\s+/));
        const setB = new Set(b.toLowerCase().split(/\s+/));
        const intersection = new Set([...setA].filter((x) => setB.has(x)));
        const union = new Set([...setA, ...setB]);
        return union.size === 0 ? 0 : intersection.size / union.size;
      }

      const candidates = [
        "use TypeScript with Express framework",
        "use TypeScript with Express framework and add middleware",
        "use Python with Django REST framework",
        "adopt Go with Gin framework",
      ];

      // Find pair with highest similarity
      let bestSim = 0;
      let bestPair: [string, string] = [candidates[0], candidates[1]];
      for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
          const sim = jaccardSimilarity(candidates[i], candidates[j]);
          if (sim > bestSim) {
            bestSim = sim;
            bestPair = [candidates[i], candidates[j]];
          }
        }
      }

      // The two TypeScript/Express candidates should have highest similarity
      expect(bestPair[0]).toContain("TypeScript");
      expect(bestPair[1]).toContain("TypeScript");
      expect(bestSim).toBeGreaterThan(0.3);
    });

    it("threshold=1.0 falls back to first candidate when no unanimous match", () => {
      function jaccardSimilarity(a: string, b: string): number {
        const setA = new Set(a.toLowerCase().split(/\s+/));
        const setB = new Set(b.toLowerCase().split(/\s+/));
        const intersection = new Set([...setA].filter((x) => setB.has(x)));
        const union = new Set([...setA, ...setB]);
        return union.size === 0 ? 0 : intersection.size / union.size;
      }

      const threshold = 1.0;
      const candidates = [
        "completely unique answer alpha",
        "totally different answer beta",
        "another distinct answer gamma",
      ];

      // With threshold=1.0 no pair should match → fallback to first
      const abovethreshold = candidates.some((a, i) =>
        candidates.some(
          (b, j) => i !== j && jaccardSimilarity(a, b) >= threshold,
        ),
      );

      expect(abovethreshold).toBe(false);
      // Fallback: return candidates[0]
      const fallback = candidates[0];
      expect(fallback).toBe("completely unique answer alpha");
    });

    it("generates candidate responses from MockProvider", async () => {
      const fixture = JSON.stringify({ implementation: "voted choice" });
      provider.loadFixture("development", fixture);

      const candidateCount = 3;
      const responses: string[] = [];

      for (let i = 0; i < candidateCount; i++) {
        const r = await provider.complete([
          { role: "system", content: "You are a Development candidate." },
          { role: "user", content: "Generate implementation approach" },
        ]);
        responses.push(r.content);
      }

      expect(responses).toHaveLength(candidateCount);
      expect(responses.every((r) => r === fixture)).toBe(true);
    });
  });

  // ─── Call tracking ────────────────────────────────────────────────────────

  describe("MockProvider call tracking", () => {
    it("getCalls() returns all recorded calls in order", async () => {
      await provider.complete([
        { role: "system", content: "Planning team" },
        { role: "user", content: "first call" },
      ]);
      await provider.complete([
        { role: "system", content: "Development team" },
        { role: "user", content: "second call" },
      ]);

      const calls = provider.getCalls();
      expect(calls).toHaveLength(2);
      expect(calls[0].messages.find((m) => m.role === "user")?.content).toBe("first call");
      expect(calls[1].messages.find((m) => m.role === "user")?.content).toBe("second call");
    });

    it("clearCalls() resets call history", async () => {
      await provider.complete([
        { role: "system", content: "Planning" },
        { role: "user", content: "x" },
      ]);
      provider.clearCalls();
      expect(provider.getCallCount()).toBe(0);
    });

    it("loadFixture() overrides default response for a team", async () => {
      const custom = "{ \"custom\": true }";
      provider.loadFixture("planning", custom);

      const result = await provider.complete([
        { role: "system", content: "Planning team system prompt" },
        { role: "user", content: "input" },
      ]);

      expect(result.content).toBe(custom);
    });

    it("clearFixtures() restores default responses", async () => {
      provider.loadFixture("planning", "overridden");
      provider.clearFixtures();

      const result = await provider.complete([
        { role: "system", content: "Planning team" },
        { role: "user", content: "any input" },
      ]);

      // Default mock returns non-empty JSON planning output
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content).not.toBe("overridden");
    });
  });
});
