/**
 * Iteration detail view + human-note editor — the "Dispute" surface of a consilium
 * loop round (design §7). Given a consilium group id + an iteration number it
 * renders that round's dispute: one card per participant EXECUTION (each debater +
 * the judge) with role/model label, status and an expandable raw-output block,
 * plus the human-in-the-loop NOTE editor whose text is folded into the NEXT
 * round's dispute context (composeIterationInput → HUMAN_NOTE_HEADING, server-side,
 * unchanged). Consumed by ConsiliumLoopDetail; the standalone Task Groups page it
 * once backed has been retired.
 *
 * SECURITY: the summary/error/output are owner-gated server-side and rendered here
 * as INERT React text — never via dangerouslySetInnerHTML.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2,
  MessageSquarePlus,
  Clock,
  Play,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Ban,
} from "lucide-react";
import {
  useIterationDetail,
  useSaveIterationNote,
} from "@/hooks/use-task-iterations";
import { useToast } from "@/hooks/use-toast";
import type { IterationExecution } from "@/lib/task-iterations";
import {
  computeReviewActivity,
  participantHeading,
  formatElapsed,
  noActivityMinutes,
  type ParticipantActivityStatus,
  type ReviewParticipant,
} from "./review-activity";

// ─── Status badge ──────────────────────────────────────────────────────────────
//
// A small status badge for an execution/iteration status, matching the loop
// page's status idioms. Previously supplied by the (now-retired) TaskGroup page;
// kept self-contained here so the dispute view needs no badge prop, and still
// overridable for callers that want their own visual system.

const EXECUTION_STATUS_STYLE: Record<
  string,
  { color: string; icon: ReactElement }
> = {
  pending: { color: "bg-muted text-muted-foreground", icon: <Clock className="h-3 w-3" /> },
  blocked: {
    color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    icon: <Clock className="h-3 w-3" />,
  },
  ready: {
    color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    icon: <Play className="h-3 w-3" />,
  },
  running: { color: "bg-blue-500 text-white", icon: <Loader2 className="h-3 w-3 animate-spin" /> },
  completed: { color: "bg-green-600 text-white", icon: <CheckCircle2 className="h-3 w-3" /> },
  failed: { color: "bg-red-600 text-white", icon: <AlertCircle className="h-3 w-3" /> },
  cancelled: { color: "bg-gray-500 text-white", icon: <Ban className="h-3 w-3" /> },
};

/** Default status badge for an execution/iteration status (inert label + icon). */
export function ExecutionStatusBadge({ status }: { status: string }): ReactElement {
  const cfg = EXECUTION_STATUS_STYLE[status] ?? EXECUTION_STATUS_STYLE.pending;
  return (
    <Badge className={`${cfg.color} gap-1`}>
      {cfg.icon}
      {status}
    </Badge>
  );
}

// ─── Live participant activity (review step) ─────────────────────────────────
//
// The `reviewing`/`deciding` step was a 30-min spinner: the operator couldn't
// tell which model was which role, whether it was working or a zombie, how long
// it had run, or what it was producing. These pieces make each participant row
// self-explanatory — identity, status, a live elapsed, a live "generating…" (or
// "thinking…") beat, and a STALLED badge for a running-but-quiet execution. The
// activity model itself is the pure `computeReviewActivity` (unit-tested); this
// file is only its rendering.

/** Operator-facing status badge (queued/running/stalled/completed/failed). */
const ACTIVITY_STATUS_STYLE: Record<
  ParticipantActivityStatus,
  { color: string; icon: ReactElement; label: string }
> = {
  queued: {
    color: "bg-muted text-muted-foreground",
    icon: <Clock className="h-3 w-3" />,
    label: "queued",
  },
  running: {
    color: "bg-blue-500 text-white",
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
    label: "running",
  },
  stalled: {
    color: "bg-amber-500 text-white",
    icon: <AlertTriangle className="h-3 w-3" />,
    label: "stalled",
  },
  completed: {
    color: "bg-green-600 text-white",
    icon: <CheckCircle2 className="h-3 w-3" />,
    label: "completed",
  },
  failed: {
    color: "bg-red-600 text-white",
    icon: <AlertCircle className="h-3 w-3" />,
    label: "failed",
  },
  cancelled: {
    color: "bg-gray-500 text-white",
    icon: <Ban className="h-3 w-3" />,
    label: "cancelled",
  },
};

function ParticipantStatusBadge({ status }: { status: ParticipantActivityStatus }): ReactElement {
  const cfg = ACTIVITY_STATUS_STYLE[status] ?? ACTIVITY_STATUS_STYLE.queued;
  return (
    <Badge className={`${cfg.color} gap-1`}>
      {cfg.icon}
      {cfg.label}
    </Badge>
  );
}

