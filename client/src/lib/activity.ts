/**
 * Pure helpers + UI-facing types for the read-only "Live Activity" debugging
 * lens (GET /api/activity + the live WS deltas) AND the Activity History tab
 * (GET /api/activity/history, keyset-paginated).
 *
 * Mirrors the lib/orchestrator.ts / lib/news.ts model: the page + hook are thin,
 * and the logic that actually matters — the multi-run merge-by-runId reducer
 * that folds live WS deltas onto the polled snapshot, the mode grouping, the
 * runId set for ownership-scoped subscription, the history page concatenation,
 * and the small display helpers — lives here as pure functions that are
 * unit-tested without a DOM renderer (the repo has no jsdom; see
 * tests/unit/orchestrator-ui.test.ts).
 *
 * SECURITY: every field surfaced through the Activity lens is metadata only and
 * ENUM/system-derived (mode, status, agent/team id, model slug, ids). The
 * backend already strips transcripts/prompts/task text. Components still render
 * every string as INERT React text (never via dangerouslySetInnerHTML).
 */
import type {
  ActivityRun,
  ActivitySnapshot,
  ActivityMode,
  ActivityHistoryRow,
  ActivityHistoryPage,
  WsEvent,
} from "@shared/types";

export type {
  ActivityRun,
  ActivitySnapshot,
  ActivityMode,
  ActivityHistoryRow,
  ActivityHistoryPage,
};

/** The fixed display order of the mode groups on the page. */
export const ACTIVITY_MODE_ORDER: readonly ActivityMode[] = [
  "pipeline",
  "manager",
  "orchestrator",
  "consensus",
  "task_group",
] as const;

/** Human label for each mode group. */
export const ACTIVITY_MODE_LABELS: Record<ActivityMode, string> = {
  pipeline: "Pipelines",
  manager: "Manager loops",
  orchestrator: "Orchestrator runs",
  consensus: "Consensus runs",
  task_group: "Task groups",
};

/** A mode group with its rows, ready to render. */
export interface ActivityGroup {
  mode: ActivityMode;
  label: string;
  runs: ActivityRun[];
}

/**
 * Group the rows by mode in the fixed ACTIVITY_MODE_ORDER. Empty groups are
 * omitted so the page only renders modes that actually have active runs.
 */
export function groupByMode(runs: readonly ActivityRun[]): ActivityGroup[] {
  return ACTIVITY_MODE_ORDER.map((mode) => ({
    mode,
    label: ACTIVITY_MODE_LABELS[mode],
    runs: runs.filter((r) => r.mode === mode),
  })).filter((g) => g.runs.length > 0);
}

/** A history mode group with its rows, ready to render. */
export interface ActivityHistoryGroup {
  mode: ActivityMode;
  label: string;
  rows: ActivityHistoryRow[];
}

/**
 * Group history rows by mode in the same fixed order. Empty modes are omitted.
 * Rows within a mode keep their server order (newest-first keyset order).
 */
export function groupHistoryByMode(
  rows: readonly ActivityHistoryRow[],
): ActivityHistoryGroup[] {
  return ACTIVITY_MODE_ORDER.map((mode) => ({
    mode,
    label: ACTIVITY_MODE_LABELS[mode],
    rows: rows.filter((r) => r.mode === mode),
  })).filter((g) => g.rows.length > 0);
}

/**
 * The set of runIds the caller is allowed to subscribe to over WS. The server
 * now rejects subscribing to runs you don't own, so this is exactly the snapshot
 * rows — never a guessed/derived id.
 */
export function snapshotRunIds(runs: readonly ActivityRun[]): string[] {
  return runs.map((r) => r.runId);
}

/** Read a string field from an untrusted WS payload, or null. */
function payloadString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const v = payload[key];
  return typeof v === "string" ? v : null;
}

