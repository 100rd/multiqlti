/**
 * use-consilium-loops.ts — react-query surface for the Consilium Loop (design §7,
 * HTTP routes in server/routes/consilium-loops.ts).
 *
 * Mirrors use-pipeline.ts: shared `apiRequest`, URL-keyed query keys, mutations
 * that invalidate the relevant queries. Live state is observed with a LIGHT poll
 * (the loop FSM advances server-side via the background poller — there is no WS
 * channel for loops yet), gated off once the loop reaches a terminal state.
 *
 * SECURITY: this module only fetches + types data. All loop/round text fields
 * (error, testSummary, action-point titles) are model/loop-authored and MUST be
 * rendered as INERT React text by the consuming components.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/hooks/use-pipeline";
import type {
  ConsiliumLoopState,
  ConsiliumLoopRow,
  ConsiliumLoopRoundRow,
} from "@shared/schema";

// ─── Types ──────────────────────────────────────────────────────────────────
// Re-export the schema row types under client-facing names. The list endpoint
// masks `createdBy` for non-admins, so that field is optional on the wire.

export type ConsiliumLoopListItem = Omit<ConsiliumLoopRow, "createdBy"> & {
  createdBy?: string | null;
};

/** The detail endpoint returns the loop fields spread WITH a `rounds` array. */
export type ConsiliumLoopDetail = ConsiliumLoopListItem & {
  rounds: ConsiliumLoopRoundRow[];
};

export type { ConsiliumLoopState, ConsiliumLoopRow, ConsiliumLoopRoundRow };

/** The terminal states — a loop here never ticks again, so we stop polling. */
const TERMINAL_STATES: ReadonlySet<ConsiliumLoopState> = new Set<ConsiliumLoopState>([
  "converged",
  "stopped_cap",
  "escalated",
  "failed",
  "cancelled",
]);

export function isTerminalLoopState(state: ConsiliumLoopState): boolean {
  return TERMINAL_STATES.has(state);
}

const LIST_KEY = "/api/consilium-loops";

// ─── Queries ────────────────────────────────────────────────────────────────

/** List the caller's loops; light 5s poll as a WS-less live-state backstop. */
export function useConsiliumLoops() {
  return useQuery<ConsiliumLoopListItem[]>({
    queryKey: [LIST_KEY],
    queryFn: () => apiRequest("GET", LIST_KEY),
    refetchInterval: 5000,
  });
}

/**
 * Loop detail + rounds. Polls every 5s WHILE the loop is non-terminal, then
 * stops once it settles (the query data drives the interval).
 */
export function useConsiliumLoop(id: string | undefined) {
  return useQuery<ConsiliumLoopDetail>({
    queryKey: [LIST_KEY, id],
    queryFn: () => apiRequest("GET", `${LIST_KEY}/${id}`),
    enabled: !!id,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && isTerminalLoopState(data.state)) return false;
      return 5000;
    },
  });
}

// ─── Mutations ──────────────────────────────────────────────────────────────

export interface CreateLoopInput {
  groupId: string;
  repoPath: string;
  devPipelineId?: string;
  maxRounds?: number;
  lastReviewedCommit?: string;
}

export function useCreateConsiliumLoop() {
  const qc = useQueryClient();
  return useMutation<ConsiliumLoopRow, Error, CreateLoopInput>({
    mutationFn: (data) => apiRequest("POST", LIST_KEY, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [LIST_KEY] });
    },
  });
}

export function useStartLoop() {
  const qc = useQueryClient();
  return useMutation<ConsiliumLoopRow, Error, string>({
    mutationFn: (id) => apiRequest("POST", `${LIST_KEY}/${id}/start`),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: [LIST_KEY, id] });
      qc.invalidateQueries({ queryKey: [LIST_KEY] });
    },
  });
}

export function useCancelLoop() {
  const qc = useQueryClient();
  return useMutation<ConsiliumLoopRow, Error, string>({
    mutationFn: (id) => apiRequest("POST", `${LIST_KEY}/${id}/cancel`),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: [LIST_KEY, id] });
      qc.invalidateQueries({ queryKey: [LIST_KEY] });
    },
  });
}

/**
 * The HITL gate. Server-enforced maintainer/admin only — a plain owner gets 403,
 * which `apiRequest` throws as an Error (the caller surfaces a role-aware toast).
 */
export function useApproveMerge() {
  const qc = useQueryClient();
  return useMutation<ConsiliumLoopRow, Error, string>({
    mutationFn: (id) => apiRequest("POST", `${LIST_KEY}/${id}/merge-approved`),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: [LIST_KEY, id] });
      qc.invalidateQueries({ queryKey: [LIST_KEY] });
    },
  });
}
