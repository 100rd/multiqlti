/**
 * Pure relevance ranker for the Morning News Board (no IO, deterministic).
 *
 * score = clamp01( W_PROFILE * profileMatch
 *                 + W_AFFECTS * affectsBoost
 *                 + feedbackEffect )
 *
 * Force-drop (score 0): the item's category is muted, OR feedback === "hidden".
 * Output is sorted DESC by score with a deterministic id tiebreak so equal
 * scores order stably. Never throws on injection strings / empty / null-ish
 * inputs — every field is defensively coerced.
 */
import type { BlastAffect, NewsCategory, NewsFeedback, NewsProfileRow, NewsReadState } from "@shared/schema";

// ─── Public item shape ────────────────────────────────────────────────────────

export interface RankableItem {
  id: string;
  category: NewsCategory;
  title: string;
  summary: string;
  sourceName?: string;
  affects: BlastAffect[];
  readState: NewsReadState;
  feedback: NewsFeedback;
  relevanceScore?: number;
}

/** Prior per-item feedback history (reserved for Wave 2 EMA; accepted now). */
export interface FeedbackHistoryEntry {
  sourceName?: string;
  category?: NewsCategory;
  feedback: NewsFeedback;
}

// ─── Tunable weights (named constants — no inline magic numbers) ──────────────

const W_PROFILE = 0.5;
const W_AFFECTS = 0.5;
const FEEDBACK_UP_BOOST = 0.3;
const FEEDBACK_DOWN_PENALTY = 0.3;
const READ_DEMOTE = 0.15;
const PROFILE_HIT_WEIGHT = 0.25;

// ─── Role synonym keywords (lowercased) ──────────────────────────────────────

const ROLE_KEYWORDS: Record<string, readonly string[]> = {
  devops: ["devops", "ci", "cd", "pipeline", "automation"],
  sre: ["sre", "reliability", "on-call", "oncall", "incident", "slo"],
  platform: ["platform", "infrastructure", "infra", "cluster"],
};

// ─── Entry point ──────────────────────────────────────────────────────────────

export function rankItems(
  items: readonly RankableItem[],
  profile: NewsProfileRow,
  _feedbackHistory: readonly FeedbackHistoryEntry[] = [],
): RankableItem[] {
  const muted = new Set(asStringArray(profile.mutedCategories));
  const keywords = profileKeywords(profile);

  const scored = items.map((item) => ({
    ...item,
    relevanceScore: scoreItem(item, keywords, muted),
  }));

  return scored.sort(byScoreDescThenId);
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scoreItem(
  item: RankableItem,
  keywords: readonly string[],
  muted: ReadonlySet<string>,
): number {
  if (item.feedback === "hidden" || muted.has(item.category)) {
    return 0;
  }
  const raw =
    W_PROFILE * profileMatch(item, keywords) +
    W_AFFECTS * affectsBoost(item.affects) +
    feedbackEffect(item.feedback, item.readState);
  return clamp01(raw);
}

/** Fraction-ish keyword overlap of title+summary+source against the profile. */
function profileMatch(item: RankableItem, keywords: readonly string[]): number {
  if (keywords.length === 0) return 0;
  const haystack = `${item.title ?? ""} ${item.summary ?? ""} ${item.sourceName ?? ""}`.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (kw.length > 0 && haystack.includes(kw)) hits += 1;
  }
  return Math.min(1, hits * PROFILE_HIT_WEIGHT);
}

/** Max impact_score across the item's affects[] (the "affects YOU" signal). */
function affectsBoost(affects: BlastAffect[] | undefined): number {
  if (!Array.isArray(affects) || affects.length === 0) return 0;
  let max = 0;
  for (const a of affects) {
    const s = typeof a?.impactScore === "number" ? a.impactScore : 0;
    if (s > max) max = s;
  }
  return clamp01(max);
}

function feedbackEffect(feedback: NewsFeedback, readState: NewsReadState): number {
  let effect = 0;
  if (feedback === "up") effect += FEEDBACK_UP_BOOST;
  if (feedback === "down") effect -= FEEDBACK_DOWN_PENALTY;
  if (readState === "read") effect -= READ_DEMOTE;
  return effect;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function profileKeywords(profile: NewsProfileRow): string[] {
  const stack = asStringArray(profile.stack).map((s) => s.toLowerCase());
  const role = typeof profile.role === "string" ? profile.role : "";
  const roleKw = ROLE_KEYWORDS[role] ?? [];
  return [...stack, ...roleKw];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function byScoreDescThenId(a: RankableItem, b: RankableItem): number {
  const sa = a.relevanceScore ?? 0;
  const sb = b.relevanceScore ?? 0;
  if (sb !== sa) return sb - sa;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
