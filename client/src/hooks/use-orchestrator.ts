/**
 * React-query hooks for the debate-research orchestrator (additive 3rd run mode).
 *
 * Mirrors use-news.ts: typed queries/mutations over the REST surface in
 * server/routes/orchestrator.ts, reusing the shared `apiRequest` (auth header +
 * error throwing) — no duplicated fetch logic. Live progress comes from the
 * existing WS channel: the orchestrator broadcasts run-scoped `orchestrator:*`
 * events (plan / completed / failed / cancelled); we subscribe and invalidate
 * the status query on each, so step statuses refresh as the run advances. No
 * dedicated per-step WS event exists, so refetch-on-event is the source of
 * truth (same WS-driven-invalidate pattern as the rest of the run UI).
 *
 * SECURITY: all of these endpoints are owner-scoped server-side; the shared
 * apiRequest attaches the auth token. Every string in the returned payloads is
 * UNTRUSTED — see lib/orchestrator.ts and the component headers.
 */
import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { wsClient } from "@/lib/websocket";
import type {
  OrchestratorStatus,
  OrchestratorDebate,
  OrchestratorResearch,
  OrchestratorCapsInput,
  OrchestratorStepArgs,
} from "@/lib/orchestrator";
import { isRunTerminal } from "@/lib/orchestrator";

// ─── Query keys ─────────────────────────────────────────────────────────────────

export const orchestratorKeys = {
  status: (runId: string) => ["/api/runs", runId, "orchestrator"] as const,
  debates: (runId: string) =>
    ["/api/runs", runId, "orchestrator", "debates"] as const,
  research: (runId: string) =>
    ["/api/runs", runId, "orchestrator", "research"] as const,
};

async function getJson<T>(url: string): Promise<T> {
  const res = await apiRequest("GET", url);
  return (await res.json()) as T;
}

// ─── Status (run + steps + token total) ─────────────────────────────────────────

/**
 * GET /api/runs/:id/orchestrator. While the run is non-terminal we keep a slow
 * safety-net poll (WS invalidation does the fast updating; the poll covers a
 * dropped socket). Stops once the run settles.
 */
const ACTIVE_POLL_MS = 8_000;

export function useOrchestratorStatus(runId: string) {
  return useQuery<OrchestratorStatus>({
    queryKey: orchestratorKeys.status(runId),
    queryFn: () =>
      getJson<OrchestratorStatus>(`/api/runs/${runId}/orchestrator`),
    enabled: !!runId,
    refetchInterval: (query) =>
      isRunTerminal(query.state.data?.orchestratorRun) ? false : ACTIVE_POLL_MS,
  });
}

// ─── Debates ──────────────────────────────────────────────────────────────────

interface DebatesEnvelope {
  runId: string;
  debates: OrchestratorDebate[];
}

/** GET /api/runs/:id/orchestrator/debates — read-only transcripts. */
export function useOrchestratorDebates(runId: string, enabled = true) {
  return useQuery<OrchestratorDebate[]>({
    queryKey: orchestratorKeys.debates(runId),
    queryFn: async () => {
      const env = await getJson<DebatesEnvelope>(
        `/api/runs/${runId}/orchestrator/debates`,
      );
      return env.debates ?? [];
    },
    enabled: !!runId && enabled,
  });
}

// ─── Research ───────────────────────────────────────────────────────────────────

interface ResearchEnvelope {
  runId: string;
  research: OrchestratorResearch[];
}

/** GET /api/runs/:id/orchestrator/research — cited findings + fetch counts. */
export function useOrchestratorResearch(runId: string, enabled = true) {
  return useQuery<OrchestratorResearch[]>({
    queryKey: orchestratorKeys.research(runId),
    queryFn: async () => {
      const env = await getJson<ResearchEnvelope>(
        `/api/runs/${runId}/orchestrator/research`,
      );
      return env.research ?? [];
    },
    enabled: !!runId && enabled,
  });
}

// ─── Start ──────────────────────────────────────────────────────────────────────

export interface StartOrchestratorInput {
  task: string;
  needs?: string;
  workspaceId?: string;
  caps?: OrchestratorCapsInput;
}

export interface StartOrchestratorResult {
  runId: string;
  orchestratorRunId: string;
  status: "awaiting_plan_approval";
  plan: OrchestratorStepArgs[];
}

