import { useQuery } from "@tanstack/react-query";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SymbolReference {
  file: string;
  line: number;
  col: number;
  kind: string;
}

export interface SymbolRefsResponse {
  name: string;
  references: SymbolReference[];
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

async function fetchSymbolRefs(workspaceId: string, symbolName: string): Promise<SymbolRefsResponse> {
  const res = await fetch(
    `/api/workspaces/${workspaceId}/symbols/${encodeURIComponent(symbolName)}/references`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<SymbolRefsResponse>;
}

export function useSymbolRefs(workspaceId: string, symbolName: string | null) {
  return useQuery<SymbolRefsResponse, Error>({
    queryKey: ["symbol-refs", workspaceId, symbolName],
    queryFn: () => fetchSymbolRefs(workspaceId, symbolName!),
    enabled: !!workspaceId && !!symbolName,
  });
}
