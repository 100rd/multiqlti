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
 *     that emits no WS events (consensus is poll-only) still refreshes, and so
 *     rows that started/ended get added/removed.
 *   - on each snapshot, subscribe to EXACTLY the snapshot's runIds (the server
 *     rejects subscribing to runs you don't own) and unsubscribe the rest.
 *   - wsClient.onAny → mergeWsEvent folds status/model/progress onto the live
 *     rows; the next refetch reconciles.
 *
 * The merge/grouping/subscription logic is pure (see @/lib/activity) and unit
 * tested; this hook is the thin React/WS wiring.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { wsClient } from "@/lib/websocket";
import type { WsEvent } from "@shared/types";
import {
  mergeWsEvent,
  snapshotRunIds,
  type ActivitySnapshot,
  type LiveActivityRun,
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