/**
 * POST /api/runs/orchestrator — starts a run and pauses at the plan gate.
 * A 503 (orchestrator disabled) surfaces as a thrown Error the caller inspects
 * with isOrchestratorDisabledError().
 */
export function useStartOrchestrator() {
  const qc = useQueryClient();
  return useMutation<StartOrchestratorResult, Error, StartOrchestratorInput>({
    mutationFn: async (input) => {
      const res = await apiRequest("POST", "/api/runs/orchestrator", input);
      return (await res.json()) as StartOrchestratorResult;
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: orchestratorKeys.status(result.runId) });
      qc.invalidateQueries({ queryKey: ["/api/runs"] });
    },
  });
}

// ─── Approve / reject plan ────────────────────────────────────────────────────

export interface ApprovePlanInput {
  runId: string;
  /** Optional edited plan; re-validated + re-clamped server-side (H3). */
  steps?: OrchestratorStepArgs[];
  caps?: OrchestratorCapsInput;
  approvedBy?: string;
}

/** POST /api/runs/:id/orchestrator/approve-plan. */
export function useApproveOrchestratorPlan() {
  const qc = useQueryClient();
  return useMutation<{ status: string }, Error, ApprovePlanInput>({
    mutationFn: async ({ runId, steps, caps, approvedBy }) => {
      const body: Record<string, unknown> = {};
      if (steps) body.steps = steps;
      if (caps) body.caps = caps;
      if (approvedBy) body.approvedBy = approvedBy;
      const res = await apiRequest(
        "POST",
        `/api/runs/${runId}/orchestrator/approve-plan`,
        body,
      );
      return (await res.json()) as { status: string };
    },
    onSuccess: (_data, { runId }) => {
      qc.invalidateQueries({ queryKey: orchestratorKeys.status(runId) });
    },
  });
}

/** POST /api/runs/:id/orchestrator/reject-plan — the reject side of the gate. */
export function useRejectOrchestratorPlan() {
  const qc = useQueryClient();
  return useMutation<{ status: string }, Error, { runId: string }>({
    mutationFn: async ({ runId }) => {
      const res = await apiRequest(
        "POST",
        `/api/runs/${runId}/orchestrator/reject-plan`,
      );
      return (await res.json()) as { status: string };
    },
    onSuccess: (_data, { runId }) => {
      qc.invalidateQueries({ queryKey: orchestratorKeys.status(runId) });
    },
  });
}

/** POST /api/runs/:id/cancel — the existing run-cancel endpoint. */
export function useCancelOrchestratorRun() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { runId: string }>({
    mutationFn: ({ runId }) => apiRequest("POST", `/api/runs/${runId}/cancel`),
    onSuccess: (_data, { runId }) => {
      qc.invalidateQueries({ queryKey: orchestratorKeys.status(runId) });
      qc.invalidateQueries({ queryKey: ["/api/runs"] });
    },
  });
}

// ─── Live WS bridge ───────────────────────────────────────────────────────────

const ORCHESTRATOR_EVENT_PREFIX = "orchestrator:";

/**
 * Subscribe to a run's WS channel and invalidate the orchestrator queries on
 * each run-scoped `orchestrator:*` event (plan, completed, failed, cancelled) —
 * and on the shared `stage:progress` event — so the live progress, debates, and
 * research refresh as the run advances. The orchestrator's event types are not
 * in the typed WsEventType union, so we filter onAny() by the string prefix.
 */
export function useOrchestratorLiveUpdates(runId: string): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!runId) return;
    wsClient.connect();
    wsClient.subscribe(runId);

    const unsub = wsClient.onAny((event) => {
      if (event.runId !== runId) return;
      const isOrchestratorEvent =
        typeof event.type === "string" &&
        event.type.startsWith(ORCHESTRATOR_EVENT_PREFIX);
      if (!isOrchestratorEvent && event.type !== "stage:progress") return;

      qc.invalidateQueries({ queryKey: orchestratorKeys.status(runId) });
      qc.invalidateQueries({ queryKey: orchestratorKeys.debates(runId) });
      qc.invalidateQueries({ queryKey: orchestratorKeys.research(runId) });
    });

    return () => {
      unsub();
      wsClient.unsubscribe(runId);
    };
  }, [runId, qc]);
}
