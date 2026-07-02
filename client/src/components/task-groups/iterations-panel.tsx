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
import { useEffect, useState, type ReactElement } from "react";
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
  Ban,
} from "lucide-react";
import {
  useIterationDetail,
  useSaveIterationNote,
} from "@/hooks/use-task-iterations";
import { useToast } from "@/hooks/use-toast";
import {
  buildTimelineFromExecutions,
  formatDuration,
  type ExecutionRowInput,
} from "./timeline";

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

interface IterationDetailViewProps {
  groupId: string;
  iterationNumber: number;
  /** Optional badge override; defaults to the self-contained ExecutionStatusBadge. */
  StatusBadge?: (props: { status: string }) => ReactElement;
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
 * One round's dispute detail: the human-note editor plus per-participant execution
 * cards (each debater + the judge) built from the iteration's executions, with an
 * expandable raw-output block per execution. The owner-gated detail is fetched
 * lazily — mount this only when the round's dispute section is expanded.
 */
export function IterationDetailView({
  groupId,
  iterationNumber,
  StatusBadge = ExecutionStatusBadge,
}: IterationDetailViewProps) {
  const { data, isLoading, error } = useIterationDetail(groupId, iterationNumber);

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

  const executions = data.executions as ExecutionRowInput[];
  const timeline = buildTimelineFromExecutions(executions);

  return (
    <div className="space-y-3">
      {/* Human-in-the-loop: thoughts/decisions folded into the next round. */}
      <IterationNoteEditor
        groupId={groupId}
        iterationNumber={iterationNumber}
        initialNote={data.iteration.humanNote ?? ""}
      />

      {/* Per-participant execution cards (summary/error owner-gated, inert text). */}
      {data.executions.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            This round has no recorded participant executions.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {timeline.map((entry, i) => {
            const exec = data.executions.find((e) => e.id === entry.id);
            return (
              <Card key={entry.id} className={entry.status === "running" ? "border-blue-500/50" : ""}>
                <CardHeader className="py-3 pb-1">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm font-medium">
                      {i + 1}. {entry.name}
                    </CardTitle>
                    <StatusBadge status={entry.status} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-1 py-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    {entry.modelSlug && <span className="font-mono">{entry.modelSlug}</span>}
                    {entry.durationMs !== null && (
                      <span className="tabular-nums">{formatDuration(entry.durationMs)}</span>
                    )}
                    {entry.startedAt && (
                      <span title={entry.startedAt}>
                        started {new Date(entry.startedAt).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
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
          })}
        </div>
      )}
    </div>
  );
}
