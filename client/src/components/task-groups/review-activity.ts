/**
 * Pure helpers that turn a consilium round's participant EXECUTIONS into a
 * self-explanatory, live "who is doing what, and is it alive?" model for the
 * REVIEW step (the `reviewing`/`deciding` phase). Consumed by
 * iterations-panel.tsx's IterationDetailView; unit-tested without a DOM renderer
 * (the repo's unit project runs in `node`, no jsdom).
 *
 * WHY this exists: during `reviewing` the operator saw only a spinner for 30+
 * minutes with no way to tell WHICH model was which role, whether it was
 * actively working or a zombie, how long it had run, or what it was producing.
 * These pure functions compute, per participant: identity (role + observed
 * model), a mapped status, a live elapsed, and — critically — a STALL verdict.
 *
 * STALL is deliberately based on NO-PROGRESS, not raw elapsed. The platform does
 * NOT stream partial tokens to the read side: `task_executions.output` is written
 * ONCE at completion and there is no per-execution heartbeat column (see
 * server/services/task-orchestrator.ts). So "activity" is defined as the set of
 * observable progress EVENTS across the whole round — any execution flipping to
 * `running` (a fresh `startedAt`), any execution finishing (a `completedAt`), and
 * the loop row's `updatedAt` heartbeat (bumped by the controller/poller on every
 * transition/partial update). A running participant is flagged `stalled` only
 * when the ENTIRE round has produced no such event for the threshold. This never
 * trips on a legitimately slow-but-working panel: while debaters complete in
 * sequence each completion is a progress event that resets the clock; only a
 * genuinely frozen round (nothing starts, nothing finishes, the loop heartbeat is
 * stale) goes amber.
 *
 * SECURITY: every field here is metadata (status / model slug / task name /
 * timestamps) already owner-gated by the server; nothing is rendered as HTML.
 */

/** The minimal execution shape the activity model needs (subset of IterationExecution). */
export interface ReviewExecutionInput {
  id: string;
  /** Denormalized task-definition name; encodes role + seat (e.g. "Opus primary"). */
  taskName?: string | null;
  /** Raw task_execution status (pending|blocked|ready|running|completed|failed|cancelled). */
  status: string;
  /** OBSERVED (resolved) model slug the execution actually ran on. */
  modelSlug?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  /** Present (non-empty) once the model's output has landed (only at completion). */
  output?: unknown;
  summary?: string | null;
  errorMessage?: string | null;
}

/** The role a participant execution plays in the cross-review dispute. */
export type ParticipantRoleKind = "primary" | "rebuttal" | "judge" | "participant";

/** A classified participant role: its kind, a human label, and the seat (model name). */
export interface ParticipantRole {
  kind: ParticipantRoleKind;
  /** Human role label, e.g. "primary debater", "rebuts Gemini", "judge". */
  label: string;
  /** The seat / reviewer display name parsed from the task name (e.g. "Opus"), or null. */
  seat: string | null;
}

/**
 * The activity status shown to the operator, mapped from the raw execution
 * status (plus the derived stall verdict). Narrower and more legible than the raw
 * task statuses: pending/blocked/ready collapse to `queued`; a `running` row that
 * has gone quiet past the threshold becomes `stalled`.
 */
export type ParticipantActivityStatus =
  | "queued"
  | "running"
  | "stalled"
  | "completed"
  | "failed"
  | "cancelled";

/** One participant row of the review-activity model. */
export interface ReviewParticipant {
  id: string;
  /** 1-based position in the round's timeline ordering. */
  index: number;
  taskName: string | null;
  role: ParticipantRole;
  /** OBSERVED model slug (preferred over any declared/composition value). */
  modelSlug: string | null;
  /** The raw task_execution status, kept for callers that need the source value. */
  rawStatus: string;
  /** The mapped, operator-facing status (stall folded in). */
  status: ParticipantActivityStatus;
  startedAt: string | null;
  completedAt: string | null;
  /**
   * Wall-clock elapsed in ms: for a terminal row it is startedAt→completedAt;
   * for a running row it is startedAt→now; null when it has not started.
   */
  elapsedMs: number | null;
  /** True iff running AND the round has had no progress for the threshold. */
  stalled: boolean;
  /** ms since the last round-level progress event (running rows only), else null. */
  noProgressMs: number | null;
  /** Whether the execution's output has landed (a completion signal). */
  hasOutput: boolean;
}

/** A compact roll-up used for the one-line section summary. */
export interface ReviewActivitySummary {
  total: number;
  queued: number;
  running: number;
  stalled: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** Number of primary debater seats (rebuttals belong to the same debaters). */
  debaterCount: number;
  hasJudge: boolean;
  /** Round elapsed: earliest start → now (or → latest completion when none run), ms. */
  elapsedMs: number | null;
  /** ms since the last observable progress event across the whole round. */
  lastProgressMs: number | null;
}

