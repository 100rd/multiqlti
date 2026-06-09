/**
 * Refresh panel. "Run refresh now" kicks off a refresh run; the resulting run id
 * is polled and its diff report rendered. Stale / superseded entries are FLAGS
 * for human review — they are NOT auto-applied (mirrors the design's no-auto-
 * commit guarantee), which the UI states explicitly.
 *
 * Wave 2 report shape: `new`/`changed` are counts; `stale`/`superseded` are
 * arrays of affected card ids (rendered as length + the id list).
 */
import { useState } from "react";
import { RefreshCw, Info, Sparkles, GitCompare, Clock, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  useStartRefresh,
  useRefreshRun,
  type RefreshReport,
} from "@/hooks/use-practice-cards";
import { QueryError, errorMessage } from "./QueryStates";

interface RefreshPanelProps {
  workspaceId: string;
  canRun: boolean;
}

export function RefreshPanel({ workspaceId, canRun }: RefreshPanelProps) {
  const { toast } = useToast();
  const [runId, setRunId] = useState<string | null>(null);
  const start = useStartRefresh(workspaceId);
  const run = useRefreshRun(workspaceId, runId);

  function handleRun() {
    start.mutate(undefined, {
      onSuccess: (res) => {
        setRunId(res.refreshRunId);
        toast({
          title: "Refresh started",
          description: "Diffing against current cards…",
        });
      },
      onError: (err) =>
        toast({
          variant: "destructive",
          title: "Refresh failed to start",
          description: errorMessage(err),
        }),
    });
  }

  const isRunning =
    start.isPending ||
    (!!runId && (run.isLoading || run.data?.status === "running"));

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div
          className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
          role="note"
        >
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            A refresh re-researches the topic and flags cards as new, changed,
            stale, or superseded. Nothing is applied automatically — flagged cards
            are queued for human review.
          </p>
        </div>
        <Button
          onClick={handleRun}
          disabled={!canRun || isRunning}
          data-testid="run-refresh"
          className="shrink-0"
        >
          <RefreshCw
            className={
              isRunning ? "mr-2 h-4 w-4 animate-spin" : "mr-2 h-4 w-4"
            }
          />
          {isRunning ? "Refreshing…" : "Run refresh now"}
        </Button>
      </div>

      {!canRun && (
        <p
          className="text-xs text-amber-600"
          data-testid="refresh-readonly-notice"
        >
          Running a refresh requires maintainer, admin, or workspace-owner access.
        </p>
      )}

      {run.isError ? (
        <QueryError
          message={errorMessage(run.error)}
          onRetry={() => run.refetch()}
        />
      ) : run.data ? (
        <RefreshRunReport
          status={run.data.status}
          report={run.data.report}
          completedAt={run.data.completedAt}
        />
      ) : runId ? (
        <p className="text-sm text-muted-foreground">
          Waiting for the run report…
        </p>
      ) : null}
    </div>
  );
}

// ─── Report ─────────────────────────────────────────────────────────────────

function RefreshRunReport({
  status,
  report,
  completedAt,
}: {
  status: string;
  report: RefreshReport;
  completedAt: string | null;
}) {
  return (
    <section
      className="space-y-3 rounded-lg border border-border p-4"
      data-testid="refresh-run-report"
      aria-label="Refresh run report"
      data-run-status={status}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Refresh report</h3>
        <Badge variant="secondary" className="text-xs">
          {status}
          {completedAt ? ` · ${new Date(completedAt).toLocaleString()}` : ""}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <CountBucket
          icon={<Sparkles className="h-3.5 w-3.5" />}
          label="New"
          tone="emerald"
          count={report.new}
        />
        <CountBucket
          icon={<GitCompare className="h-3.5 w-3.5" />}
          label="Changed"
          tone="blue"
          count={report.changed}
        />
        <IdBucket
          icon={<Clock className="h-3.5 w-3.5" />}
          label="Stale"
          tone="amber"
          ids={report.stale}
        />
        <IdBucket
          icon={<Layers className="h-3.5 w-3.5" />}
          label="Superseded"
          tone="amber"
          ids={report.superseded}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        {report.unchangedCount} card
        {report.unchangedCount === 1 ? "" : "s"} unchanged. Stale and superseded
        cards are flagged for review and remain active until a human accepts a
        replacement.
      </p>
    </section>
  );
}

const TONE: Record<string, string> = {
  emerald: "border-emerald-500/30 text-emerald-600",
  blue: "border-blue-500/30 text-blue-600",
  amber: "border-amber-500/30 text-amber-600",
};

/** A bucket backed by a count (new / changed). */
function CountBucket({
  icon,
  label,
  tone,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  tone: string;
  count: number;
}) {
  return (
    <div
      className={`rounded-md border p-3 ${TONE[tone]}`}
      data-testid={`refresh-bucket-${label.toLowerCase()}`}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
        {icon}
        {label}
      </div>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
        {count}
      </p>
    </div>
  );
}

/** A bucket backed by an array of flagged card ids (stale / superseded). */
function IdBucket({
  icon,
  label,
  tone,
  ids,
}: {
  icon: React.ReactNode;
  label: string;
  tone: string;
  ids: string[];
}) {
  return (
    <div
      className={`rounded-md border p-3 ${TONE[tone]}`}
      data-testid={`refresh-bucket-${label.toLowerCase()}`}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
        {icon}
        {label}
        <span className="text-[10px] uppercase tracking-wide opacity-70">
          flag
        </span>
      </div>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
        {ids.length}
      </p>
      {ids.length > 0 && (
        <ul
          className="mt-1.5 space-y-0.5"
          data-testid={`refresh-ids-${label.toLowerCase()}`}
        >
          {ids.map((id) => (
            <li
              key={id}
              className="truncate font-mono text-[10px] text-muted-foreground"
              title={id}
            >
              {id}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
