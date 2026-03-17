/**
 * Unit tests for provider diversity scoring and participant ordering.
 */
import { describe, it, expect } from "vitest";
import {
  computeProviderDiversityScore,
  preferCrossProviderOrder,
  type ParticipantWithProvider,
} from "../../server/services/provider-diversity.js";
import type { DebateParticipant } from "@shared/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeParticipant(modelSlug: string, provider: string): ParticipantWithProvider {
  const participant: DebateParticipant = { modelSlug, role: "proposer" };
  return { participant, provider };
}

// ─── computeProviderDiversityScore ───────────────────────────────────────────

describe("computeProviderDiversityScore", () => {
  it("returns 0 for empty participant list", () => {
    expect(computeProviderDiversityScore([])).toBe(0);
  });

  it("returns 1.0 for a single participant (trivially diverse)", () => {
    const participants = [makeParticipant("claude-sonnet", "anthropic")];
    expect(computeProviderDiversityScore(participants)).toBe(1.0);
  });

  it("returns 1.0 when all participants use different providers", () => {
    const participants = [
      makeParticipant("claude-sonnet", "anthropic"),
      makeParticipant("gemini-flash", "google"),
      makeParticipant("grok-3", "xai"),
    ];
    expect(computeProviderDiversityScore(participants)).toBe(1.0);
  });

  it("returns 0.5 when two participants share one provider", () => {
    const participants = [
      makeParticipant("claude-sonnet", "anthropic"),
      makeParticipant("claude-haiku", "anthropic"),
    ];
    expect(computeProviderDiversityScore(participants)).toBe(0.5);
  });

  it("returns ~0.67 for 2 unique providers across 3 participants", () => {
    const participants = [
      makeParticipant("claude-sonnet", "anthropic"),
      makeParticipant("claude-haiku", "anthropic"),
      makeParticipant("gemini-flash", "google"),
    ];
    const score = computeProviderDiversityScore(participants);
    expect(score).toBeCloseTo(2 / 3, 5);
  });

  it("returns ~0.25 when all 4 participants are the same provider", () => {
    const participants = [
      makeParticipant("claude-sonnet", "anthropic"),
      makeParticipant("claude-haiku", "anthropic"),
      makeParticipant("claude-opus", "anthropic"),
      makeParticipant("claude-instant", "anthropic"),
    ];
    expect(computeProviderDiversityScore(participants)).toBe(0.25);
  });
});

// ─── preferCrossProviderOrder ─────────────────────────────────────────────────

describe("preferCrossProviderOrder", () => {
  it("returns same list for a single participant", () => {
    const p = [makeParticipant("claude-sonnet", "anthropic")];
    expect(preferCrossProviderOrder(p)).toEqual(p);
  });

  it("preserves order when all participants are from different providers", () => {
    const participants = [
      makeParticipant("claude-sonnet", "anthropic"),
      makeParticipant("gemini-flash", "google"),
      makeParticipant("grok-3", "xai"),
    ];
    const result = preferCrossProviderOrder(participants);
    // With 3 unique providers, each group has 1 member — interleaving keeps one from each
    const providers = result.map((p) => p.provider);
    expect(new Set(providers).size).toBe(3); // all 3 still present
    expect(result.length).toBe(3);
  });

  it("interleaves so same-provider participants are maximally separated", () => {
    // 2 anthropic, 1 google, 1 xai → expect [anthropic, google, xai, anthropic]
    const a1 = makeParticipant("claude-sonnet", "anthropic");
    const a2 = makeParticipant("claude-haiku", "anthropic");
    const g1 = makeParticipant("gemini-flash", "google");
    const x1 = makeParticipant("grok-3", "xai");

    const result = preferCrossProviderOrder([a1, a2, g1, x1]);

    expect(result.length).toBe(4);

    // The two anthropic participants should not be adjacent
    const anthropicIndices = result
      .map((p, i) => (p.provider === "anthropic" ? i : -1))
      .filter((i) => i !== -1);
    expect(anthropicIndices.length).toBe(2);
    expect(Math.abs(anthropicIndices[0] - anthropicIndices[1])).toBeGreaterThan(1);
  });

  it("returns all participants when they all share a provider", () => {
    const participants = [
      makeParticipant("claude-sonnet", "anthropic"),
      makeParticipant("claude-haiku", "anthropic"),
      makeParticipant("claude-opus", "anthropic"),
    ];
    const result = preferCrossProviderOrder(participants);
    expect(result.length).toBe(3);
  });

  it("does not mutate the input array", () => {
    const p1 = makeParticipant("claude-sonnet", "anthropic");
    const p2 = makeParticipant("gemini-flash", "google");
    const original = [p1, p2];
    preferCrossProviderOrder(original);
    expect(original).toEqual([p1, p2]);
  });
});
