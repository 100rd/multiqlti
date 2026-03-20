import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Skill } from "@shared/schema";

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
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  if (res.status === 204) return null as T;
  return res.json() as Promise<T>;
}

// ─── Query Key Factories ──────────────────────────────────────────────────────

function modelSkillsKey(modelId?: string): unknown[] {
  if (modelId) return ["/api/skills/models", modelId];
  return ["/api/skills/models"];
}

// ─── Read Hooks ───────────────────────────────────────────────────────────────

/** List all model IDs that have at least one skill binding. */
export function useModelsWithSkills() {
  return useQuery<string[]>({
    queryKey: ["/api/skills/models"],
    queryFn: () => apiRequest<string[]>("GET", "/api/skills/models"),
  });
}

/** List all skills bound to a specific model ID. */
export function useModelSkills(modelId: string) {
  return useQuery<Skill[]>({
    queryKey: modelSkillsKey(modelId),
    queryFn: () => apiRequest<Skill[]>("GET", `/api/skills/models/${encodeURIComponent(modelId)}`),
    enabled: Boolean(modelId),
  });
}

// ─── Mutation Hooks ───────────────────────────────────────────────────────────

export interface BindSkillPayload {
  modelId: string;
  skillId: string;
}

export function useBindSkillToModel() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, BindSkillPayload>({
    mutationFn: ({ modelId, skillId }) =>
      apiRequest("POST", `/api/skills/models/${encodeURIComponent(modelId)}/${encodeURIComponent(skillId)}`),
    onSuccess: (_data, { modelId }) => {
      qc.invalidateQueries({ queryKey: modelSkillsKey(modelId) });
      qc.invalidateQueries({ queryKey: ["/api/skills/models"] });
    },
  });
}

export function useUnbindSkillFromModel() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, BindSkillPayload>({
    mutationFn: ({ modelId, skillId }) =>
      apiRequest("DELETE", `/api/skills/models/${encodeURIComponent(modelId)}/${encodeURIComponent(skillId)}`),
    onSuccess: (_data, { modelId }) => {
      qc.invalidateQueries({ queryKey: modelSkillsKey(modelId) });
      qc.invalidateQueries({ queryKey: ["/api/skills/models"] });
    },
  });
}
