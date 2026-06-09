/**
 * Pure helpers for the Morning Brief UI.
 *
 * Framework-free so they can be unit-tested in the repo's node-only vitest setup
 * (tests/unit/*.test.ts) without a DOM renderer — matching the practice-cards.ts
 * / manager-ui.test.ts pattern. Components import these and stay thin.
 *
 * SECURITY: `relevanceScore` and `impactScore` are SYSTEM-DERIVED signals
 * (ranker / blast_radius), not user-authoritative — these helpers only bucket
 * and label them, never treat them as trusted input. `safeHttpsHref` is the
 * single guard for any fetched `sourceUri` used as an anchor href (M2):
 * https-only, else the URL must be rendered as inert plain text.
 */
import type { BlastAffect, NewsItem } from "@/hooks/use-news";
import type { User } from "@shared/types";

// ─── Relevance ──────────────────────────────────────────────────────────────

export type RelevanceBand = "low" | "medium" | "high";

/** Bucket a 0..1 system-derived relevance score for color coding. */
export function relevanceBand(score: number): RelevanceBand {
  if (score >= 0.66) return "high";
  if (score >= 0.33) return "medium";
  return "low";
}

/** Relevance as a clamped 0..100 percentage. */
export function relevancePercent(score: number): number {
  return Math.round(Math.min(1, Math.max(0, score)) * 100);
}

// ─── Impact (blast-radius affects) ────────────────────────────────────────────

export type ImpactBand = "low" | "medium" | "high";

/** Bucket a 0..1 blast-radius impactScore. */
export function impactBand(impactScore: number): ImpactBand {
  if (impactScore >= 0.66) return "high";
  if (impactScore >= 0.33) return "medium";
  return "low";
}

/** Impact as a clamped 0..100 percentage. */
export function impactPercent(impactScore: number): number {
  return Math.round(Math.min(1, Math.max(0, impactScore)) * 100);
}

/** Short, deterministic impact label, e.g. "High impact · 82%". */
export function impactLabel(impactScore: number): string {
  const band = impactBand(impactScore);
  const pct = impactPercent(impactScore);
  const word = band === "high" ? "High" : band === "medium" ? "Medium" : "Low";
  return `${word} impact · ${pct}%`;
}

/** Confidence as a clamped 0..100 percentage (blast-radius confidence). */
export function confidencePercent(confidence: number): number {
  return Math.round(Math.min(1, Math.max(0, confidence)) * 100);
}

// ─── Freshness ──────────────────────────────────────────────────────────────

export type Freshness = "fresh" | "recent" | "stale";

/** Items newer than this many hours are "fresh". */
export const FRESH_WITHIN_HOURS = 24;
/** Items newer than this many hours are at least "recent". */
export const RECENT_WITHIN_HOURS = 72;

const MS_PER_HOUR = 60 * 60 * 1000;

export interface FreshnessInfo {
  freshness: Freshness;
  /** Whole hours since createdAt, or null when unparseable. */
  ageHours: number | null;
}

/** Classify how fresh an item is. `now` is injectable for deterministic tests. */
export function computeFreshness(
  createdAt: Date | string | null | undefined,
  now: Date = new Date(),
): FreshnessInfo {
  if (createdAt == null) return { freshness: "stale", ageHours: null };
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(created.getTime())) {
    return { freshness: "stale", ageHours: null };
  }
  const ageHours = Math.max(
    0,
    Math.floor((now.getTime() - created.getTime()) / MS_PER_HOUR),
  );
  if (ageHours < FRESH_WITHIN_HOURS) return { freshness: "fresh", ageHours };
  if (ageHours < RECENT_WITHIN_HOURS) return { freshness: "recent", ageHours };
  return { freshness: "stale", ageHours };
}

/** Human-friendly relative-age label, e.g. "3h ago" / "2d ago". */
export function freshnessLabel(info: FreshnessInfo): string {
  if (info.ageHours == null) return "Unknown";
  if (info.ageHours < 1) return "Just now";
  if (info.ageHours < FRESH_WITHIN_HOURS) return `${info.ageHours}h ago`;
  const days = Math.floor(info.ageHours / 24);
  return days === 1 ? "1d ago" : `${days}d ago`;
}

// ─── Role / stack gating ──────────────────────────────────────────────────────

/**
 * Whether the current user may trigger POST /news/refresh.
 *
 * The backend gates refresh with `requireOwnerOrRole(ownerId, "maintainer",
 * "admin")` — workspace owner OR maintainer OR admin. Mirrored here for UI
 * affordances only; the server remains the source of truth.
 */
export function canRefresh(
  user: Pick<User, "id" | "role"> | null | undefined,
  workspaceOwnerId: string | null | undefined,
): boolean {
  if (!user) return false;
  if (user.role === "admin" || user.role === "maintainer") return true;
  return !!workspaceOwnerId && user.id === workspaceOwnerId;
}

/**
 * Whether the current user may edit their own news profile.
 *
 * GET/PUT /news/profile are self-scoped (`requireAuth`, user_id = req.user.id),
 * so any authenticated member of the workspace may edit their own profile.
 */
export function canEditProfile(
  user: Pick<User, "id" | "role"> | null | undefined,
): boolean {
  return !!user;
}

// ─── Affects aggregation ──────────────────────────────────────────────────────

/** A flattened affect annotated with the item it came from. */
export interface AggregatedAffect extends BlastAffect {
  itemId: string;
  itemTitle: string;
}

/**
 * Flatten every item's `affects[]` into a single list sorted by impactScore
 * DESC (the "affects YOUR platform" headline order). Stable id tiebreak keeps
 * the order deterministic under test.
 */
export function aggregateAffects(items: NewsItem[]): AggregatedAffect[] {
  const flat: AggregatedAffect[] = [];
  for (const item of items) {
    for (const affect of item.affects) {
      flat.push({ ...affect, itemId: item.id, itemTitle: item.title });
    }
  }
  return flat.sort((a, b) => {
    if (b.impactScore !== a.impactScore) return b.impactScore - a.impactScore;
    return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
  });
}

// ─── Feed selection / ordering ────────────────────────────────────────────────

/**
 * Items in one category, relevance-ordered (DESC). Hidden items are dropped;
 * stable id tiebreak for determinism.
 */
export function feedItems(
  items: NewsItem[],
  category: NewsItem["category"],
): NewsItem[] {
  return items
    .filter((i) => i.category === category && i.feedback !== "hidden")
    .sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) {
        return b.relevanceScore - a.relevanceScore;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

// ─── URL safety (Security M2) ─────────────────────────────────────────────────

/**
 * Guard a fetched `sourceUri` for use as an anchor href: returns the URL ONLY
 * when it parses as an absolute `https:` URL, else `null` (caller must then
 * render the URI as inert plain text and NOT link it). Never auto-followed.
 */
export function safeHttpsHref(uri: string | null | undefined): string | null {
  if (!uri) return null;
  try {
    const u = new URL(uri);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// ─── Display metadata ──────────────────────────────────────────────────────────

export const ROLE_LABELS: Record<string, string> = {
  devops: "DevOps",
  sre: "SRE",
  platform: "Platform",
};

export const CATEGORY_LABELS: Record<NewsItem["category"], string> = {
  internal: "Internal",
  external: "External",
};
