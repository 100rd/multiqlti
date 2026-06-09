/**
 * React-query hooks for the Morning Brief news board.
 *
 * Mirrors the style of use-practice-cards.ts: typed queries/mutations over the
 * REST surface at /api/workspaces/:id/news, unwrapping the `{ data, meta }`
 * envelope and invalidating the brief query on every mutation.
 *
 * Type strategy:
 *  - Enum + row shapes are shared from the backend (@shared/schema) so the
 *    contract stays in lockstep. `NewsItem` / `Brief` / `NewsProfile` are
 *    UI-facing aliases/interfaces built on those.
 *  - `affects[]` reuses the shared `BlastAffect` shape verbatim (its sole origin
 *    is blast_radius.impacted — Security C2).
 *
 * SECURITY (enforced by every consumer of these types):
 *  Every brief-/Omniscience-/fetch-derived string — title, summary, whyRelevant,
 *  sourceUri, sourceName, provider, and every affects entity name — is UNTRUSTED
 *  content. It is rendered as plain React children / text props ONLY, never via
 *  dangerouslySetInnerHTML or any HTML sink. relevanceScore / impactScore are
 *  system-derived signals, never user-authoritative.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type {
  BlastAffect,
  BriefStatus,
  NewsCategory,
  NewsReadState,
  NewsFeedback,
  NewsProfileRole,
} from "@shared/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export type {
  BlastAffect,
  BriefStatus,
  NewsCategory,
  NewsReadState,
  NewsFeedback,
  NewsProfileRole,
};

/** A single news item in a brief. All string fields are UNTRUSTED / inert-rendered. */
export interface NewsItem {
  id: string;
  category: NewsCategory;
  title: string;
  summary: string;
  sourceUri: string | null;
  sourceName: string | null;
  provider: string | null;
  whyRelevant: string | null;
  /** Sole origin is blast_radius.impacted (Security C2). */
  affects: BlastAffect[];
  /** System-derived signal in [0,1], never user-authoritative. */
  relevanceScore: number;
  readState: NewsReadState;
  feedback: NewsFeedback;
  createdAt: string;
}

/** A brief envelope (the day's board for one user×workspace). */
export interface Brief {
  id: string;
  briefDate: string;
  status: BriefStatus;
  /** true when Omniscience was unavailable/forbidden — internal feed is degraded. */
  internalDegraded: boolean;
  meta: Record<string, unknown>;
}

/** Explicit personalization profile. */
export interface NewsProfile {
  role: NewsProfileRole;
  stack: string[];
  mutedCategories: string[];
}

/** Filters accepted by GET /news/brief. */
export interface BriefFilters {
  date?: string;
  category?: NewsCategory;
  readState?: NewsReadState;
}

/** The brief + its items, as returned by GET /news/brief. */
export interface BriefResult {
  brief: Brief;
  items: NewsItem[];
}

/** A feedback action POSTed to an item. */
export type FeedbackAction = "read" | "up" | "down" | "hidden";

// ─── Envelope helpers ───────────────────────────────────────────────────────

interface Envelope<T> {
  data: T;
  meta?: { total?: number };
}

async function getEnvelope<T>(url: string): Promise<Envelope<T>> {
  const res = await apiRequest("GET", url);
  return (await res.json()) as Envelope<T>;
}

async function getData<T>(url: string): Promise<T> {
  return (await getEnvelope<T>(url)).data;
}

// ─── Query keys ─────────────────────────────────────────────────────────────

const BASE = (workspaceId: string) =>
  ["/api/workspaces", workspaceId, "news"] as const;

export const newsKeys = {
  base: (workspaceId: string) => BASE(workspaceId),
  brief: (workspaceId: string, filters?: BriefFilters) =>
    [...BASE(workspaceId), "brief", filters ?? {}] as const,
  briefHistory: (workspaceId: string, limit: number, offset: number) =>
    [...BASE(workspaceId), "briefs", limit, offset] as const,
  profile: (workspaceId: string) => [...BASE(workspaceId), "profile"] as const,
};

