// server/pipeline/voting/confidence-scorer.ts
// Extracts and aggregates candidate confidence scores for the Voting strategy.
//
// Confidence may come from:
//  1. Provider-returned confidence (e.g. logprobs → mean token confidence)
//  2. Structured JSON `confidence` field in candidate output
//  3. Self-eval fallback: compute heuristic from text length / certainty words

import type { CandidateConfidenceScore } from "@shared/types";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Phrases that suggest the model is uncertain — reduce heuristic confidence. */
const UNCERTAINTY_PHRASES: RegExp[] = [
  /\b(not sure|unclear|uncertain|might|may|possibly|perhaps|i think|i believe|could be)\b/gi,
  /\b(it depends|hard to say|difficult to determine)\b/gi,
];

/** Phrases that suggest the model is confident — boost heuristic confidence. */
const CONFIDENCE_PHRASES: RegExp[] = [
  /\b(definitely|certainly|clearly|obviously|always|never|must|will|is|are)\b/gi,
  /\b(the answer is|the result is|conclusion:)\b/gi,
];

const MIN_TEXT_LENGTH_FOR_HEURISTIC = 20;

// ─── Extractors ───────────────────────────────────────────────────────────────

/**
 * Attempt to extract a confidence score from a candidate's response text.
 *
 * Priority:
 *  1. JSON field `confidence` (float 0–1) in the root of parsed output
 *  2. Heuristic computed from text characteristics
 *
 * Returns a `CandidateConfidenceScore` with the source noted.
 */
export function extractConfidence(
  modelSlug: string,
  content: string,
  providerLogprob?: number,
): CandidateConfidenceScore {
  // 1. Provider logprob (pre-computed mean token log-probability → probability)
  if (providerLogprob !== undefined) {
    return {
      modelSlug,
      score: clamp(providerLogprob, 0, 1),
      source: "provider",
    };
  }

  // 2. JSON-embedded confidence field
  const jsonConfidence = extractJsonConfidence(content);
  if (jsonConfidence !== null) {
    return {
      modelSlug,
      score: clamp(jsonConfidence, 0, 1),
      source: "self_eval",
    };
  }

  // 3. Heuristic
  return {
    modelSlug,
    score: computeHeuristicConfidence(content),
    source: "heuristic",
  };
}

/**
 * Aggregate multiple candidate confidence scores into a single value.
 * Strategy: arithmetic mean.  Returns 0.5 if no scores provided.
 */
export function aggregateConfidence(scores: CandidateConfidenceScore[]): number {
  if (scores.length === 0) return 0.5;
  const total = scores.reduce((sum, s) => sum + s.score, 0);
  return total / scores.length;
}

/**
 * Build confidence scores for all candidates in a voting run.
 */
export function scoreAllCandidates(
  candidates: Array<{ modelSlug: string; content: string; providerLogprob?: number }>,
): CandidateConfidenceScore[] {
  return candidates.map((c) =>
    extractConfidence(c.modelSlug, c.content, c.providerLogprob),
  );
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function extractJsonConfidence(content: string): number | null {
  // Try stripping markdown code fences
  const stripped = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "confidence" in parsed
    ) {
      const val = (parsed as Record<string, unknown>).confidence;
      if (typeof val === "number" && val >= 0 && val <= 1) {
        return val;
      }
    }
  } catch {
    // Not JSON — continue to heuristic
  }
  return null;
}

function computeHeuristicConfidence(text: string): number {
  if (text.trim().length < MIN_TEXT_LENGTH_FOR_HEURISTIC) {
    // Very short responses are low-confidence
    return 0.3;
  }

  let score = 0.5; // baseline

  for (const pattern of UNCERTAINTY_PHRASES) {
    const matches = text.match(pattern);
    if (matches) {
      score -= 0.05 * Math.min(matches.length, 3);
    }
  }

  for (const pattern of CONFIDENCE_PHRASES) {
    const matches = text.match(pattern);
    if (matches) {
      score += 0.04 * Math.min(matches.length, 3);
    }
  }

  return clamp(score, 0.1, 0.9);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
