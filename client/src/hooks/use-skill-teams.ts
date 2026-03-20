import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SkillTeam } from "@shared/schema";

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
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error((err as { message?: string }).message ?? res.statusText);
  }
  if (res.status === 204) return null as T;
  return res.json() as Promise<T>;
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

export function useSkillTeams() {
  return useQuery<SkillTeam[]>({
    queryKey: ["/api/skill-teams"],
    queryFn: () => apiRequest<SkillTeam[]>("GET", "/api/skill-teams"),
  });
}

export interface CreateSkillTeamPayload {
  name: string;
  description?: string;
}

export function useCreateSkillTeam() {
  const qc = useQueryClient();
  return useMutation<SkillTeam, Error, CreateSkillTeamPayload>({
    mutationFn: (data) => apiRequest<SkillTeam>("POST", "/api/skill-teams", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/skill-teams"] });
    },
  });
}

export function useDeleteSkillTeam() {
  const qc = useQueryClient();
  return useMutation<null, Error, string>({
    mutationFn: (id) => apiRequest<null>("DELETE", `/api/skill-teams/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/skill-teams"] });
    },
  });
}
