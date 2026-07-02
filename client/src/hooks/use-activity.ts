/**
 * useActivity — the MULTI-run sibling of usePipelineEvents (use-websocket.ts).
 *
 * usePipelineEvents owns ONE run's full event stream; useActivity owns the
 * read-only "what's running right now" lens across ALL of the caller's active
 * runs. It seeds from the polled `GET /api/activity` snapshot (the source of
 * truth, which adds/removes rows) and merges the additive live WS deltas onto
 * the already-known rows, keyed by runId, between refetches.
 *
 * Shape:
 *   - useQuery(["/api/activity"]) with a refetchInterval fallback (5s) so a row
 *     that emits no WS events still refreshes, and so
 *     rows that started/ended get added/removed.
 *   - on each snapshot, subscribe to EXACTLY the snapshot's runIds (the server
 *     rejects subscribing to runs you don't own) and unsubscribe the rest.
 *   - wsClient.onAny → mergeWsEvent folds status/model/progress onto the live
 *     rows; the next refetch reconciles.
 *
 * The merge/grouping/subscription logic is pure (see @/lib/activity) and unit
 * tested; this hook is the thin React/WS wiring.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { wsClient } from "@/lib/websocket";
import type { WsEvent, ActivityMode } from "@shared/types";
import {
  mergeWsEvent,
  snapshotRunIds,
  appendHistoryPage,
  buildHistoryQuery,
  emptyHistoryState,
  hasMoreHistory,
  type ActivitySnapshot,
  type LiveActivityRun,
  type ActivityHistoryPage,
  type ActivityHistoryRow,
  type HistoryState,
} from "@/lib/activity";

/** Snapshot poll interval (fallback refresh; also reconciles WS drift). */
export const ACTIVITY_REFETCH_INTERVAL_MS = 5_000;

export interface UseActivityResult {
  runs: LiveActivityRun[];
  isAdmin: boolean;
  truncated: boolean;
  isLoading: boolean;
  error: unknown;
  /** Live WS connection state — surfaced so the page can warn on disconnect. */
  isConnected: boolean;
}

export function useActivity(): UseActivityResult {
  const query = useQuery<ActivitySnapshot>({
    queryKey: ["/api/activity"],
    queryFn: () => apiRequest("GET", "/api/activity").then((r) => r.json()),
    refetchInterval: ACTIVITY_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  // The live, WS-merged view of the rows. Seeded from each snapshot; folded by
  // wsClient.onAny between refetches.
  const [rows, setRows] = useState<LiveActivityRun[]>([]);
  const [isConnected, setIsConnected] = useState(wsClient.isConnected);

  // Snapshot rows reseed the live view (snapshot is the source of truth).
  const snapshot = query.data;
  useEffect(() => {
    if (!snapshot) return;
    setRows(snapshot.runs as LiveActivityRun[]);
  }, [snapshot]);

  // Subscribe to EXACTLY the snapshot's runIds (ownership-scoped); the WsClient
  // de-dupes subscribe() and re-subscribes on reconnect. Track what we've
  // subscribed to so we can unsubscribe rows that left the snapshot.
  const subscribedRef = useRef<Set<string>>(new Set());
  const ids = snapshot ? snapshotRunIds(snapshot.runs) : [];
  const idsKey = ids.join(",");

  useEffect(() => {
    wsClient.connect();
    const wanted = new Set(idsKey ? idsKey.split(",") : []);
    const current = subscribedRef.current;

    for (const id of wanted) {
      if (!current.has(id)) wsClient.subscribe(id);
    }
    for (const id of current) {
      if (!wanted.has(id)) wsClient.unsubscribe(id);
    }
    subscribedRef.current = wanted;
  }, [idsKey]);

  // Merge live deltas + track connection state.
  useEffect(() => {
    wsClient.connect();
    const onEvent = (event: WsEvent) => {
      setIsConnected(wsClient.isConnected);
      setRows((prev) => mergeWsEvent(prev, event));
    };
    const unsub = wsClient.onAny(onEvent);
    setIsConnected(wsClient.isConnected);
    return () => {
      unsub();
    };
  }, []);

  // Unsubscribe everything on unmount (leaving the page).
  useEffect(() => {
    return () => {
      for (const id of subscribedRef.current) wsClient.unsubscribe(id);
      subscribedRef.current = new Set();
    };
  }, []);

  return {
    runs: rows,
    isAdmin: snapshot?.isAdmin ?? false,
    truncated: snapshot?.truncated ?? false,
    isLoading: query.isLoading,
    error: query.error,
    isConnected,
  };
}

// ─── Activity History (terminal runs, keyset-paginated) ────────────────────────
/**
 * useActivityHistory — manual keyset pagination over GET /api/activity/history.
 *
 * The snapshot lens (useActivity) shows what's running NOW; this shows past
 * (terminal) runs across all modes. We page by cursor: the first request carries
 * no cursor (newest page), and "Load more" re-queries with the previous page's
 * nextCursor. Each fetched page is folded onto the accumulated list by the pure
 * appendHistoryPage reducer (de-duped by mode:runId). The page rendering reuses
 * the SAME row shape as the live tab (mode group, currentUnit, status badge,
 * owner column for admins).
 *
 * The fetch/merge logic is pure (see @/lib/activity); this hook is the thin wiring.
 */
/** Default page size; the server clamps to ≤100 and buildHistoryQuery mirrors it. */
export const ACTIVITY_HISTORY_PAGE_SIZE = 25;

export interface UseActivityHistoryResult {
  items: ActivityHistoryRow[];
  isAdmin: boolean;
  hasMore: boolean;
  isLoading: boolean;
  isFetchingMore: boolean;
  error: unknown;
  loadMore: () => void;
}

export function useActivityHistory(
  mode: ActivityMode | null = null,
): UseActivityHistoryResult {
  // The cursor currently being requested. `null` = first/newest page.
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<HistoryState>(emptyHistoryState);

  const queryString = useMemo(
    () =>
      buildHistoryQuery({
        limit: ACTIVITY_HISTORY_PAGE_SIZE,
        cursor,
        mode,
      }),
    [cursor, mode],
  );

  const query = useQuery<ActivityHistoryPage>({
    // The mode is part of the key so switching mode refetches a fresh first page.
    queryKey: ["/api/activity/history", mode, cursor],
    queryFn: async () => {
      const page = (await apiRequest(
        "GET",
        `/api/activity/history${queryString}`,
      ).then((r) => r.json())) as ActivityHistoryPage;
      // Fold synchronously so items/cursor stay consistent with this page.
      setState((prev) => appendHistoryPage(prev, page, cursor === null));
      return page;
    },
    // Each (mode,cursor) pair is fetched exactly once; pages are immutable.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const loadMore = useCallback(() => {
    if (state.nextCursor) setCursor(state.nextCursor);
  }, [state.nextCursor]);

  const isFirstPagePending = query.isLoading && cursor === null;

  return {
    items: state.items,
    isAdmin: state.isAdmin,
    hasMore: hasMoreHistory(state),
    isLoading: isFirstPagePending,
    isFetchingMore: query.isFetching && cursor !== null,
    error: query.error,
    loadMore,
  };
}
