import { useQuery } from "@tanstack/react-query";
import type { ThoughtTree } from "@shared/types";

/**
 * Fetch the thought tree for a specific stage execution.
 * Requires authentication — returns undefined if not authed.
 */
export function useThoughtTree(runId: string | undefined, stageIndex: number | undefined) {
  return useQuery<ThoughtTree>({
    queryKey: ["thought-tree", runId, stageIndex],
    queryFn: async () => {
      if (!runId || stageIndex === undefined) return [];
      const res = await fetch(`/api/runs/${runId}/stages/${stageIndex}/thought-tree`);
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) return [];
        throw new Error(`Failed to fetch thought tree: ${res.status}`);
      }
      return res.json() as Promise<ThoughtTree>;
    },
    enabled: !!runId && stageIndex !== undefined,
    staleTime: 60_000,
  });
}
