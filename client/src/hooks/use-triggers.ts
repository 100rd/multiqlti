import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { PipelineTrigger, InsertTrigger, UpdateTrigger } from "@shared/types";

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function apiRequest(method: string, url: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error((err as { message?: string }).message || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export function useTriggers(pipelineId?: string) {
  const url = pipelineId
    ? `/api/triggers?pipelineId=${pipelineId}`
    : "/api/triggers";
  return useQuery<PipelineTrigger[]>({
    queryKey: ["/api/triggers", pipelineId ?? null],
    queryFn: () => apiRequest("GET", url) as Promise<PipelineTrigger[]>,
  });
}

export function useTrigger(id: string) {
  return useQuery<PipelineTrigger>({
    queryKey: ["/api/triggers", id],
    queryFn: () => apiRequest("GET", `/api/triggers/${id}`) as Promise<PipelineTrigger>,
    enabled: !!id,
  });
}

// ─── Mutations ───────────────────────────────────────────────────────────────

export function useCreateTrigger() {
  const qc = useQueryClient();
  return useMutation<PipelineTrigger, Error, InsertTrigger & { _plainSecret?: string }>({
    mutationFn: ({ _plainSecret: secret, ...data }) => {
      const payload = secret ? { ...data, secret } : data;
      return apiRequest("POST", "/api/triggers", payload) as Promise<PipelineTrigger>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/triggers"] });
    },
  });
}

export function useUpdateTrigger() {
  const qc = useQueryClient();
  return useMutation<PipelineTrigger, Error, { id: string } & UpdateTrigger>({
    mutationFn: ({ id, ...updates }) =>
      apiRequest("PATCH", `/api/triggers/${id}`, updates) as Promise<PipelineTrigger>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/triggers"] });
    },
  });
}

export function useDeleteTrigger() {
  const qc = useQueryClient();
  return useMutation<null, Error, string>({
    mutationFn: (id) =>
      apiRequest("DELETE", `/api/triggers/${id}`) as Promise<null>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/triggers"] });
    },
  });
}

export function useEnableTrigger() {
  const qc = useQueryClient();
  return useMutation<PipelineTrigger, Error, string>({
    mutationFn: (id) =>
      apiRequest("POST", `/api/triggers/${id}/enable`) as Promise<PipelineTrigger>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/triggers"] });
    },
  });
}

export function useDisableTrigger() {
  const qc = useQueryClient();
  return useMutation<PipelineTrigger, Error, string>({
    mutationFn: (id) =>
      apiRequest("POST", `/api/triggers/${id}/disable`) as Promise<PipelineTrigger>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/triggers"] });
    },
  });
}
