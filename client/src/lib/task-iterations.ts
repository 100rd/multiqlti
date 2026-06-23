/**
 * Pure helpers + UI-facing types for the Task Groups v2 Iterations panel
 * (GET …/iterations keyset list, GET …/iterations/:n detail).
 *
 * Mirrors lib/activity.ts: the page + hook stay thin, and the logic that matters
 * — the keyset page concatenation (de-duped by iteration number), the
 * run-enabled / edit-enabled gating, the "Run" vs "Run again" label, and the
 * small display helpers — lives here as pure functions that are unit-tested
 * without a DOM renderer (the repo has no jsdom; see
 * tests/unit/task-iterations-logic.test.ts).
 *
 * SECURITY: the iteration LIST is metadata-only by server allowlist (status /
 * timing / counts; triggeredBy is admin-only). `input`/`output`/`summary` never
 * appear in the list — only the owner-gated DETAIL exposes per-task summary/error
 * (rendered as INERT React text, never via dangerouslySetInnerHTML).
 */

/** One row of the metadata-only iteration list (server `IterationSummary`). */
export interface IterationSummary {
  iterationNumber: number;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  completedCount: number;
  taskCount: number;
  /** ADMIN-ONLY (absent for non-admins). */
  triggeredBy?: string | null;
}

/** One page of the keyset-paginated iteration list. */
export interface IterationListPage {
  items: IterationSummary[];
  nextCursor: string | null;
}

/** A single iteration execution row from the owner-gated DETAIL response. */
export interface IterationExecution {
  id: string;
  taskId: string | null;
  taskName: string | null;
  status: string;
  summary: string | null;
  errorMessage: string | null;
  output: unknown;
  modelSlug: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** The owner-gated iteration DETAIL: the iteration row + its per-task executions. */
export interface IterationDetail {
  iteration: {
    id: string;
    iterationNumber: number;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    /** Human-in-the-loop note; folded into the NEXT iteration's input. */
    humanNote?: string | null;
  };
  executions: IterationExecution[];
}

/** The accumulated, paged iteration-list state the hook/page consume. */
export interface IterationListState {
  items: IterationSummary[];
  nextCursor: string | null;
}

/** Empty starting state before the first page lands. */
export function emptyIterationListState(): IterationListState {
  return { items: [], nextCursor: null };
}

/**
 * Fold one fetched page onto the accumulated iteration-list state. The first page
 * (cursor === null in the request) REPLACES the list; subsequent pages APPEND.
 * De-dupes by `iterationNumber` so a row that straddles a keyset boundary (or a
 * re-fetched first page) is never shown twice. The combined list stays sorted
 * newest-first (descending iterationNumber), matching the server's keyset order.
 * Never mutates its inputs.
 */
export function appendIterationPage(
  prev: IterationListState,
  page: IterationListPage,
  isFirstPage: boolean,
): IterationListState {
  const base = isFirstPage ? [] : prev.items;
  const seen = new Set(base.map((it) => it.iterationNumber));
  const merged = base.slice();
  for (const row of page.items) {
    if (seen.has(row.iterationNumber)) continue;
    seen.add(row.iterationNumber);
    merged.push(row);
  }
  merged.sort((a, b) => b.iterationNumber - a.iterationNumber);
  return { items: merged, nextCursor: page.nextCursor };
}

/** Whether there is another page to load. */
export function hasMoreIterations(state: IterationListState): boolean {
  return state.nextCursor !== null;
}

/**
 * Build the `GET …/iterations` query string. `limit` is clamped to the server's
 * ≤100 ceiling defensively; `cursor` is appended only when present. Returns the
 * leading "?" or "" when empty.
 */
export function buildIterationsQuery(params: {
  limit?: number;
  cursor?: string | null;
}): string {
  const search = new URLSearchParams();
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    const clamped = Math.max(1, Math.min(100, Math.floor(params.limit)));
    search.set("limit", String(clamped));
  }
  if (params.cursor) search.set("cursor", params.cursor);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

// ─── Run / Edit gating (FE2) ──────────────────────────────────────────────────

const TERMINAL_ITERATION_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * The effective "is an iteration actively running" signal, derived from the
 * iteration list. The list is newest-first, so the first row is the latest
 * iteration. A `running` latest iteration means a run is in flight.
 *
 * The live group status (from the WS group projection) takes precedence when
 * provided: it annotates the active iteration faster than the polled list.
 */
export function isIterationRunning(
  iterations: readonly IterationSummary[],
  liveGroupStatus?: string | null,
): boolean {
  if (liveGroupStatus === "running") return true;
  const latest = iterations[0];
  if (!latest) return false;
  if (TERMINAL_ITERATION_STATUSES.has(latest.status)) return false;
  return latest.status === "running";
}

/**
 * Whether the "Run" button is enabled: only when NO iteration is actively
 * running (§4.1 active-iteration guard; the server still 409s on a race). The
 * server also 400s when there are no ready tasks and 409s at the iteration cap —
 * those are surfaced as toasts, not pre-disabled here.
 */
export function isRunEnabled(
  iterations: readonly IterationSummary[],
  liveGroupStatus?: string | null,
): boolean {
  return !isIterationRunning(iterations, liveGroupStatus);
}

/**
 * Whether the group's definitions are editable: editable whenever NO iteration is
 * running (§4.2 — a group that completed iteration 1 is editable again to set up
 * iteration 2). The server enforces this with a persist-time re-read; the FE only
 * avoids showing controls that would 409.
 */
export function isEditEnabled(
  iterations: readonly IterationSummary[],
  liveGroupStatus?: string | null,
): boolean {
  return !isIterationRunning(iterations, liveGroupStatus);
}

/**
 * The header run-button label: "Run" before any iteration exists, "Run again"
 * once at least one iteration has been recorded (§7.1).
 */
export function runButtonLabel(iterations: readonly IterationSummary[]): string {
  return iterations.length > 0 ? "Run again" : "Run";
}

/**
 * Translate a `POST …/start` failure into the toast message the UI shows. The
 * server returns 409 for an already-running iteration OR the iteration cap, and
 * 400 when there are no ready tasks. Anything else surfaces the server message.
 * Mirrors the editErrorMessage idiom in use-task-groups.
 */
export function startErrorMessage(status: number, serverMessage?: string): string {
  if (status === 409) {
    if (serverMessage && /cap/i.test(serverMessage)) {
      return "Iteration cap reached for this group.";
    }
    return serverMessage || "An iteration is already running.";
  }
  if (status === 400) {
    return serverMessage || "No ready tasks to run.";
  }
  return serverMessage || "Failed to start the run.";
}
