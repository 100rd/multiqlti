/**
 * Unit tests for arbitrator verdict building, parsing, and model enforcement.
 */
import { describe, it, expect } from "vitest";
import {
  validateArbitratorConfig,
  buildArbitratorPrompt,
  parseArbitratorVerdict,
} from "../../server/services/strategy-executor.js";
import type { DebateDetails, ArbitratorCriterion } from "@shared/types";

// ─── validateArbitratorConfig ─────────────────────────────────────────────────

describe("validateArbitratorConfig", () => {
  it("passes when arbitrator differs from judge and all participants", () => {
    expect(() =>
      validateArbitratorConfig("grok-3", "claude-sonnet", ["gemini-flash"]),
    ).not.toThrow();
  });

  it("throws when arbitrator === judge", () => {
    expect(() =>
      validateArbitratorConfig("claude-sonnet", "claude-sonnet", ["gemini-flash"]),
    ).toThrow(/Arbitrator model.*must differ from the judge/i);
  });

  it("throws when arbitrator matches a participant", () => {
    expect(() =>
      validateArbitratorConfig("gemini-flash", "claude-sonnet", ["gemini-flash", "grok-3"]),
    ).toThrow(/Arbitrator model.*must differ from all debate participants/i);
  });

  it("throws when arbitrator matches judge and also a participant", () => {
    expect(() =>
      validateArbitratorConfig("claude-sonnet", "claude-sonnet", ["claude-sonnet"]),
    ).toThrow();
  });
});

// ─── buildArbitratorPrompt ────────────────────────────────────────────────────

describe("buildArbitratorPrompt", () => {
  const rounds: DebateDetails["rounds"] = [
    { round: 1, participant: "model-a", role: "proposer", content: "I propose X" },
    { round: 1, participant: "model-b", role: "critic", content: "I criticize X" },
  ];
  const participantSlugs = ["model-a", "model-b"];
  const criteria: ArbitratorCriterion[] = ["correctness", "completeness"];

  it("includes all participants in the prompt", () => {
    const prompt = buildArbitratorPrompt(rounds, participantSlugs, criteria);
    expect(prompt).toContain("model-a");
    expect(prompt).toContain("model-b");
  });

  it("includes all criteria in the prompt", () => {
    const prompt = buildArbitratorPrompt(rounds, participantSlugs, criteria);
    expect(prompt).toContain("correctness");
    expect(prompt).toContain("completeness");
  });

  it("includes debate transcript content", () => {
    const prompt = buildArbitratorPrompt(rounds, participantSlugs, criteria);
    expect(prompt).toContain("I propose X");
    expect(prompt).toContain("I criticize X");
  });

  it("requests JSON-only response (no markdown)", () => {
    const prompt = buildArbitratorPrompt(rounds, participantSlugs, criteria);
    expect(prompt).toContain("ONLY with valid JSON");
  });

  it("includes all four default criteria when using security + performance", () => {
    const allCriteria: ArbitratorCriterion[] = ["correctness", "completeness", "security", "performance"];
    const prompt = buildArbitratorPrompt(rounds, participantSlugs, allCriteria);
    expect(prompt).toContain("security");
    expect(prompt).toContain("performance");
  });
});

// ─── parseArbitratorVerdict ───────────────────────────────────────────────────

describe("parseArbitratorVerdict", () => {
  const participantSlugs = ["model-a", "model-b"];
  const arbitratorSlug = "model-c";

  it("parses a well-formed JSON response", () => {
    const raw = JSON.stringify({
      criterionScores: [
        {
          criterion: "correctness",
          scores: { "model-a": 8, "model-b": 6 },
          reasoning: "model-a was more accurate",
        },
      ],
      winner: "model-a",
      confidence: 0.85,
      reasoning: "model-a dominated on correctness",
    });

    const verdict = parseArbitratorVerdict(raw, arbitratorSlug, participantSlugs);

    expect(verdict.arbitratorModelSlug).toBe(arbitratorSlug);
    expect(verdict.winner).toBe("model-a");
    expect(verdict.confidence).toBe(0.85);
    expect(verdict.criterionScores).toHaveLength(1);
    expect(verdict.criterionScores[0].criterion).toBe("correctness");
    expect(verdict.criterionScores[0].scores["model-a"]).toBe(8);
    expect(verdict.participantSlugs).toEqual(participantSlugs);
  });

  it("strips markdown code fences before parsing", () => {
    const raw = "```json\n" + JSON.stringify({
      criterionScores: [],
      winner: "model-a",
      confidence: 0.9,
      reasoning: "winner",
    }) + "\n```";

    const verdict = parseArbitratorVerdict(raw, arbitratorSlug, participantSlugs);
    expect(verdict.winner).toBe("model-a");
    expect(verdict.confidence).toBe(0.9);
  });

  it("returns fallback verdict on invalid JSON", () => {
    const verdict = parseArbitratorVerdict("not json at all {{{", arbitratorSlug, participantSlugs);
    expect(verdict.confidence).toBe(0);
    expect(verdict.reasoning).toMatch(/Failed to parse/i);
    expect(verdict.arbitratorModelSlug).toBe(arbitratorSlug);
    expect(verdict.participantSlugs).toEqual(participantSlugs);
  });

  it("returns fallback verdict when required fields are missing", () => {
    const raw = JSON.stringify({ winner: "model-a" }); // missing criterionScores, confidence, reasoning
    const verdict = parseArbitratorVerdict(raw, arbitratorSlug, participantSlugs);
    expect(verdict.confidence).toBe(0);
    expect(verdict.reasoning).toMatch(/Invalid JSON structure/i);
  });

  it("clamps confidence to [0, 1] range", () => {
    const raw = JSON.stringify({
      criterionScores: [],
      winner: "model-a",
      confidence: 1.5, // out of range
      reasoning: "test",
    });
    const verdict = parseArbitratorVerdict(raw, arbitratorSlug, participantSlugs);
    expect(verdict.confidence).toBe(1);
  });

  it("stores all provided participantSlugs in the verdict", () => {
    const raw = JSON.stringify({
      criterionScores: [],
      winner: "model-a",
      confidence: 0.7,
      reasoning: "ok",
    });
    const verdict = parseArbitratorVerdict(raw, arbitratorSlug, participantSlugs);
    expect(verdict.participantSlugs).toEqual(participantSlugs);
  });
});