/** The full review-activity model for one round's executions. */
export interface ReviewActivity {
  participants: ReviewParticipant[];
  summary: ReviewActivitySummary;
  /** e.g. "Round 2 review — 2 debaters + judge · 2 running, 1 queued · elapsed 6m". */
  oneLine: string;
}

/** Default stall threshold: 5 minutes of no round-level activity. */
export const DEFAULT_STALL_THRESHOLD_MS = 5 * 60_000;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** Parse an ISO string / Date / epoch to epoch ms, or null when absent/unparseable. */
function toEpoch(value: string | Date | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Whether an execution's `output` carries anything to show (a completion signal). */
function outputPresent(output: unknown): boolean {
  if (output == null) return false;
  if (typeof output === "string") return output.trim().length > 0;
  if (typeof output === "object") {
    if ("raw" in output) {
      const raw = (output as { raw?: unknown }).raw;
      return typeof raw === "string" ? raw.trim().length > 0 : raw != null;
    }
    return Object.keys(output as object).length > 0;
  }
  return true;
}

/**
 * Classify a participant's role from its task name. Task names are authored by the
 * review factory and are stable + self-describing: "<Seat> primary",
 * "<Seat> rebuts <Other>", "Judge verdict". Falls back to a generic participant
 * for anything unrecognised (never throws). Pure.
 */
export function classifyParticipantRole(
  taskName: string | null | undefined,
): ParticipantRole {
  const name = (taskName ?? "").trim();
  if (!name) return { kind: "participant", label: "participant", seat: null };

  if (/\bjudge\b/i.test(name)) {
    return { kind: "judge", label: "judge", seat: null };
  }

  const rebut = name.match(/^(.*?)\s+rebuts\s+(.*)$/i);
  if (rebut) {
    const seat = rebut[1].trim() || null;
    const target = rebut[2].trim();
    return {
      kind: "rebuttal",
      label: target ? `rebuts ${target}` : "rebuttal",
      seat,
    };
  }

  const primary = name.match(/^(.*?)\s+primary$/i);
  if (primary) {
    const seat = primary[1].trim() || null;
    return { kind: "primary", label: "primary debater", seat };
  }

  return { kind: "participant", label: "participant", seat: null };
}

/**
 * A display heading for a participant: the seat (or "Judge") plus its role,
 * e.g. "Opus — primary debater", "Gemini — rebuts Opus", "Judge". The numbering
 * is applied by the caller. Pure.
 */
export function participantHeading(p: ReviewParticipant): string {
  const { role } = p;
  if (role.kind === "judge") return "Judge";
  const seat = role.seat ?? p.modelSlug ?? p.taskName ?? "Participant";
  if (role.kind === "participant") return p.taskName?.trim() || seat;
  return `${seat} — ${role.label}`;
}

/** Map a raw execution status (+ stall) to the operator-facing activity status. */
function mapStatus(rawStatus: string, stalled: boolean): ParticipantActivityStatus {
  switch (rawStatus) {
    case "running":
      return stalled ? "stalled" : "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    // pending / blocked / ready and any unknown pre-run state → queued
    default:
      return "queued";
  }
}

/**
 * Order executions for a stable, meaningful timeline: started rows first by
 * `startedAt` ascending, then not-yet-started rows in their given order. Stable
 * for ties; never mutates the input. Mirrors buildTimeline's ordering so the
 * numbering matches the rest of the panel.
 */
function orderExecutions(
  executions: readonly ReviewExecutionInput[],
): ReviewExecutionInput[] {
  return executions
    .map((e, i) => ({ e, i, start: toEpoch(e.startedAt) }))
    .sort((a, b) => {
      if (a.start !== null && b.start !== null) return a.start - b.start || a.i - b.i;
      if (a.start !== null) return -1;
      if (b.start !== null) return 1;
      return a.i - b.i;
    })
    .map(({ e }) => e);
}

/** ms → a compact label: "45s", "6m", "6m 12s", "1h 4m". */
export function formatElapsed(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min ? `${hr}h ${min}m` : `${hr}h`;
}

/** ms → whole minutes, rounded down, min 1 (for the "no activity for Nm" badge). */
export function noActivityMinutes(ms: number): number {
  return Math.max(1, Math.floor(ms / 60_000));
}

/**
 * Compute the full review-activity model for one round's executions.
 *
 * `now` is injected so the function stays pure/testable (the UI passes a
 * per-second ticker). `loopUpdatedAt` is the loop row's heartbeat, folded into
 * the round-level progress signal so a controller/poller tick keeps a legitimately
 * slow round out of the stall state. `stallThresholdMs` defaults to 5 minutes.
 */
export function computeReviewActivity(
  executions: readonly ReviewExecutionInput[],
  opts: {
    now: number;
    loopUpdatedAt?: string | Date | null;
    stallThresholdMs?: number;
    roundLabel?: string | number | null;
  },
): ReviewActivity {
  const stallThresholdMs = opts.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const now = opts.now;
  const ordered = orderExecutions(executions);

  // Round-level "last progress" = the most recent observable progress event:
  // any start, any completion, or the loop heartbeat. This is the anti-false-
  // positive core of the stall rule.
  const progressStamps: number[] = [];
  for (const e of ordered) {
    const s = toEpoch(e.startedAt);
    const c = toEpoch(e.completedAt);
    if (s !== null) progressStamps.push(s);
    if (c !== null) progressStamps.push(c);
  }
  const loopBeat = toEpoch(opts.loopUpdatedAt);
  if (loopBeat !== null) progressStamps.push(loopBeat);
  const lastProgressAt = progressStamps.length ? Math.max(...progressStamps) : null;
  const lastProgressMs = lastProgressAt !== null ? Math.max(0, now - lastProgressAt) : null;

  const participants: ReviewParticipant[] = ordered.map((e, idx) => {
    const role = classifyParticipantRole(e.taskName);
    const startedAt = e.startedAt ?? null;
    const completedAt = e.completedAt ?? null;
    const startEpoch = toEpoch(startedAt);
    const endEpoch = toEpoch(completedAt);
    const isRunning = e.status === "running";

    // No-progress is a ROUND-level signal; a running row is stalled only when the
    // whole round has been quiet past the threshold (never on raw elapsed alone).
    const noProgressMs = isRunning ? lastProgressMs : null;
    const stalled = isRunning && noProgressMs !== null && noProgressMs > stallThresholdMs;

    let elapsedMs: number | null = null;
    if (startEpoch !== null) {
      const end = endEpoch !== null ? endEpoch : isRunning ? now : null;
      if (end !== null) elapsedMs = Math.max(0, end - startEpoch);
    }

    return {
      id: e.id,
      index: idx + 1,
      taskName: e.taskName ?? null,
      role,
      modelSlug: e.modelSlug ?? null,
      rawStatus: e.status,
      status: mapStatus(e.status, stalled),
      startedAt,
      completedAt,
      elapsedMs,
      stalled,
      noProgressMs,
      hasOutput: outputPresent(e.output),
    };
  });

  const summary = summarize(participants, now);
  const oneLine = buildOneLine(summary, opts.roundLabel ?? null);
  return { participants, summary, oneLine };
}

function summarize(
  participants: readonly ReviewParticipant[],
  now: number,
): ReviewActivitySummary {
  let queued = 0;
  let running = 0;
  let stalled = 0;
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let debaterCount = 0;
  let hasJudge = false;
  const starts: number[] = [];
  const ends: number[] = [];

  for (const p of participants) {
    switch (p.status) {
      case "queued":
        queued += 1;
        break;
      case "running":
        running += 1;
        break;
      case "stalled":
        stalled += 1;
        break;
      case "completed":
        completed += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "cancelled":
        cancelled += 1;
        break;
    }
    if (p.role.kind === "primary") debaterCount += 1;
    if (p.role.kind === "judge") hasJudge = true;
    const s = toEpoch(p.startedAt);
    const c = toEpoch(p.completedAt);
    if (s !== null) starts.push(s);
    if (c !== null) ends.push(c);
  }

  // Round elapsed: from the earliest start to now while anything is live, else to
  // the latest completion (a finished round has a fixed span).
  let elapsedMs: number | null = null;
  if (starts.length) {
    const earliest = Math.min(...starts);
    const anyLive = running > 0 || stalled > 0 || queued > 0;
    const end = anyLive ? now : ends.length ? Math.max(...ends) : now;
    elapsedMs = Math.max(0, end - earliest);
  }

  return {
    total: participants.length,
    queued,
    running,
    stalled,
    completed,
    failed,
    cancelled,
    debaterCount,
    hasJudge,
    elapsedMs,
    lastProgressMs: null, // filled by caller context if needed; not used in one-liner
  };
}

/** Build the compact one-line section summary from the roll-up. */
function buildOneLine(
  summary: ReviewActivitySummary,
  roundLabel: string | number | null,
): string {
  const round = roundLabel != null && `${roundLabel}`.trim() ? `Round ${roundLabel} ` : "";
  const seats =
    summary.debaterCount > 0
      ? `${summary.debaterCount} debater${summary.debaterCount === 1 ? "" : "s"}${
          summary.hasJudge ? " + judge" : ""
        }`
      : summary.hasJudge
        ? "judge"
        : `${summary.total} participant${summary.total === 1 ? "" : "s"}`;

  const parts: string[] = [];
  if (summary.running) parts.push(`${summary.running} running`);
  if (summary.stalled) parts.push(`${summary.stalled} stalled`);
  if (summary.queued) parts.push(`${summary.queued} queued`);
  if (summary.completed) parts.push(`${summary.completed} done`);
  if (summary.failed) parts.push(`${summary.failed} failed`);
  const counts = parts.length ? ` · ${parts.join(", ")}` : "";

  const elapsed =
    summary.elapsedMs != null ? ` · elapsed ${formatElapsed(summary.elapsedMs)}` : "";

  return `${round}review — ${seats}${counts}${elapsed}`;
}
