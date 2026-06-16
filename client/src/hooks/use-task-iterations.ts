/**
 * Task Groups v2 hooks (FE1): the iterations list, the per-iteration detail, and
 * a status-aware "start a run" mutation.
 *
 *  - useTaskGroupIterations(groupId) — manual keyset pagination over
 *    GET …/iterations, mirroring useActivityHistory: the first request carries no
 *    cursor (newest page), and "Load more" re-queries with the previous page's
 *    nextCursor. Each page is folded by the pure appendIterationPage reducer
 *    (de-duped by iterationNumber). The list is metadata-only (server allowlist).
 *  - useIterationDetail(groupId, n) — the owner-gated { iteration, executions }
 *    detail (executions DO carry summary/error/output/model).
 *  - useStartTaskGroupRun(groupId) — POST …/start as a status-aware mutation so
 *    the page can branch 409 (running / cap) vs 400 (no ready tasks) into a toast.
 *
 * The shaping/gating logic is pure (see @/lib/task-iterations); these hooks are
 * the thin React Query wiring.
 */
import { useCallback, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "./use-pipeline";
import { TaskGroupApiError } from "./use-task-groups";
import {
  appendIterationPage,
  buildIterationsQuery,
  emptyIterationListState,
  hasMoreIterations,
  type IterationListPage,
  type IterationListState,
  type IterationSummary,
  type IterationDetail,
} from "@/lib/task-iterations";

/** Default page size; the server clamps to ≤100 and buildIterationsQuery mirrors it. */
export const ITERATIONS_PAGE_SIZE = 20;

export interface UseTaskGroupIterationsResult {
  items: IterationSummary[];
  hasMore: boolean;
  isLoading: boolean;
  isFetchingMore: boolean;
  error: unknown;
  loadMore: () => void;
}

/** Keyset-paginated iterations list for a group, newest-first (FE1). */
export function useTaskGroupIterations(
  groupId: string,
): UseTaskGroupIterationsResult {
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<IterationListState>(emptyIterationListState);

  const queryString = useMemo(
    () => buildIterationsQuery({ limit: ITERATIONS_PAGE_SIZE, cursor }),
    [cursor],
  );

  const query = useQuery<IterationListPage>({
    queryKey: ["/api/task-groups", groupId, "iterations", cursor],
    queryFn: async () => {
      const page = (await apiRequest(
        "GET",
        `/api/task-groups/${groupId}/iterations${queryString}`,
      )) as IterationListPage;
      // Fold synchronously so items/cursor stay consistent with this page.
      setState((prev) => appendIterationPage(prev, page, cursor === null));
      return page;
    },
    enabled: !!groupId,
    // The newest page reflects live state, so refresh it; deeper pages are stable.
    refetchInterval: cursor === null ? 3000 : false,
    refetchOnWindowFocus: false,
  });

  const loadMore = useCallback(() => {
    if (state.nextCursor) setCursor(state.nextCursor);
  }, [state.nextCursor]);

  const isFirstPagePending = query.isLoading && cursor === null;

  return {
    items: state.items,
    hasMore: hasMoreIterations(state),
    isLoading: isFirstPagePending,
    isFetchingMore: query.isFetching && cursor !== null,
    error: query.error,
    loadMore,
  };
}

/** The owner-gated { iteration, executions } detail for one iteration (FE1). */
export function useIterationDetail(groupId: string, iterationNumber: number | null) {
  return useQuery<IterationDetail>({
    queryKey: ["/api/task-groups", groupId, "iterations", "detail", iterationNumber],
    queryFn: () =>
      apiRequest(
        "GET",
        `/api/task-groups/${groupId}/iterations/${iterationNumber}`,
      ) as Promise<IterationDetail>,
    enabled: !!groupId && iterationNumber !== null && iterationNumber >= 1,
    refetchInterval: 3000,
  });
}

/**
 * Start a run (POST …/start) as a STATUS-AWARE mutation: the shared apiRequest
 * collapses everything to Error(message), which loses the 409/400 the toast
 * needs. This keeps the HTTP status on a TaskGroupApiError so the page can phrase
 * "already running" / "cap reached" / "no ready tasks". Invalidates the group +
 * its iterations on success.
 */
export function useStartTaskGroupRun(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const token = localStorage.getItem("auth_token");
      const res = await fetch(`/api/task-groups/${groupId}/start`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
      });
      if (!res.ok) {
        const parsed = (await res
          .json()
          .catch(() => ({ message: res.statusText }))) as {
          message?: string;
          error?: string;
        };
        throw new TaskGroupApiError(
          res.status,
          parsed.message ?? parsed.error ?? res.statusText,
        );
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/task-groups", groupId] });
      qc.invalidateQueries({ queryKey: ["/api/task-groups", groupId, "iterations"] });
      qc.invalidateQueries({ queryKey: ["/api/task-groups"] });
    },
  });
}
