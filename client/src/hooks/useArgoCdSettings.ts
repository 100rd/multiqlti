/**
 * React Query hooks for ArgoCD settings.
 * Phase 6.10.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const QUERY_KEY = ["/api/settings/argocd"] as const;

// ─── Response types ───────────────────────────────────────────────────────────

export interface ArgoCdConfigResponse {
  configured: boolean;
  serverUrl: string | null;
  verifySsl: boolean;
  enabled: boolean;
  healthStatus: "connected" | "error" | "unknown";
  healthError: string | null;
  lastHealthCheckAt: string | null;
  mcpServerId: number | null;
  source?: "env" | "db";
}

export interface ArgoCdTestResult {
  ok: boolean;
  applicationCount: number;
  applications: string[];
  latencyMs: number;
  error?: string;
}

export interface SaveArgoCdConfigPayload {
  serverUrl: string;
  token?: string;
  verifySsl: boolean;
  enabled: boolean;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(url, {
    ...options,
    headers: { ...authHeaders, ...options?.headers },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

/** Fetch current ArgoCD configuration. */
export function useArgoCdConfig() {
  return useQuery<ArgoCdConfigResponse>({
    queryKey: QUERY_KEY,
    queryFn: () => fetchJson<ArgoCdConfigResponse>("/api/settings/argocd"),
    staleTime: 30_000,
  });
}

/** Save (create or update) ArgoCD configuration. */
export function useSaveArgoCdConfig() {
  const qc = useQueryClient();
  return useMutation<ArgoCdConfigResponse, Error, SaveArgoCdConfigPayload>({
    mutationFn: (payload) =>
      fetchJson<ArgoCdConfigResponse>("/api/settings/argocd", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

/** Remove ArgoCD configuration. */
export function useDeleteArgoCdConfig() {
  const qc = useQueryClient();
  return useMutation<void, Error>({
    mutationFn: () => fetchJson<void>("/api/settings/argocd", { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

/** Test the ArgoCD connection. */
export function useTestArgoCd() {
  return useMutation<ArgoCdTestResult, Error>({
    mutationFn: () =>
      fetchJson<ArgoCdTestResult>("/api/settings/argocd/test", { method: "POST" }),
  });
}
