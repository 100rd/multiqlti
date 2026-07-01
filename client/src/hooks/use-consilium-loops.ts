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
 * (error, testSummary, action-point titles, archetype rationale, engineer
 * instruction, and the research `report`) are model- or human-authored and MUST
 * be rendered as INERT React text by the consuming components.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/hooks/use-pipeline";
import type {
  ConsiliumLoopState,
  ConsiliumLoopRow,
  ConsiliumLoopRoundRow,
} from "@shared/schema";
import type {
  Archetype,
  ResearchReport,
  ResearchClaim,
  ResearchCitation,
  ResearchSource,
} from "@shared/types";

// ─── Types ──────────────────────────────────────────────────────────────────
// Re-export the schema row types under client-facing names. The list endpoint
// masks `createdBy` for non-admins, so that field is optional on the wire.

export type ConsiliumLoopListItem = Omit<ConsiliumLoopRow, "createdBy"> & {
  createdBy?: string | null;
};

/**
 * Live per-action-point progress of the loop's `developing` phase. Surfaced on
 * the loop GET as `devProgress` while the SDLC handoff runs (it is process-local
 * and ephemeral — a cross-instance / post-restart read simply omits it). EVERY
 * subfield is optional: an early beat (or a degraded read) may carry none, so
 * every consumer reads it defensively.
 */
export interface DevProgress {
  phase?: "coding" | "committing" | "pushing" | "opening_pr" | "done";
  actionPointIndex?: number;
  actionPointTotal?: number;
  actionPointTitle?: string;
  completedCount?: number;
}

/**
 * How the loop's archetype was decided (design §3.B / Stage 1, Piece B):
 *   • `proposed` — the planner model classified the verdict.
 *   • `override` — a human picked it via PATCH /:id/archetype.
 * Null/absent until the loop has been planned. Surfaced on the loop GET.
 */
export type ConsiliumArchetypeSource = "proposed" | "override";

// ─── Research report (Stage 3, RESEARCH archetype) ────────────────────────────
//
// A `research`-archetype loop produces a RESEARCHED REPORT rather than code / a
// Draft PR (design §3.C/§5/§6). The report is persisted on the loop's LATEST
// round (`consilium_loop_rounds.report` jsonb col) and rides the SAME loop GET
// `rounds[]` wire as `testSummary` — no new hook, no new endpoint. The loop still
// reaches `awaiting_merge`, but with `prRef: null` ("no PR — nothing to merge"),
// which the existing ResultPanel already handles.
//
// The canonical shape lives in the client-safe `@shared/types` module (so the UI
// can import it without pulling in drizzle/schema). It is re-exported here for
// the page's convenience. `report` is `null`/absent for every non-research loop
// (and pre-backend), so the UI treats its presence as the ONLY signal to render.
//
// SECURITY: `question`, `recommendation`, `verdict`, every `claim`, and all
// citation/source `title`/`snippet` strings are MODEL-authored (web-derived)
// output — rendered as INERT React text; every external `url` is opened with
// target="_blank" rel="noopener noreferrer".
export type { ResearchReport, ResearchClaim, ResearchCitation, ResearchSource };

/**
 * A loop round as seen by the client. It is the schema row (which already carries
 * the optional Stage-3 `report`); the `report?` here is a belt-and-braces
 * restatement so the type reads self-documenting at the call site and stays
 * resilient if the underlying row type ever narrows. A `ConsiliumLoopRoundDetail`
 * is structurally a `ConsiliumLoopRoundRow`, so every existing round consumer
 * keeps working unchanged.
 */
export type ConsiliumLoopRoundDetail = ConsiliumLoopRoundRow & {
  /** The research artifact, on the latest round of a `research` loop only. */
  report?: ResearchReport | null;
};

/**
 * The detail endpoint returns the loop fields spread WITH a `rounds` array and,
 * while the loop is `developing`, an optional `devProgress` snapshot.
 *
 * Stage 1 (Piece B) ALSO surfaces the planned-archetype + engineer-instruction
 * layer. These are STRICTLY ADDITIVE and OBSERVE-ONLY in Stage 1 — nothing
 * downstream branches on the archetype yet (that is Stage 2). Every field is
 * optional/nullable: an un-planned loop (or a backend that hasn't shipped the
 * planner) simply omits them, and every consumer renders them defensively.
 */
