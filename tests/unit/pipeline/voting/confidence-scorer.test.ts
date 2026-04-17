import { describe, it, expect } from "vitest";
import {
  extractConfidence,
  aggregateConfidence,
  scoreAllCandidates,
} from "../../../../server/pipeline/voting/confidence-scorer.js";
import type { CandidateConfidenceScore } from "@shared/types";

// ─── extractConfidence ────────────────────────────────────────────────────────

describe("extractConfidence — provider logprob", () => {
  it("uses provider logprob when supplied, source=provider", () => {
    const result = extractConfidence("model-a", "some output", 0.92);
    expect(result.score).toBeCloseTo(0.92, 5);
    expect(result.source).toBe("provider");
    expect(result.modelSlug).toBe("model-a");
  });

  it("clamps provider logprob to [0,1]", () => {
    expect(extractConfidence("m", "text", 1.5).score).toBe(1.0);
    expect(extractConfidence("m", "text", -0.1).score).toBe(0.0);
  });
});

describe("extractConfidence — JSON self_eval", () => {
  it("parses confidence from root JSON field", () => {
    const content = JSON.stringify({ result: "yes", confidence: 0.88 });
    const result = extractConfidence("model-b", content);
    expect(result.score).toBeCloseTo(0.88, 5);
    expect(result.source).toBe("self_eval");
  });

  it("parses confidence from JSON wrapped in markdown code fence", () => {
    const content = "```json\n" + JSON.stringify({ confidence: 0.75 }) + "\n```";
    const result = extractConfidence("model-b", content);
    expect(result.score).toBeCloseTo(0.75, 5);
    expect(result.source).toBe("self_eval");
  });

  it("ignores JSON confidence outside [0,1] and falls through to heuristic", () => {
    // Value outside valid range — extractJsonConfidence rejects it, falls through to heuristic
    const content = JSON.stringify({ confidence: 1.5 });
    const result = extractConfidence("model-b", content);
    expect(result.source).toBe("heuristic");
    // Short JSON content → heuristic assigns 0.3
    expect(result.score).toBe(0.3);
  });

  it("falls through to heuristic when no confidence field in JSON", () => {
    const content = JSON.stringify({ result: "yes", note: "no confidence field" });
    const result = extractConfidence("model-b", content);
    expect(result.source).toBe("heuristic");
  });
});

describe("extractConfidence — heuristic", () => {
  it("assigns 0.3 for very short text", () => {
    const result = extractConfidence("model-c", "yes");
    expect(result.score).toBe(0.3);
    expect(result.source).toBe("heuristic");
  });

  it("assigns ~0.5 baseline for neutral text without uncertainty/confidence phrases", () => {
    const neutralText = "The algorithm processes each item in sequence and returns the results.";
    const result = extractConfidence("model-c", neutralText);
    expect(result.source).toBe("heuristic");
    expect(result.score).toBeGreaterThanOrEqual(0.1);
    expect(result.score).toBeLessThanOrEqual(0.9);
  });

  it("reduces score for text with multiple uncertainty phrases", () => {
    const uncertainText =
      "I'm not sure about this. It might be correct, but I think it depends. " +
      "Perhaps the value is different. I believe this could be a possibility.";
    const result = extractConfidence("model-c", uncertainText);
    expect(result.source).toBe("heuristic");
    expect(result.score).toBeLessThan(0.5);
  });

  it("increases score for text with confidence phrases", () => {
    const confidentText =
      "The answer is definitely correct. The result is clearly 42. This is obviously the solution.";
    const result = extractConfidence("model-c", confidentText);
    expect(result.source).toBe("heuristic");
    expect(result.score).toBeGreaterThan(0.5);
  });

  it("score is always in [0.1, 0.9] from heuristic", () => {
    const texts = [
      "a".repeat(100),
      "The answer is definitely correct and obviously must be this way.",
      "I'm not sure, might be wrong, perhaps, possibly, unclear.",
    ];
    for (const text of texts) {
      const result = extractConfidence("m", text);
      if (result.source === "heuristic") {
        expect(result.score).toBeGreaterThanOrEqual(0.1);
        expect(result.score).toBeLessThanOrEqual(0.9);
      }
    }
  });
});

// ─── aggregateConfidence ──────────────────────────────────────────────────────

describe("aggregateConfidence", () => {
  it("returns 0.5 for empty array", () => {
    expect(aggregateConfidence([])).toBe(0.5);
  });

  it("returns single score when only one candidate", () => {
    const scores: CandidateConfidenceScore[] = [
      { modelSlug: "a", score: 0.8, source: "provider" },
    ];
    expect(aggregateConfidence(scores)).toBeCloseTo(0.8, 5);
  });

  it("computes arithmetic mean across multiple candidates", () => {
    const scores: CandidateConfidenceScore[] = [
      { modelSlug: "a", score: 0.6, source: "heuristic" },
      { modelSlug: "b", score: 0.8, source: "heuristic" },
      { modelSlug: "c", score: 1.0, source: "provider" },
    ];
    // Mean = (0.6+0.8+1.0)/3 = 0.8
    expect(aggregateConfidence(scores)).toBeCloseTo(0.8, 5);
  });

  it("all zeros → mean of 0", () => {
    const scores: CandidateConfidenceScore[] = [
      { modelSlug: "a", score: 0, source: "heuristic" },
      { modelSlug: "b", score: 0, source: "heuristic" },
    ];
    expect(aggregateConfidence(scores)).toBe(0);
  });
});

// ─── scoreAllCandidates ───────────────────────────────────────────────────────

describe("scoreAllCandidates", () => {
  it("returns one score per candidate", () => {
    const candidates = [
      { modelSlug: "a", content: JSON.stringify({ confidence: 0.9 }) },
      { modelSlug: "b", content: "I'm not sure about this, maybe." },
      { modelSlug: "c", content: "The answer is clearly yes.", providerLogprob: 0.95 },
    ];
    const scores = scoreAllCandidates(candidates);
    expect(scores).toHaveLength(3);
    expect(scores[0].source).toBe("self_eval");
    expect(scores[2].source).toBe("provider");
    expect(scores[2].score).toBeCloseTo(0.95, 5);
  });

  it("returns empty array for empty input", () => {
    expect(scoreAllCandidates([])).toEqual([]);
  });
});
