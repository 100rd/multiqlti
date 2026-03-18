import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { apiRequest } from "@/hooks/use-pipeline";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SymbolKind = "function" | "class" | "interface" | "type" | "variable" | "export" | "import";

export interface SymbolSearchResult {
  id: string;
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  col: number;
  signature: string | null;
  usageCount: number;
}

// ─── Debounce helper ──────────────────────────────────────────────────────────

export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

async function fetchSymbols(
  workspaceId: string,
  q: string,
  kind: SymbolKind | "",
): Promise<SymbolSearchResult[]> {
  const params = new URLSearchParams({ q });
  if (kind) params.set("kind", kind);
  return apiRequest("GET", `/api/workspaces/${workspaceId}/symbols?${params.toString()}`);
}

export function useSymbolSearch(
  workspaceId: string,
  query: string,
  kind: SymbolKind | "",
) {
  const debouncedQuery = useDebounce(query, 300);

  return useQuery<SymbolSearchResult[], Error>({
    queryKey: ["symbol-search", workspaceId, debouncedQuery, kind],
    queryFn: () => fetchSymbols(workspaceId, debouncedQuery, kind),
    enabled: !!workspaceId && debouncedQuery.length >= 1,
    placeholderData: (prev) => prev,
  });
}
