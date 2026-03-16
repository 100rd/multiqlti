import { useQuery } from "@tanstack/react-query";

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function apiRequest(method: string, url: string) {
  const headers: Record<string, string> = {};
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { method, headers });
  if (!res.ok) {
    if (res.status === 403) return null; // not owner — silently return null
    throw new Error(res.statusText);
  }
  return res.json();
}

export interface ManagerIterationRow {
  id: string;
  runId: string;
  iterationNumber: number;
  decision: Record<string, unknown>;
  teamResult: string | null;
  tokensUsed: number;
  decisionDurationMs: number;
  teamDurationMs: number | null;
  createdAt: string;
}

export interface ManagerIterationsResponse {
  iterations: ManagerIterationRow[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * Fetches manager iterations for a run.
 * Polls every 2 seconds while the run is active.
 * Stops polling when the run is complete/failed.
 */
export function useManagerIterations(runId: string, isActive: boolean) {
  return useQuery<ManagerIterationsResponse | null>({
    queryKey: ["/api/runs", runId, "manager-iterations"],
    queryFn: () => apiRequest("GET", `/api/runs/${runId}/manager-iterations?limit=100`),
    enabled: Boolean(runId),
    refetchInterval: isActive ? 2000 : false,
    staleTime: isActive ? 0 : 30_000,
  });
}
