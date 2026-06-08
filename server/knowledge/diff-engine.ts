/**
 * PURE practice-card diff engine for the weekly refresh loop.
 *
 * Classifies the current active card set (and any candidate cards) into
 * new / changed / stale / superseded buckets plus an unchanged count. This is
 * the testable heart of the refresh routine: NO database, NO side effects, and
 * NO Date.now() inside the core — `now` is injected by the caller.
 *
 * Bucket precedence (a card lands in at most ONE bucket): superseded > stale.
 * Candidate-derived buckets (new / changed) are disjoint by construction.
 */
import type { PracticeCardRow, PracticeCardAppliesTo, PracticeCardSource } from "@shared/schema";

/** A candidate card produced by an off-server research run. */
export interface PracticeCardCandidate {
  topic: string;
  appliesTo: PracticeCardAppliesTo;
  contentHash: string;
  sources: PracticeCardSource[];
}

export interface DiffReport {
  new: PracticeCardCandidate[];
  changed: PracticeCardCandidate[];
  stale: PracticeCardRow[];
  superseded: PracticeCardRow[];
  unchangedCount: number;
}

/** Staleness horizon: a card unverified for this long is flagged for review. */
export const STALE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// ─── Scope matching ──────────────────────────────────────────────────────────

function scopeTokens(appliesTo: PracticeCardAppliesTo): Set<string> {
  const tokens = new Set<string>();
  for (const kind of appliesTo.resourceKinds ?? []) tokens.add(`k:${kind}`);
  for (const tag of appliesTo.tags ?? []) tokens.add(`t:${tag}`);
  return tokens;
}

/** True if two scopes share at least one resourceKind or tag. */
function scopesOverlap(a: PracticeCardAppliesTo, b: PracticeCardAppliesTo): boolean {
  if (a.tool !== b.tool) return false;
  const ta = scopeTokens(a);
  const tb = scopeTokens(b);
  if (ta.size === 0 && tb.size === 0) return true; // both tool-only → same scope
  for (const token of ta) {
    if (tb.has(token)) return true;
  }
  return false;
}

// ─── Version comparison ──────────────────────────────────────────────────────

/** Compare dotted numeric versions; fall back to localeCompare. Returns -1/0/1. */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(".");
  const pb = b.replace(/^v/i, "").split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number(pa[i] ?? "0");
    const nb = Number(pb[i] ?? "0");
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      return Math.sign(a.localeCompare(b));
    }
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
}

/** Highest sourceVersion across a card's sources, or null if none present. */
function maxSourceVersion(sources: PracticeCardSource[]): string | null {
  const versions = sources
    .map((s) => s.sourceVersion)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (versions.length === 0) return null;
  return versions.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best));
}

// ─── Diff ──────────────────────────────────────────────────────────────────────

function isStale(card: PracticeCardRow, now: Date): boolean {
  if (!card.lastVerifiedAt) return true;
  return now.getTime() - new Date(card.lastVerifiedAt).getTime() >= STALE_TTL_MS;
}

/** True if any candidate of the same topic carries a strictly newer version. */
function isSupersededByCandidates(card: PracticeCardRow, candidates: readonly PracticeCardCandidate[]): boolean {
  const cardVersion = maxSourceVersion(card.sources);
  if (cardVersion === null) return false;
  return candidates.some((cand) => {
    if (cand.topic !== card.topic) return false;
    const candVersion = maxSourceVersion(cand.sources);
    if (candVersion === null) return false;
    return compareVersions(candVersion, cardVersion) > 0;
  });
}

/**
 * Classify the active set + candidates. `now` is injected (no clock access here).
 */
export function diffPracticeCards(
  currentActiveCards: readonly PracticeCardRow[],
  candidates: readonly PracticeCardCandidate[],
  now: Date,
): DiffReport {
  const activeHashes = new Set(currentActiveCards.map((c) => c.contentHash));
  const confirmedHashes = new Set(candidates.map((c) => c.contentHash));

  // Candidate-side buckets: new vs changed.
  const newCards: PracticeCardCandidate[] = [];
  const changed: PracticeCardCandidate[] = [];
  for (const cand of candidates) {
    if (activeHashes.has(cand.contentHash)) continue; // re-confirmation, not a delta
    const matchesScope = currentActiveCards.some(
      (active) => active.topic === cand.topic && scopesOverlap(active.appliesTo, cand.appliesTo),
    );
    if (matchesScope) {
      changed.push(cand);
    } else {
      newCards.push(cand);
    }
  }

  // Active-side buckets: superseded takes precedence over stale; both disjoint.
  const stale: PracticeCardRow[] = [];
  const superseded: PracticeCardRow[] = [];
  let unchangedCount = 0;

  for (const card of currentActiveCards) {
    if (isSupersededByCandidates(card, candidates)) {
      superseded.push(card);
      continue;
    }
    const reconfirmed = confirmedHashes.has(card.contentHash);
    if (!reconfirmed && isStale(card, now)) {
      stale.push(card);
      continue;
    }
    unchangedCount++;
  }

  return { new: newCards, changed, stale, superseded, unchangedCount };
}
