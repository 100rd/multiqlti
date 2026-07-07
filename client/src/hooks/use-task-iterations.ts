/**
 * Consilium round dispute hooks: the owner-gated per-iteration detail and the
 * human-in-the-loop note mutation. Both back the "Dispute" section of a consilium
 * loop round (client/src/components/task-groups/iterations-panel.tsx). The
 * underlying task-group iteration endpoints are internal machinery now — the loop
 * is the one user-facing entity.
 *
 * The shaping/gating logic is pure (see @/lib/task-iterations); these hooks are
 * the thin React Query wiring.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "./use-api";
import type { IterationDetail } from "@/lib/task-iterations";

/**
 * Save the human-in-the-loop note on one round's iteration (PATCH …/iterations/:n).
 * The note is folded into the NEXT round's dispute input, so the following round
 * argues with the user's thoughts/decisions in scope. Invalidates the iteration's
 * detail so the editor reflects the persisted value.
 */
export function useSaveIterationNote(groupId: string, iterationNumber: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (humanNote: string) =>
      apiRequest("PATCH", `/api/task-groups/${groupId}/iterations/${iterationNumber}`, {
        humanNote,
      }) as Promise<{ iterationNumber: number; humanNote: string | null }>,
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["/api/task-groups", groupId, "iterations", "detail", iterationNumber],
      });
    },
  });
}

/** The owner-gated { iteration, executions } detail for one round's iteration. */
export function useIterationDetail(groupId: string, iterationNumber: number | null) {
  return useQuery<IterationDetail>({
    queryKey: ["/api/task-groups", groupId, "iterations", "detail", iterationNumber],
    queryFn: () =>
      apiRequest(
        "GET",
        `/api/task-groups/${groupId}/iterations/${iterationNumber}`,
      ) as Promise<IterationDetail>,
    enabled: !!groupId && iterationNumber !== null && iterationNumber >= 1,
    refetchInterval: 3000,
  });
}
