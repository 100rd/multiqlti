/**
 * React-query hooks for the Active Knowledge Base (Terraform practice cards).
 *
 * Mirrors the style of use-api.ts: typed queries/mutations over the REST
 * surface at /api/workspaces/:id/knowledge/practice-cards, invalidating the
 * relevant query keys on every mutation.
 *
 * Type strategy:
 *  - The card shape is shared from the backend (@shared/schema PracticeCardRow)
 *    so the contract stays in lockstep. We re-export a UI-facing `PracticeCard`
 *    alias from it.
 *  - RefreshRun + ComplianceResult shapes mirror the Wave 2 backend exactly
 *    (snake_case node fields, count-vs-array report buckets) and are typed
 *    locally until the backend exports them.
 *
 * The server uses the `{ data, meta }` / `{ error }` envelope; these hooks
 * unwrap `data` so callers receive plain typed payloads.
 *
 * Security: all card-derived strings (statement, rationale, sources[].url) are
 * UNREVIEWED, agent-supplied content. They flow to React as plain children /
 * text props only — never through dangerouslySetInnerHTML or any HTML sink.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type {
  PracticeCardRow,
  PracticeCardStatus,
  PracticeCardReviewState,
  PracticeCardRefreshStatus,
} from "@shared/schema";

// ─── Types ──────────────────────────────────────────────────────────────────

/** UI-facing alias for the backend card row (single source of truth). */
export type PracticeCard = PracticeCardRow;

export type { PracticeCardStatus, PracticeCardReviewState };

/** A semantic-search hit: the hydrated card plus its similarity score. */
export interface SearchHit {
  card: PracticeCard;
  score: number;
}

/** Filters accepted by GET /practice-cards. */
export interface PracticeCardFilters {
  status?: PracticeCardStatus;
  reviewState?: PracticeCardReviewState;
  topic?: string;
  limit?: number;
  offset?: number;
}

/**
 * The diff report a refresh run produces (Wave 2 backend shape). These are
 * FLAGS for human review — never auto-applied.
 *  - `new` / `changed` are COUNTS.
 *  - `stale` / `superseded` are arrays of affected card ids.
 */
export interface RefreshReport {
  new: number;
  changed: number;
  stale: string[];
  superseded: string[];
  unchangedCount: number;
}

export interface RefreshRun {
  id: string;
  workspaceId: string;
  topic: string;
  trigger: string;
  status: PracticeCardRefreshStatus;
  report: RefreshReport;
  startedAt: string;
  completedAt: string | null;
}

/**
 * A graph node referenced by the compliance pass. Fields are snake_case,
 * straight from the graphify graph: `label`/`source_file` may be absent.
 */
export interface ComplianceNode {
  id: string;
  label?: string;
  source_file?: string;
}

/**
 * Per-card compliance signal against the user's infra graph.
 * `followed` is a COARSE substring heuristic (may over-report). `violated` is
 * empty in this thin MVP and must not be treated as authoritative.
 */
export interface ComplianceResult {
  cardId: string;
  statement: string;
  followed: ComplianceNode[];
  violated: ComplianceNode[];
  unknown: ComplianceNode[];
}

// ─── Envelope helpers ─────────────────────────────────────────────────────────

interface Envelope<T> {
  data: T;
  meta?: { total?: number };
}

async function getData<T>(url: string): Promise<T> {
  const res = await apiRequest("GET", url);
  const body = (await res.json()) as Envelope<T>;
  return body.data;
}

async function getEnvelope<T>(url: string): Promise<Envelope<T>> {
  const res = await apiRequest("GET", url);
  return (await res.json()) as Envelope<T>;
}

// ─── Query keys ───────────────────────────────────────────────────────────────

const BASE = (workspaceId: string) =>
  ["/api/workspaces", workspaceId, "knowledge", "practice-cards"] as const;

export const practiceCardKeys = {
  list: (workspaceId: string, filters?: PracticeCardFilters) =>
    [...BASE(workspaceId), "list", filters ?? {}] as const,
  search: (workspaceId: string, q: string, topK: number) =>
    [...BASE(workspaceId), "search", q, topK] as const,
  refreshRun: (workspaceId: string, runId: string) =>
    [...BASE(workspaceId), "refresh-run", runId] as const,
  compliance: (workspaceId: string) =>
    [...BASE(workspaceId), "compliance"] as const,
};

function buildListQuery(filters?: PracticeCardFilters): string {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.reviewState) params.set("reviewState", filters.reviewState);
  if (filters?.topic) params.set("topic", filters.topic);
  if (filters?.limit != null) params.set("limit", String(filters.limit));
  if (filters?.offset != null) params.set("offset", String(filters.offset));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// ─── List + detail ──────────────────────────────────────────────────────────

export interface PracticeCardListResult {
  cards: PracticeCard[];
  total: number;
}