/** Read a finite number field from an untrusted WS payload, or null. */
function payloadNumber(
  payload: Record<string, unknown>,
  key: string,
): number | null {
  const v = payload[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A row carrying the live pulse timestamp the page uses to show "live now". */
export interface LiveActivityRun extends ActivityRun {
  /** Epoch ms of the last live WS delta merged onto this row; undefined if none. */
  lastDeltaAt?: number;
}

/** The WS event types that keep a row feeling live between snapshot refetches. */
const LIVE_EVENT_TYPES: ReadonlySet<WsEvent["type"]> = new Set<WsEvent["type"]>([
  "stage:progress",
  "manager:decision",
  "orchestrator:step",
  // task_group deltas: the orchestrator broadcasts these with runId = groupId.
  "task:started",
  "task:completed",
  "task:failed",
  "taskgroup:started",
  "taskgroup:progress",
]);

/**
 * Immutably merge a single live WS event onto the current rows, keyed by
 * `event.runId`. The additive live signals merged are:
 *
 *  - `stage:progress`     → refreshes currentUnit.modelSlug, marks "running",
 *                           bumps the live `lastDeltaAt` pulse.
 *  - `manager:decision`   → refreshes currentUnit.modelSlug + agent (teamId),
 *                           marks "running", bumps the pulse.
 *  - `orchestrator:step`  → updates currentUnit.label/agent/modelSlug/status from
 *                           the step metadata, bumps the pulse.
 *  - `task:started`/`task:completed`/`task:failed`/`taskgroup:started`/
 *    `taskgroup:progress` (mode `task_group`, runId = groupId) → updates the
 *    current task label/agent (team)/model/status, bumps the pulse. The snapshot
 *    remains the source of truth for which group is active.
 *
 * Events for a runId NOT present in the snapshot are ignored (we only know about
 * — and only subscribe to — runs the snapshot returned). Events without a runId,
 * or of any other type, are passed through unchanged. The function never mutates
 * its input and never throws on a malformed payload.
 *
 * The merge is intentionally additive/best-effort: the periodic snapshot refetch
 * is the source of truth (it adds/removes rows); WS deltas only keep already-known
 * rows feeling live between refetches. Consensus emits no WS events, so consensus
 * rows are refresh-only by construction.
 */
export function mergeWsEvent(
  runs: readonly LiveActivityRun[],
  event: WsEvent,
  /** Monotonic timestamp (ms) used for the live pulse; injectable for tests. */
  now: number = Date.now(),
): LiveActivityRun[] {
  const runId = event.runId;
  if (!runId) return runs as LiveActivityRun[];
  if (!LIVE_EVENT_TYPES.has(event.type)) {
    return runs as LiveActivityRun[];
  }

  const idx = runs.findIndex((r) => r.runId === runId);
  if (idx === -1) return runs as LiveActivityRun[];

  const next = applyDelta(runs[idx], event, now);
  const copy = runs.slice();
  copy[idx] = next;
  return copy;
}

function applyDelta(
  row: LiveActivityRun,
  event: WsEvent,
  now: number,
): LiveActivityRun {
  const payload = event.payload ?? {};
  const prevUnit = row.currentUnit;

  if (event.type === "orchestrator:step") {
    const label = stepIndexLabel(payloadNumber(payload, "stepIndex"));
    const type = payloadString(payload, "type");
    const status =
      payloadString(payload, "status") ?? prevUnit?.status ?? "running";
    return {
      ...row,
      currentUnit: {
        label: label ?? prevUnit?.label ?? "Step",
        agent: type ?? prevUnit?.agent ?? "orchestrator",
        modelSlug:
          payloadString(payload, "modelSlug") ?? prevUnit?.modelSlug ?? null,
        status,
      },
      lastDeltaAt: now,
    };
  }

  // task_group deltas (runId = groupId). The current "unit" is the task in
  // motion; we surface its enum-derived name/team/model/status as metadata.
  if (
    event.type === "task:started" ||
    event.type === "task:completed" ||
    event.type === "task:failed" ||
    event.type === "taskgroup:started" ||
    event.type === "taskgroup:progress"
  ) {
    return applyTaskGroupDelta(row, event, payload, now);
  }

  // stage:progress / manager:decision: keep the snapshot-derived label, refresh
  // the model + mark running. manager:decision also re-attributes the agent when
  // the payload carries a teamId.
  const teamId = payloadString(payload, "teamId");
  const modelSlug = payloadString(payload, "modelSlug");
  const baseUnit =
    prevUnit ?? { label: row.title, agent: "agent", modelSlug: null, status: "running" };

  return {
    ...row,
    currentUnit: {
      label: baseUnit.label,
      agent:
        event.type === "manager:decision" && teamId ? teamId : baseUnit.agent,
      modelSlug: modelSlug ?? baseUnit.modelSlug,
      status: "running",
    },
    lastDeltaAt: now,
  };
}

/**
 * Fold a task-group WS delta onto the row's currentUnit. Metadata only:
 * task name (label), team (agent), model slug, and an enum-derived status. Per-
 * event-type status so a completed/failed task pulses with the right colour;
 * taskgroup:* envelope events keep the prior unit but still pulse "live".
 */
function applyTaskGroupDelta(
  row: LiveActivityRun,
  event: WsEvent,
  payload: Record<string, unknown>,
  now: number,
): LiveActivityRun {
  const prevUnit = row.currentUnit;
  const base = prevUnit ?? {
    label: row.title,
    agent: "task",
    modelSlug: null,
    status: "running",
  };

  // Envelope events carry no per-task fields → keep the unit, just pulse.
  if (event.type === "taskgroup:started" || event.type === "taskgroup:progress") {
    return { ...row, currentUnit: { ...base }, lastDeltaAt: now };
  }

  const name = payloadString(payload, "name");
  const teamId = payloadString(payload, "teamId");
  const modelSlug = payloadString(payload, "modelSlug");
  const status =
    event.type === "task:completed"
      ? "completed"
      : event.type === "task:failed"
        ? "failed"
        : "running";

  return {
    ...row,
    currentUnit: {
      label: name ?? base.label,
      agent: teamId ?? base.agent,
      modelSlug: modelSlug ?? base.modelSlug,
      status,
    },
    lastDeltaAt: now,
  };
}

/** "Step 0" → "Step 1" (1-based, human) for an orchestrator step index. */
function stepIndexLabel(stepIndex: number | null): string | null {
  if (stepIndex === null) return null;
  return `Step ${stepIndex + 1}`;
}

/** Freshness window for the "live now" pulse. */
export const LIVE_PULSE_WINDOW_MS = 10_000;

/**
 * Whether a row counts as "live now": it has had a WS delta within the freshness
 * window. Pure so the page can decide the pulse without a clock side-effect.
 */
export function isLiveNow(
  row: LiveActivityRun,
  now: number = Date.now(),
): boolean {
  return (
    typeof row.lastDeltaAt === "number" &&
    now - row.lastDeltaAt <= LIVE_PULSE_WINDOW_MS
  );
}

/** Display a model slug, or an em-dash placeholder when unknown. */
export function displayModel(modelSlug: string | null | undefined): string {
  return modelSlug && modelSlug.length > 0 ? modelSlug : "—";
}

// ─── Activity History (keyset pagination) ──────────────────────────────────────

/** Accumulated history state the hook/page consume. */
export interface HistoryState {
  items: ActivityHistoryRow[];
  nextCursor: string | null;
  isAdmin: boolean;
}

/** Empty starting state before the first page lands. */
export function emptyHistoryState(): HistoryState {
  return { items: [], nextCursor: null, isAdmin: false };
}

/** Stable de-dupe key for a history row (runId is groupId for task_group). */
export function historyRowKey(row: ActivityHistoryRow): string {
  return `${row.mode}:${row.runId}`;
}

/**
 * Fold one fetched page onto the accumulated history state. The first page
 * (cursor === null in the request) REPLACES the list; subsequent pages APPEND.
 * De-dupes by `${mode}:${runId}` so a row that straddles a keyset boundary (or a
 * re-fetched first page) is never shown twice. Never mutates its inputs.
 *
 * `isFirstPage` mirrors "the request carried no cursor": true on initial load /
 * refresh, false when paging with a nextCursor.
 */
export function appendHistoryPage(
  prev: HistoryState,
  page: ActivityHistoryPage,
  isFirstPage: boolean,
): HistoryState {
  const baseItems = isFirstPage ? [] : prev.items;
  const seen = new Set(baseItems.map(historyRowKey));
  const merged = baseItems.slice();
  for (const row of page.items) {
    const key = historyRowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return {
    items: merged,
    nextCursor: page.nextCursor,
    isAdmin: page.isAdmin,
  };
}

/** Whether there is another page to load. */
export function hasMoreHistory(state: HistoryState): boolean {
  return state.nextCursor !== null;
}

/**
 * Build the `GET /api/activity/history` query string from page params. `limit`
 * is clamped to the server's ≤100 ceiling defensively; `cursor`/`mode` are only
 * appended when present. Returns the leading "?" or "" when empty.
 */
export function buildHistoryQuery(params: {
  limit?: number;
  cursor?: string | null;
  mode?: ActivityMode | null;
}): string {
  const search = new URLSearchParams();
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    const clamped = Math.max(1, Math.min(100, Math.floor(params.limit)));
    search.set("limit", String(clamped));
  }
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.mode) search.set("mode", params.mode);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}
