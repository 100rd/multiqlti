/**
 * Task Groups v2 — Iterations panel (FE2). A read-only, newest-first list of a
 * group's runs (number, status badge, started/duration, completed/total counts),
 * keyset-paginated via useTaskGroupIterations. Selecting a row loads the
 * owner-gated detail (useIterationDetail) and renders that iteration's per-task
 * EXECUTION history by reusing buildTimelineFromExecutions (the same timeline as
 * the definition view) plus the per-task summary/error cards. The Trace button
 * targets `…/iterations/:n/trace`.
 *
 * SECURITY: the list is metadata-only (server allowlist). The detail's
 * summary/error/output are owner-gated server-side and rendered here as INERT
 * React text — never via dangerouslySetInnerHTML.
 */
import type { ReactElement } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Loader2, ChevronRight } from "lucide-react";
import { useTaskGroupIterations, useIterationDetail } from "@/hooks/use-task-iterations";
import {
  buildTimelineFromExecutions,
  formatDuration,
  type ExecutionRowInput,
} from "./timeline";

interface IterationsPanelProps {
  groupId: string;
  /** The currently selected iteration number (null → none selected yet). */
  selected: number | null;
  onSelect: (iterationNumber: number) => void;
  /** Reused StatusBadge from the page so the visual system stays consistent. */
  StatusBadge: (props: { status: string }) => ReactElement;
  /** The active iteration number (annotated "live" while running). */
  activeNumber?: number | null;
}

export function IterationsPanel({
  groupId,
  selected,
  onSelect,
  StatusBadge,
  activeNumber,
}: IterationsPanelProps) {
  const { items, hasMore, isLoading, isFetchingMore, loadMore } =
    useTaskGroupIterations(groupId);

  return (
    <Card aria-labelledby="iterations-heading">
      <CardHeader className="py-3">
        <CardTitle id="iterations-heading" className="text-sm font-semibold">
          Iterations
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-2">
        {isLoading ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            Loading iterations…
          </p>
        ) : items.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            No runs yet. Use Run to start the first iteration.
          </p>
        ) : (
          <ul className="divide-y divide-border" aria-label="Iteration history">
            {items.map((it) => {
              const isSelected = selected === it.iterationNumber;
              const isActive =
                activeNumber === it.iterationNumber && it.status === "running";
              return (
                <li key={it.iterationNumber}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-current={isActive ? "true" : undefined}
                    onClick={() => onSelect(it.iterationNumber)}
                    className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      isSelected ? "bg-muted/60" : ""
                    }`}
                  >
                    <span className="shrink-0 text-sm font-semibold tabular-nums">
                      #{it.iterationNumber}
                    </span>
                    <span className="shrink-0">
                      <StatusBadge status={it.status} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {it.completedCount}/{it.taskCount} tasks
                      {it.durationMs !== null && (
                        <span className="ml-2 tabular-nums">
                          {formatDuration(it.durationMs)}
                        </span>
                      )}
                      {isActive && (
                        <span className="ml-2 inline-flex items-center gap-1 text-blue-500">
                          <span
                            className="h-1.5 w-1.5 rounded-full bg-blue-500 motion-safe:animate-pulse"
                            aria-hidden="true"
                          />
                          live
                        </span>
                      )}
                    </span>
                    <ChevronRight
                      className="h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {hasMore && (
          <div className="px-4 pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full text-xs"
              onClick={loadMore}
              disabled={isFetchingMore}
            >
              {isFetchingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface IterationDetailViewProps {
  groupId: string;
  iterationNumber: number;
  StatusBadge: (props: { status: string }) => ReactElement;
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
 * The selected iteration's per-task execution history: a reused timeline built
 * from the iteration's executions, plus per-task summary/error cards. The Trace
 * button targets the per-iteration trace route.
 */
export function IterationDetailView({
  groupId,
  iterationNumber,
  StatusBadge,
}: IterationDetailViewProps) {
  const { data, isLoading, error } = useIterationDetail(groupId, iterationNumber);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading iteration #{iterationNumber}…
        </CardContent>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          Could not load iteration #{iterationNumber}.
        </CardContent>
      </Card>
    );
  }

  const executions = data.executions as ExecutionRowInput[];
  const timeline = buildTimelineFromExecutions(executions);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Iteration #{iterationNumber}</h2>
          <StatusBadge status={data.iteration.status} />
        </div>
        <Link href={`/task-groups/${groupId}/iterations/${iterationNumber}/trace`}>
          <Button variant="outline" size="sm">
            <Activity className="mr-2 h-4 w-4" aria-hidden="true" />
            Trace
          </Button>
        </Link>
      </div>

      {/* Per-task execution cards (summary/error owner-gated, inert text). */}
      {data.executions.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            This iteration has no recorded executions.
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