function buildBriefQuery(filters?: BriefFilters): string {
  const params = new URLSearchParams();
  if (filters?.date) params.set("date", filters.date);
  if (filters?.category) params.set("category", filters.category);
  if (filters?.readState) params.set("readState", filters.readState);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// ─── Brief ────────────────────────────────────────────────────────────────────

/** Poll interval (ms) while a brief is lazily generating. */
const GENERATING_POLL_MS = 2_500;

/**
 * GET /news/brief — the day's board.
 *
 * The backend lazily generates on first GET of the day and may briefly return
 * status `generating`; we poll until it settles to `ready` or `failed`.
 */
export function useBrief(workspaceId: string, filters?: BriefFilters) {
  return useQuery<BriefResult>({
    queryKey: newsKeys.brief(workspaceId, filters),
    queryFn: () =>
      getData<BriefResult>(
        `/api/workspaces/${workspaceId}/news/brief${buildBriefQuery(filters)}`,
      ),
    enabled: !!workspaceId,
    refetchInterval: (query) => {
      const status = query.state.data?.brief.status;
      return status === "generating" ? GENERATING_POLL_MS : false;
    },
  });
}

// ─── Brief history ──────────────────────────────────────────────────────────

export interface BriefHistoryResult {
  briefs: Brief[];
  total: number;
}

/** GET /news/briefs — paginated brief history. */
export function useBriefHistory(workspaceId: string, limit = 14, offset = 0) {
  return useQuery<BriefHistoryResult>({
    queryKey: newsKeys.briefHistory(workspaceId, limit, offset),
    queryFn: async () => {
      const env = await getEnvelope<Brief[]>(
        `/api/workspaces/${workspaceId}/news/briefs?limit=${limit}&offset=${offset}`,
      );
      return {
        briefs: env.data ?? [],
        total: env.meta?.total ?? env.data?.length ?? 0,
      };
    },
    enabled: !!workspaceId,
  });
}

// ─── Refresh ────────────────────────────────────────────────────────────────

/** POST /news/refresh — kick off regeneration; returns the brief id (202). */
export function useRefreshBrief(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<{ briefId: string }, Error, { date?: string } | void>({
    mutationFn: async (vars) => {
      const body = vars && "date" in vars && vars.date ? { date: vars.date } : {};
      const res = await apiRequest(
        "POST",
        `/api/workspaces/${workspaceId}/news/refresh`,
        body,
      );
      const env = (await res.json()) as Envelope<{ briefId: string }>;
      return env.data;
    },
    onSuccess: () => {
      // The next brief GET re-fetches and (if generating) resumes polling.
      qc.invalidateQueries({ queryKey: newsKeys.base(workspaceId) });
    },
  });
}

// ─── Profile ──────────────────────────────────────────────────────────────────

/** GET /news/profile — the current user's personalization profile. */
export function useNewsProfile(workspaceId: string) {
  return useQuery<NewsProfile>({
    queryKey: newsKeys.profile(workspaceId),
    queryFn: () =>
      getData<NewsProfile>(`/api/workspaces/${workspaceId}/news/profile`),
    enabled: !!workspaceId,
  });
}

/** PUT /news/profile — update role / stack / muted categories. */
export function useUpdateNewsProfile(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<NewsProfile, Error, NewsProfile>({
    mutationFn: async (body) => {
      const res = await apiRequest(
        "PUT",
        `/api/workspaces/${workspaceId}/news/profile`,
        body,
      );
      const env = (await res.json()) as Envelope<NewsProfile>;
      return env.data;
    },
    onSuccess: (profile) => {
      qc.setQueryData(newsKeys.profile(workspaceId), profile);
      // A changed profile re-ranks the next brief.
      qc.invalidateQueries({ queryKey: newsKeys.base(workspaceId) });
    },
  });
}

// ─── Feedback ───────────────────────────────────────────────────────────────

/**
 * POST /news/items/:itemId/feedback — read / up / down / hidden.
 * Invalidates the brief query on success so the item's new read/feedback
 * state (and any re-rank/hide) is reflected.
 */
export function useNewsFeedback(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<
    NewsItem,
    Error,
    { itemId: string; action: FeedbackAction }
  >({
    mutationFn: async ({ itemId, action }) => {
      const res = await apiRequest(
        "POST",
        `/api/workspaces/${workspaceId}/news/items/${itemId}/feedback`,
        { action },
      );
      const env = (await res.json()) as Envelope<NewsItem>;
      return env.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: newsKeys.base(workspaceId) });
    },
  });
}
