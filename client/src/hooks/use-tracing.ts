import { useQuery } from "@tanstack/react-query";
import type { PipelineTrace } from "@shared/types";

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function apiRequest<T>(url: string): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error((err as { message?: string }).message || res.statusText);
  }
  return res.json() as Promise<T>;
}

export function useTrace(runId: string) {
  const { data: trace, isLoading, error } = useQuery<PipelineTrace | null>({
    queryKey: ["/api/runs", runId, "trace"],
    queryFn: () => apiRequest<PipelineTrace | null>(`/api/runs/${runId}/trace`),
    enabled: !!runId,
  });

  return { trace: trace ?? null, isLoading, error };
}
