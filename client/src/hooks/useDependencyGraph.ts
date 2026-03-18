import { useQuery } from "@tanstack/react-query";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DGNode {
  id: string;
  label: string;
  importCount: number;
  importedByCount: number;
}

export interface DGEdge {
  id: string;
  source: string;
  target: string;
}

export interface DependencyGraphResponse {
  nodes: DGNode[];
  edges: DGEdge[];
}

// ─── Auth helper ──────────────────────────────────────────────────────────────

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

async function fetchDependencyGraph(workspaceId: string): Promise<DependencyGraphResponse> {
  const token = getAuthToken();
  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`/api/workspaces/${workspaceId}/dependency-graph`, { headers: authHeaders });
  if (res.status === 409) {
    const body = (await res.json()) as { error: string; indexStatus: string };
    throw Object.assign(new Error(body.error ?? "Workspace not yet indexed"), {
      indexStatus: body.indexStatus,
      status: 409,
    });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<DependencyGraphResponse>;
}

export function useDependencyGraph(workspaceId: string) {
  return useQuery<DependencyGraphResponse, Error & { status?: number; indexStatus?: string }>({
    queryKey: ["dependency-graph", workspaceId],
    queryFn: () => fetchDependencyGraph(workspaceId),
    enabled: !!workspaceId,
    retry: false,
  });
}
