/**
 * Provider Diversity Scoring and Participant Ordering
 *
 * Maximises cross-provider debates by interleaving participants from different
 * providers. This ensures that when multiple participants share a provider they
 * are spread as far apart as possible in the round order, rather than running
 * back-to-back (which would produce homogeneous reasoning chains).
 */

import type { DebateParticipant } from "@shared/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParticipantWithProvider {
  participant: DebateParticipant;
  provider: string;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Compute a provider diversity score between 0 and 1.
 *
 * score = (number of unique providers) / (total participants)
 *
 * Examples:
 *   [anthropic, google, xai]   → 3/3 = 1.0  (perfect diversity)
 *   [anthropic, google]        → 2/2 = 1.0
 *   [anthropic, anthropic]     → 1/2 = 0.5
 *   [anthropic]                → 1/1 = 1.0  (single participant, trivially diverse)
 *   []                         → 0.0
 */
export function computeProviderDiversityScore(
  participants: ParticipantWithProvider[],
): number {
  if (participants.length === 0) return 0;
  const uniqueProviders = new Set(participants.map((p) => p.provider));
  return uniqueProviders.size / participants.length;
}

// ─── Ordering ─────────────────────────────────────────────────────────────────

/**
 * Reorder participants to maximise provider diversity across debate rounds.
 *
 * Algorithm: round-robin interleave by provider group.
 *
 * 1. Group participants by provider.
 * 2. Sort groups descending by size (largest first).
 * 3. Pop one from each group in order until all are placed.
 *
 * Example (4 participants: 2 anthropic, 1 google, 1 xai):
 *   Groups: anthropic=[A1,A2], google=[G1], xai=[X1]
 *   Round 1: A1, G1, X1
 *   Round 2: A2
 *   Result: [A1, G1, X1, A2]  — A1 and A2 are maximally separated
 *
 * If all participants share the same provider the original order is preserved
 * and the diversity score will be 1/N.
 */
export function preferCrossProviderOrder(
  participants: ParticipantWithProvider[],
): ParticipantWithProvider[] {
  if (participants.length <= 1) return [...participants];

  // Build provider → participants map
  const groups = new Map<string, ParticipantWithProvider[]>();
  for (const p of participants) {
    const list = groups.get(p.provider) ?? [];
    list.push(p);
    groups.set(p.provider, list);
  }

  // Sort groups: largest first for maximum spread
  const sortedGroups = [...groups.values()].sort((a, b) => b.length - a.length);

  // Round-robin interleave
  const result: ParticipantWithProvider[] = [];
  const indices = new Array<number>(sortedGroups.length).fill(0);

  let placed = 0;
  while (placed < participants.length) {
    for (let g = 0; g < sortedGroups.length; g++) {
      const idx = indices[g];
      if (idx < sortedGroups[g].length) {
        result.push(sortedGroups[g][idx]);
        indices[g]++;
        placed++;
      }
    }
  }

  return result;
}