/**
 * A per-second clock that drives the live elapsed / stall countdown BETWEEN the
 * panel's 3s data polls (it adds NO API traffic — it is a local timer only).
 * Ticks only while `active`; otherwise it returns a single render-time snapshot so
 * a settled/historical round stays static and re-renders nothing.
 */
function useNowTicker(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/**
 * The live context for the review step, threaded in ONLY from the loop page's
 * "Current round (live)" section. Absent for a historical round (which is
 * terminal — nothing runs, so the enriched cards render static, no stall).
 */
export interface LiveReviewContext {
  /** The loop row's `updatedAt` heartbeat — folds into the no-progress signal. */
  loopUpdatedAt?: string | Date | null;
  /** Round number for the one-line summary (falls back to the iteration number). */
  roundLabel?: string | number | null;
  /** Override the 5-min stall threshold (tests / tuning). */
  stallThresholdMs?: number;
}

interface IterationDetailViewProps {
  groupId: string;
  iterationNumber: number;
  /** Present ⇒ live review framing (per-second timer, stall detection, summary). */
  live?: LiveReviewContext;
}

/**
 * Render an execution's raw `output` as inert text for the collapsible "raw
 * reasoning" block: a plain string as-is, the non-JSON `{ raw }` fallback shape
 * unwrapped, anything else pretty-printed JSON. Returns null when there's
 * nothing to show. Never uses dangerouslySetInnerHTML — the caller puts this in
 * a <pre> as text.
 */
function formatExecutionOutput(output: unknown): string | null {
  if (output == null) return null;
  if (typeof output === "string") return output.trim() || null;
  if (typeof output === "object" && "raw" in output) {
    const raw = (output as { raw?: unknown }).raw;
    if (typeof raw === "string") return raw.trim() || null;
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

/**
 * Human-in-the-loop note editor for one round's iteration. After a round finishes
 * the owner records their thoughts/decisions here; on the NEXT round the note is
 * folded into the dispute input so the debaters/judge argue with it in scope. The
 * textarea is seeded from the persisted note and re-seeds when the server value
 * changes (e.g. switching rounds) UNLESS the user has unsaved edits.
 */
export function IterationNoteEditor({
  groupId,
  iterationNumber,
  initialNote,
}: {
  groupId: string;
  iterationNumber: number;
  initialNote: string;
}) {
  const { toast } = useToast();
  const save = useSaveIterationNote(groupId, iterationNumber);
  const [note, setNote] = useState(initialNote);
  const [dirty, setDirty] = useState(false);

  // Re-seed from the server value when it changes and there are no local edits.
  useEffect(() => {
    if (!dirty) setNote(initialNote);
  }, [initialNote, dirty]);

  const onSave = () => {
    save.mutate(note, {
      onSuccess: () => {
        setDirty(false);
        toast({ title: "Note saved", description: "It will be taken into account in the next round." });
      },
      onError: (e) =>
        toast({
          title: "Couldn't save the note",
          description: e instanceof Error ? e.message : "Error",
          variant: "destructive",
        }),
    });
  };

  return (
    <Card>
      <CardHeader className="py-3 pb-1">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
          Your thoughts and decisions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 py-2">
        <p className="text-xs text-muted-foreground">
          Jot down your takeaways from this round. When the loop advances to the next round,
          they are added to the dispute context — the participants and the judge will take them into account.
        </p>
        <Textarea
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setDirty(true);
          }}
          placeholder="For example: the judge overrated risk X — I consider it P1; in the next round focus on Y…"
          className="min-h-[120px] text-sm"
          data-testid="iteration-human-note"
        />
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={onSave} disabled={save.isPending || !dirty}>
            {save.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : null}
            Save note
          </Button>
          {dirty ? <span className="text-xs text-muted-foreground">You have unsaved changes</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * One round's dispute detail: the human-note editor plus a self-explanatory
 * per-participant activity list (each debater + the judge) built from the
 * iteration's executions via `computeReviewActivity` — identity, status, live
 * elapsed, a "generating…"/"thinking…" beat, a STALLED badge, and the existing
 * expandable raw output. Pass `live` (from the loop page's "Current round (live)"
 * section) to enable the per-second timer + stall detection; omit it for a
 * historical round (terminal — the same cards render static). The owner-gated
 * detail is fetched lazily — mount this only when the dispute section is expanded.
 */
export function IterationDetailView({
  groupId,
  iterationNumber,
  live,
}: IterationDetailViewProps) {
  const { data, isLoading, error } = useIterationDetail(groupId, iterationNumber);

  // A round with a live-running participant needs a per-second clock so the
  // elapsed/stall readouts advance between the panel's 3s data polls. Derive the
  // trigger from the RAW status (independent of `now`) so the hook order is stable.
  const isLive = !!live;
  const hasRunning = isLive && (data?.executions?.some((e) => e.status === "running") ?? false);
  const now = useNowTicker(hasRunning);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading the dispute for round #{iterationNumber}…
        </CardContent>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          Could not load the dispute for round #{iterationNumber}.
        </CardContent>
      </Card>
    );
  }

  const activity = computeReviewActivity(data.executions, {
    now,
    loopUpdatedAt: live?.loopUpdatedAt ?? null,
    roundLabel: live?.roundLabel ?? iterationNumber,
    stallThresholdMs: live?.stallThresholdMs,
  });
  const execById = new Map(data.executions.map((e) => [e.id, e]));

  return (
    <div className="space-y-3">
      {/* Human-in-the-loop: thoughts/decisions folded into the next round. */}
      <IterationNoteEditor
        groupId={groupId}
        iterationNumber={iterationNumber}
        initialNote={data.iteration.humanNote ?? ""}
      />

      {/* Per-participant execution cards (summary/error owner-gated, inert text). */}
      {activity.participants.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            This round has no recorded participant executions.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {/* One-line round summary: who + how many in each state + elapsed. */}
          <div
            className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
            data-testid="review-activity-summary"
          >
            {activity.summary.stalled > 0 ? (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
            ) : activity.summary.running > 0 ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600" aria-hidden="true" />
            )}
            <span className="tabular-nums">{activity.oneLine}</span>
          </div>

          {activity.participants.map((p) => (
            <ParticipantCard key={p.id} participant={p} exec={execById.get(p.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One participant row of the review step, made self-explanatory: a numbered
 * identity heading ("1. Opus — primary debater"), the OBSERVED model slug, a
 * status badge, a live elapsed timer, and an ACTIVITY line that says what it is
 * doing right now — "generating…" while producing (the platform streams no partial
 * tokens to the read side, so we show an honest "generating…"/"thinking…" beat
 * rather than a token count), or an amber "stalled — no activity for Nm" when a
 * running execution has gone quiet past the threshold. Terminal rows show their
 * summary/error and the existing expandable raw output.
 */
function ParticipantCard({
  participant: p,
  exec,
}: {
  participant: ReviewParticipant;
  exec: IterationExecution | undefined;
}): ReactElement {
  const borderClass =
    p.status === "stalled"
      ? "border-amber-500/60"
      : p.status === "running"
        ? "border-blue-500/50"
        : "";

  return (
    <Card className={borderClass}>
      <CardHeader className="py-3 pb-1">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="min-w-0 truncate text-sm font-medium">
            {p.index}. {participantHeading(p)}
          </CardTitle>
          <ParticipantStatusBadge status={p.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-1 py-2">
        {/* Identity + timing: role · observed model · elapsed. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="capitalize">{p.role.label}</span>
          {p.modelSlug && <span className="font-mono">{p.modelSlug}</span>}
          {p.elapsedMs !== null && (
            <span className="tabular-nums" title={p.startedAt ?? undefined}>
              {p.status === "running" || p.status === "stalled" ? "running " : "took "}
              {formatElapsed(p.elapsedMs)}
            </span>
          )}
        </div>

        {/* Live activity beat — the fix for the dead 30-min spinner. */}
        <ParticipantActivityLine participant={p} />

        {exec?.summary && (
          <div className="mt-2 rounded bg-green-50 p-2 text-xs text-green-800 dark:bg-green-950 dark:text-green-200">
            {exec.summary}
          </div>
        )}
        {exec?.errorMessage && (
          <div className="mt-2 rounded bg-red-50 p-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
            {exec.errorMessage}
          </div>
        )}
        {(() => {
          const raw = formatExecutionOutput(exec?.output);
          return raw ? (
            <details className="mt-2">
              <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">
                Raw output / reasoning
              </summary>
              <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-xs">
                {raw}
              </pre>
            </details>
          ) : null;
        })()}
      </CardContent>
    </Card>
  );
}

/**
 * The one-line "what is it doing right now" beat under a participant. Running →
 * an honest "generating…"/"thinking…" spinner with the elapsed; stalled → an
 * amber "stalled — no activity for Nm" so a dead review looks visibly dead;
 * queued → "waiting to start". Terminal rows render nothing here (their
 * summary/output speaks for them).
 */
function ParticipantActivityLine({ participant: p }: { participant: ReviewParticipant }): ReactElement | null {
  if (p.status === "stalled") {
    const mins = p.noProgressMs !== null ? noActivityMinutes(p.noProgressMs) : 0;
    return (
      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        stalled — no activity for {mins}m
      </div>
    );
  }
  if (p.status === "running") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
        {p.hasOutput ? "generating…" : "thinking…"}
        {p.elapsedMs !== null && (
          <span className="tabular-nums text-muted-foreground">· {formatElapsed(p.elapsedMs)}</span>
        )}
      </div>
    );
  }
  if (p.status === "queued") {
    return <div className="text-xs text-muted-foreground">waiting to start…</div>;
  }
  return null;
}
