/**
 * use-config-sync.ts — Hooks for the config-sync peer status and conflict panel.
 *
 * Issue #324: Config sync UI — peer status indicator + conflict panel
 *
 * Provides:
 *  - useConfigSyncStatus()     — aggregated peer sync status (header badge)
 *  - useConfigConflicts()      — list of open conflicts from the conflict store
 *  - useResolveConflict()      — mutation to accept-remote or keep-local
 *  - useDismissConflict()      — mutation to dismiss a conflict
 *  - useConfigSyncWsUpdates()  — subscribes to WS for real-time invalidation
 */

import { useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { wsClient } from "@/lib/websocket";

// ─── Auth helper (duplicated from use-connections pattern) ────────────────────

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function apiRequest(method: string, url: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as {
      message?: string;
      error?: string;
    };
    const message = err.message ?? err.error ?? res.statusText;
    const error = new Error(message) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }

  if (res.status === 204) return null;
  return res.json();
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type PeerSyncStatus = "synced" | "pending" | "offline" | "conflict";

export interface PeerSyncInfo {
  peerId: string;
  peerName: string;
  endpoint: string;
  status: PeerSyncStatus;
  /** ISO timestamp of the last message received from this peer. */
  lastSeenAt: string | null;
  /** Seconds since last message, derived from lastSeenAt. */
  lastSeenSecs: number | null;
  queueDepth: number;
  openConflicts: number;
}

export type SyncBadgeState = "green" | "yellow" | "red";

export interface ConfigSyncStatus {
  /** Total number of known peers (including offline). */
  totalPeers: number;
  /** Number of peers connected and recently synced (< 5 min). */
  syncedPeers: number;
  badgeState: SyncBadgeState;
  /** Human-readable summary, e.g. "3 peers, synced 2m ago". */
  summary: string;
  /** Per-peer details. */
  peers: PeerSyncInfo[];
  /** Total open conflicts across all peers. */
  openConflicts: number;
  /** ISO timestamp of last successful sync across any peer. */
  lastSyncAt: string | null;
}

export interface ConfigConflict {
  id: string;
  entityKind: string;
  entityId: string;
  peerId: string;
  remoteVersion: string;
  localVersion: string;
  remotePayload: Record<string, unknown>;
  localPayload: Record<string, unknown>;
  strategy: string;
  status: string;
  detectedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  isContested: boolean;
}

export interface ConflictListResponse {
  conflicts: ConfigConflict[];
  total: number;
}

// ─── Query keys ───────────────────────────────────────────────────────────────

export const CONFIG_SYNC_STATUS_KEY = ["/api/federation/config-sync/status"] as const;
export const CONFIG_CONFLICTS_KEY = ["/api/federation/config-conflicts"] as const;

// ─── Hooks ────────────────────────────────────────────────────────────────────

/**
 * Polls the aggregated config-sync status endpoint every 30 seconds.
 * The header badge uses this for green/yellow/red state.
 */
export function useConfigSyncStatus() {
  return useQuery<ConfigSyncStatus>({
    queryKey: CONFIG_SYNC_STATUS_KEY,
    queryFn: () => apiRequest("GET", "/api/federation/config-sync/status") as Promise<ConfigSyncStatus>,
    refetchInterval: 30_000,
    staleTime: 20_000,
    // Returns a sensible fallback when federation is not enabled (503).
    retry: false,
  });
}

/**
 * Fetches all open conflicts from the config-conflict store.
 * The conflict panel uses this.
 */
export function useConfigConflicts(entityKind?: string) {
  const url = entityKind
    ? `/api/federation/config-conflicts?entityKind=${encodeURIComponent(entityKind)}`
    : "/api/federation/config-conflicts";

  return useQuery<ConflictListResponse>({
    queryKey: [...CONFIG_CONFLICTS_KEY, entityKind ?? "all"],
    queryFn: () => apiRequest("GET", url) as Promise<ConflictListResponse>,
    refetchInterval: 15_000,
    staleTime: 10_000,
    retry: false,
  });
}

export interface ResolveConflictVars {
  conflictId: string;
  /** true = apply remote version, false = keep local version. */
  applyRemote: boolean;
  resolutionNote?: string;
}

/** Human-in-the-loop resolution: accept remote or keep local. */
export function useResolveConflict() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, ResolveConflictVars>({
    mutationFn: ({ conflictId, applyRemote, resolutionNote }) =>
      apiRequest("POST", `/api/federation/config-conflicts/${conflictId}/resolve`, {
        applyRemote,
        resolutionNote,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CONFIG_CONFLICTS_KEY });
      void qc.invalidateQueries({ queryKey: CONFIG_SYNC_STATUS_KEY });
    },
  });
}

export interface DismissConflictVars {
  conflictId: string;
  resolutionNote?: string;
}

/** Dismiss a conflict without applying either side. */
export function useDismissConflict() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, DismissConflictVars>({
    mutationFn: ({ conflictId, resolutionNote }) =>
      apiRequest("POST", `/api/federation/config-conflicts/${conflictId}/dismiss`, {
        resolutionNote,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CONFIG_CONFLICTS_KEY });
      void qc.invalidateQueries({ queryKey: CONFIG_SYNC_STATUS_KEY });
    },
  });
}

/**
 * Subscribes to WebSocket federation events and invalidates queries on updates.
 * Should be mounted once in the ConfigSync page to get real-time refreshes.
 */
export function useConfigSyncWsUpdates() {
  const qc = useQueryClient();

  const handleEvent = useCallback(() => {
    void qc.invalidateQueries({ queryKey: CONFIG_SYNC_STATUS_KEY });
    void qc.invalidateQueries({ queryKey: CONFIG_CONFLICTS_KEY });
  }, [qc]);

  useEffect(() => {
    wsClient.connect();
    // Listen to federation-related events for real-time updates.
    const unsubs = [
      wsClient.on("federation:handoff:sent", handleEvent),
      wsClient.on("federation:handoff:received", handleEvent),
      wsClient.on("federation:handoff:accepted", handleEvent),
      wsClient.on("federation:user_joined", handleEvent),
      wsClient.on("federation:user_left", handleEvent),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [handleEvent]);
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

/**
 * Returns a human-readable "X ago" string from an ISO timestamp or seconds value.
 */
export function formatLastSeen(secs: number | null): string {
  if (secs === null) return "never";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/**
 * Derives a badge state from the current sync status.
 * - green:  all peers synced within 5 min
 * - yellow: synced but ≥1 peer has pending queue items
 * - red:    any peer offline OR unresolved conflicts
 */
export function deriveBadgeState(status: ConfigSyncStatus): SyncBadgeState {
  if (status.openConflicts > 0) return "red";
  const hasOffline = status.peers.some(
    (p) => p.status === "offline" || (p.lastSeenSecs !== null && p.lastSeenSecs > 300),
  );
  if (hasOffline) return "red";
  const hasPending = status.peers.some((p) => p.queueDepth > 0);
  if (hasPending) return "yellow";
  return "green";
}