export type ConsiliumLoopDetail = ConsiliumLoopListItem & {
  rounds: ConsiliumLoopRoundDetail[];
  devProgress?: DevProgress;
  /** The classified/overridden archetype, or null when not yet planned. */
  archetype?: Archetype | null;
  /** Whether the archetype was model-`proposed` or human-`override`. */
  archetypeSource?: ConsiliumArchetypeSource | null;
  /** The planner's INERT, model-authored rationale for the classification. */
  archetypeRationale?: string | null;
  /** Free-form archetype params the planner extracted (INERT key/value text). */
  archetypeParams?: Record<string, string> | null;
  /** The optional human instruction captured at review creation (INERT text). */
  engineerInstruction?: string | null;
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

/**
 * The verdict-terminal states (design §9): a loop that finished its review phase
 * with a verdict still standing. ONLY these may be promoted into a visible
 * `developing` round via `POST /:id/develop` (failed/cancelled are excluded — a
 * cancelled or errored loop is not a verdict to execute).
 */
const VERDICT_TERMINAL_STATES: ReadonlySet<ConsiliumLoopState> =
  new Set<ConsiliumLoopState>(["converged", "stopped_cap", "escalated"]);

export function isVerdictTerminalLoopState(state: ConsiliumLoopState): boolean {
  return VERDICT_TERMINAL_STATES.has(state);
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

/**
 * Promote a verdict-terminal loop into a VISIBLE `developing` round (design §9):
 * "execute a verdict's action points" is no longer a hidden background job — it
 * becomes a real round on the loop, observed on this page's stepper.
 *
 * Owner-or-admin (the server gates with `authorizeConsiliumLoop`, NOT the
 * stricter merge gate). The server is the final arbiter: it 400s on
 * NO_ACTION_POINTS / REPO_NOT_* and 409s on WRONG_STATE / ACTIVE_LOOP_EXISTS /
 * CAS_LOST — `apiRequest` throws each as an Error whose message is the server
 * `error` string, surfaced verbatim by the caller. Until the backend endpoint
 * lands, a click 404s and is handled as a normal error toast.
 */
export function useDevelopLoop() {
  const qc = useQueryClient();
  return useMutation<ConsiliumLoopRow, Error, string>({
    mutationFn: (id) => apiRequest("POST", `${LIST_KEY}/${id}/develop`),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: [LIST_KEY, id] });
      qc.invalidateQueries({ queryKey: [LIST_KEY] });
    },
  });
}

// ─── Planning (Stage 1, Piece B) ──────────────────────────────────────────────

/**
 * Classify a loop's verdict into a planning archetype (design §3.B). The planner
 * is a lightweight model call owned by the controller; it is IDEMPOTENT — a loop
 * already carrying an archetype is returned unchanged unless `replan` re-runs it
 * (`?replan=1`). It reads the SAME verdict source `/develop` uses, so it is only
 * meaningful once the latest round has a readable verdict.
 *
 * Stage 1 is OBSERVE-AND-SET only: the returned archetype is displayed but
 * nothing downstream branches on it (that is Stage 2). The mutation argument is
 * the loop id; pass `{ id, replan: true }` to force a re-classification.
 *
 * BENIGN until the backend lands: the endpoint 404s pre-backend. Callers that
 * auto-fire this (the lazy-classify effect) MUST treat any failure as silent and
 * non-blocking — a missing planner never breaks the page.
 */
export function usePlanLoop() {
  const qc = useQueryClient();
  return useMutation<ConsiliumLoopDetail, Error, { id: string; replan?: boolean }>({
    mutationFn: ({ id, replan }) =>
      apiRequest(
        "POST",
        `${LIST_KEY}/${id}/plan${replan ? "?replan=1" : ""}`,
      ),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: [LIST_KEY, id] });
      qc.invalidateQueries({ queryKey: [LIST_KEY] });
    },
  });
}

/**
 * Human override of the loop's archetype (design §3.B). Owner-or-admin, no model
 * call — the server validates the body against the `ARCHETYPES` enum and records
 * `archetypeSource = 'override'`. The argument carries the loop id plus the
 * chosen archetype.
 *
 * BENIGN until the backend lands: a pre-backend PATCH 404s; the caller surfaces
 * the server `error` text verbatim as a toast (it does not crash the page).
 */
export function useSetArchetype() {
  const qc = useQueryClient();
  return useMutation<ConsiliumLoopDetail, Error, { id: string; archetype: Archetype }>({
    mutationFn: ({ id, archetype }) =>
      apiRequest("PATCH", `${LIST_KEY}/${id}/archetype`, { archetype }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: [LIST_KEY, id] });
      qc.invalidateQueries({ queryKey: [LIST_KEY] });
    },
  });
}
