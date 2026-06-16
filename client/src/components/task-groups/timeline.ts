/**
 * Pure helper that turns a task group's tasks into a read-only execution
 * timeline for the TaskGroup page. Timeline-oriented and metadata-only: it
 * surfaces statuses, durations, model/team and the start/end timestamps — never
 * summary or error text (those stay behind the owner-gated detail in the page,
 * which already comes from the owner-scoped GET :id).
 *
 * Unit-tested without a DOM renderer (the repo has no jsdom; see
 * tests/unit/task-form.test.ts which also covers buildTimeline).
 */

/** Minimal task shape the timeline needs (subset of the GET :id task rows). */
export interface TimelineTaskInput {
  id: string;
  name: string;
  status: string;
  executionMode?: string | null;
  modelSlug?: string | null;
  teamId?: string | null;
  sortOrder?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

/** One row of the rendered timeline. */
export interface TimelineEntry {
  id: string;
  name: string;
  status: string;
  executionMode: string | null;
  modelSlug: string | null;
  teamId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Wall-clock duration in ms when both timestamps are present, else null. */
  durationMs: number | null;
  /** True iff the task has actually started (has a startedAt). */
  hasRun: boolean;
}

const TERMINAL: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** Parse an ISO timestamp to epoch ms, or null when absent/unparseable. */
function toEpoch(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Compute the duration of a task in ms. Uses startedAt→completedAt when both
 * exist; returns null otherwise (a running task with no completedAt has no
 * fixed duration, and the page renders "running"/"—" instead).
 */
export function taskDurationMs(task: TimelineTaskInput): number | null {
  const start = toEpoch(task.startedAt);
  const end = toEpoch(task.completedAt);
  if (start === null || end === null) return null;
  const delta = end - start;
  return delta >= 0 ? delta : null;
}

/**
 * Build the chronological timeline. Ordering rule:
 *  1. Tasks that have started are ordered by startedAt ascending.
 *  2. Tasks that have NOT started come after, ordered by sortOrder ascending
 *     (their authored order), so a pending group still shows a stable timeline.
 * The sort is stable for ties. Never mutates the input array.
 */
export function buildTimeline(
  tasks: readonly TimelineTaskInput[],
): TimelineEntry[] {
  const entries = tasks.map((t) => {
    const startedAt = t.startedAt ?? null;
    return {
      id: t.id,
      name: t.name,
      status: t.status,
      executionMode: t.executionMode ?? null,
      modelSlug: t.modelSlug ?? null,
      teamId: t.teamId ?? null,
      startedAt,
      completedAt: t.completedAt ?? null,
      durationMs: taskDurationMs(t),
      hasRun: startedAt !== null,
      _start: toEpoch(startedAt),
      _sort: typeof t.sortOrder === "number" ? t.sortOrder : 0,
    };
  });

  entries.sort((a, b) => {
    // started tasks first, ordered by start time
    if (a._start !== null && b._start !== null) return a._start - b._start;
    if (a._start !== null) return -1;
    if (b._start !== null) return 1;
    // neither started → authored order
    return a._sort - b._sort;
  });

  return entries.map(({ _start, _sort, ...entry }) => entry);
}

/** Whether every task in the timeline has reached a terminal state. */
export function isTimelineComplete(entries: readonly TimelineEntry[]): boolean {
  return entries.length > 0 && entries.every((e) => TERMINAL.has(e.status));
}

/** Total wall-clock span (earliest start → latest end) in ms, or null. */
export function timelineSpanMs(
  entries: readonly TimelineEntry[],
): number | null {
  const starts = entries
    .map((e) => toEpoch(e.startedAt))
    .filter((n): n is number => n !== null);
  const ends = entries
    .map((e) => toEpoch(e.completedAt))
    .filter((n): n is number => n !== null);
  if (starts.length === 0 || ends.length === 0) return null;
  const span = Math.max(...ends) - Math.min(...starts);
  return span >= 0 ? span : null;
}

/** Human-friendly duration label. Mirrors TaskGroupTrace.formatDuration. */
export function formatDuration(ms: number | null): string {
  if (ms === null || ms === 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
