import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { GitSkillSourceWithStats } from "@shared/types";

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function apiRequest<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error ?? res.statusText);
  }
  if (res.status === 204) return null as T;
  return res.json() as Promise<T>;
}

const QUERY_KEY = ["/api/skills/git-sources"] as const;

// ─── List ─────────────────────────────────────────────────────────────────────

export function useGitSkillSources() {
  return useQuery<GitSkillSourceWithStats[]>({
    queryKey: QUERY_KEY,
    queryFn: () => apiRequest<GitSkillSourceWithStats[]>("GET", "/api/skills/git-sources"),
  });
}

// ─── Create ───────────────────────────────────────────────────────────────────

export interface CreateGitSourcePayload {
  name: string;
  repoUrl: string;
  branch?: string;
  path?: string;
  syncOnStart?: boolean;
}

export function useCreateGitSkillSource() {
  const qc = useQueryClient();
  return useMutation<GitSkillSourceWithStats, Error, CreateGitSourcePayload>({
    mutationFn: (data) =>
      apiRequest<GitSkillSourceWithStats>("POST", "/api/skills/git-sources", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["/api/skills"] });
    },
  });
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export function useDeleteGitSkillSource() {
  const qc = useQueryClient();
  return useMutation<null, Error, string>({
    mutationFn: (id) => apiRequest<null>("DELETE", `/api/skills/git-sources/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["/api/skills"] });
    },
  });
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

export function useSyncGitSkillSource() {
  const qc = useQueryClient();
  return useMutation<{ message: string }, Error, string>({
    mutationFn: (id) =>
      apiRequest<{ message: string }>("POST", `/api/skills/git-sources/${id}/sync`),
    onSuccess: () => {
      // Poll after a short delay so the sync has a chance to start
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: QUERY_KEY });
        qc.invalidateQueries({ queryKey: ["/api/skills"] });
      }, 1500);
    },
  });
}

// ─── PAT ─────────────────────────────────────────────────────────────────────

export function useSetGitSourcePat() {
  return useMutation<null, Error, { id: string; pat: string }>({
    mutationFn: ({ id, pat }) =>
      apiRequest<null>("POST", `/api/skills/git-sources/${id}/pat`, { pat }),
  });
}