/** GET /practice-cards — filtered, paginated card list. */
export function usePracticeCards(
  workspaceId: string,
  filters?: PracticeCardFilters,
) {
  return useQuery<PracticeCardListResult>({
    queryKey: practiceCardKeys.list(workspaceId, filters),
    queryFn: async () => {
      const url = `/api/workspaces/${workspaceId}/knowledge/practice-cards${buildListQuery(filters)}`;
      const env = await getEnvelope<PracticeCard[]>(url);
      return {
        cards: env.data ?? [],
        total: env.meta?.total ?? env.data?.length ?? 0,
      };
    },
    enabled: !!workspaceId,
  });
}

// ─── Semantic search ──────────────────────────────────────────────────────────

/**
 * GET /practice-cards/search — semantic search over cards.
 * Disabled until a non-empty query is supplied so it never fires on mount.
 * NOTE: results may include cards in ANY reviewState (incl. pending_verification)
 * — i.e. unreviewed content. Consumers render it inert (plain text) only.
 */
export function usePracticeCardSearch(
  workspaceId: string,
  q: string,
  topK = 10,
) {
  const trimmed = q.trim();
  return useQuery<SearchHit[]>({
    queryKey: practiceCardKeys.search(workspaceId, trimmed, topK),
    queryFn: () =>
      getData<SearchHit[]>(
        `/api/workspaces/${workspaceId}/knowledge/practice-cards/search?q=${encodeURIComponent(trimmed)}&topK=${topK}`,
      ),
    enabled: !!workspaceId && trimmed.length > 0,
  });
}

// ─── Mutations: verify / review ───────────────────────────────────────────────

export type VerifyVerdict = "pass" | "fail" | "needs_changes";

/** POST /practice-cards/:cardId/verify — adversarial verification gate. */
export function useVerifyPracticeCard(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<
    PracticeCard,
    Error,
    { cardId: string; verdict: VerifyVerdict; verifiedBy: string; notes?: string }
  >({
    mutationFn: async ({ cardId, ...body }) => {
      const res = await apiRequest(
        "POST",
        `/api/workspaces/${workspaceId}/knowledge/practice-cards/${cardId}/verify`,
        body,
      );
      const env = (await res.json()) as Envelope<PracticeCard>;
      return env.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BASE(workspaceId) });
    },
  });
}

export type ReviewDecision = "accept" | "reject";

/** POST /practice-cards/:cardId/review — human accept/reject gate (admin/owner). */
export function useReviewPracticeCard(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<
    PracticeCard,
    Error,
    { cardId: string; decision: ReviewDecision; supersedes?: string[] }
  >({
    mutationFn: async ({ cardId, ...body }) => {
      const res = await apiRequest(
        "POST",
        `/api/workspaces/${workspaceId}/knowledge/practice-cards/${cardId}/review`,
        body,
      );
      const env = (await res.json()) as Envelope<PracticeCard>;
      return env.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BASE(workspaceId) });
      qc.invalidateQueries({ queryKey: practiceCardKeys.compliance(workspaceId) });
    },
  });
}

// ─── Refresh run ──────────────────────────────────────────────────────────────

/** POST /practice-cards/refresh — kick off a refresh; returns the run id (202). */
export function useStartRefresh(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<{ refreshRunId: string }, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        `/api/workspaces/${workspaceId}/knowledge/practice-cards/refresh`,
      );
      const env = (await res.json()) as Envelope<{ refreshRunId: string }>;
      return env.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BASE(workspaceId) });
    },
  });
}

/** Poll interval (ms) for an in-flight refresh run. */
const REFRESH_POLL_MS = 2_000;

/**
 * GET /practice-cards/refresh-runs/:runId — polls while the run is in flight,
 * stops once it completes or fails.
 */
export function useRefreshRun(workspaceId: string, runId: string | null) {
  return useQuery<RefreshRun>({
    queryKey: practiceCardKeys.refreshRun(workspaceId, runId ?? ""),
    queryFn: () =>
      getData<RefreshRun>(
        `/api/workspaces/${workspaceId}/knowledge/practice-cards/refresh-runs/${runId}`,
      ),
    enabled: !!workspaceId && !!runId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "running" || status == null ? REFRESH_POLL_MS : false;
    },
  });
}

// ─── Compliance ─────────────────────────────────────────────────────────────

/** GET /practice-cards/compliance — followed/violated/unknown per card. */
export function useCompliance(workspaceId: string) {
  return useQuery<ComplianceResult[]>({
    queryKey: practiceCardKeys.compliance(workspaceId),
    queryFn: () =>
      getData<ComplianceResult[]>(
        `/api/workspaces/${workspaceId}/knowledge/practice-cards/compliance`,
      ),
    enabled: !!workspaceId,
  });
}
