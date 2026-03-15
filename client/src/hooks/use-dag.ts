/**
 * DAG API hooks — Phase 6.2
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function apiRequest(method: string, url: string, body?: unknown) {
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
    throw new Error((err as { message?: string }).message ?? res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

export function usePipelineDAG(pipelineId: string) {
  return useQuery({
    queryKey: ["/api/pipelines", pipelineId, "dag"],
    queryFn: () => apiRequest("GET", `/api/pipelines/${pipelineId}/dag`),
    enabled: !!pipelineId,
  });
}

export function useSaveDAG(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dag: unknown) =>
      apiRequest("PUT", `/api/pipelines/${pipelineId}/dag`, dag),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pipelines", pipelineId, "dag"] });
      qc.invalidateQueries({ queryKey: ["/api/pipelines", pipelineId] });
    },
  });
}

export function useValidateDAG(pipelineId: string) {
  return useMutation({
    mutationFn: (dag: unknown) =>
      apiRequest("POST", `/api/pipelines/${pipelineId}/dag/validate`, dag),
  });
}
