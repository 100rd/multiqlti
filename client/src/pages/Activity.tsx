/**
 * Activity — a read-only debugging lens at /activity with two tabs:
 *
 *  - "Live": what's running RIGHT NOW across the five run modes (pipeline /
 *    manager / orchestrator / consensus / task_group). Seeds from the polled
 *    GET /api/activity snapshot and merges additive live WS deltas onto the rows.
 *  - "History": past (terminal) runs across all modes, from
 *    GET /api/activity/history (keyset-paginated, "Load more" via nextCursor).
 *
 * Both tabs render the SAME row shape (mode group, title, current/last unit
 * label·agent·model, status badge, started/completed, owner column for admins).
 *
 * SECURITY: every string rendered here is run metadata only (mode, status,
 * agent/role id, model slug, ids, FIXED mode-label titles) and is rendered as
 * INERT React text. There is no HTML sink and no transcript/prompt/task text
 * (the backend strips those and builds the history rows by allowlist).
 */
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Activity as ActivityIcon, WifiOff, AlertTriangle, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useActivity, useActivityHistory } from "@/hooks/use-activity";
import {
  groupByMode,
  groupHistoryByMode,
  displayModel,
  isLiveNow,
  type ActivityGroup,
  type ActivityHistoryGroup,
  type ActivityHistoryRow,
  type LiveActivityRun,
} from "@/lib/activity";

// ─── Status pill ────────────────────────────────────────────────────────────────
// Run + unit statuses are open `string`s on the contract (RunStatus | string,
// StageStatus | OrchestratorStepStatus | phase). Key the known ones to a colour;
// anything else falls back to a neutral, still-inert pill.

const STATUS_CLASS: Record<string, string> = {
  pending: "bg-muted text-muted-foreground border-border",
  planning: "bg-muted text-muted-foreground border-border",
  running: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  executing: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  paused: "bg-sky-500/15 text-sky-600 border-sky-500/30",
  awaiting_approval: "bg-sky-500/15 text-sky-600 border-sky-500/30",
  completed: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  failed: "bg-destructive/15 text-destructive border-destructive/30",
  rejected: "bg-destructive/15 text-destructive border-destructive/30",
  cancelled: "bg-muted text-muted-foreground/70 border-border",
  skipped: "bg-muted text-muted-foreground/70 border-border",
};

function StatusPill({ status }: { status: string }) {
  const className =
    STATUS_CLASS[status] ?? "bg-muted text-muted-foreground border-border";
  return (
    <Badge variant="outline" className={cn("font-medium", className)} data-status={status}>
      {status}
    </Badge>
  );
}

/** Local time, or an em-dash placeholder. */
function displayTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : "—";
}

// ─── States (loading / empty / error / disconnected) ──────────────────────────────

function CenteredState({
  icon,
  title,
  description,
  tone = "muted",
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  tone?: "muted" | "destructive";
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-16 text-center",
        tone === "destructive"
          ? "border-destructive/40 text-destructive"
          : "border-border text-muted-foreground",
      )}
      role="status"
    >
      <div aria-hidden>{icon}</div>
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="max-w-md text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Could not load activity.";
}

// ─── Live run row ───────────────────────────────────────────────────────────────

interface RunRowProps {
  run: LiveActivityRun;
  isAdmin: boolean;
  now: number;
}

function RunRow({ run, isAdmin, now }: RunRowProps) {
  const unit = run.currentUnit;
  const live = isLiveNow(run, now);
  const unitStatus = unit?.status ?? run.status;

  return (
    <tr className="border-t border-border align-top">
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              live ? "bg-emerald-500 motion-safe:animate-pulse" : "bg-muted-foreground/30",
            )}
          />
          <span className="flex flex-col">
            <span className="text-sm font-medium leading-tight">{run.title}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{run.runId}</span>
          </span>
        </div>
      </td>
      <td className="px-3 py-2 text-sm">{unit ? unit.label : "—"}</td>
      <td className="px-3 py-2 text-sm">{unit ? unit.agent : "—"}</td>
      <td className="px-3 py-2">
        <span className="font-mono text-xs text-muted-foreground">
          {displayModel(unit?.modelSlug)}
        </span>
      </td>
      <td className="px-3 py-2">
        <StatusPill status={unitStatus} />
      </td>
      {isAdmin && (
        <td className="px-3 py-2">
          <span className="font-mono text-xs text-muted-foreground">
            {run.ownerId ?? "—"}
          </span>
        </td>
      )}
    </tr>
  );
}

// ─── History row (same column shape, timestamps instead of a live pulse) ──────────

function HistoryRow({ row, isAdmin }: { row: ActivityHistoryRow; isAdmin: boolean }) {
  const unit = row.currentUnit;
  const unitStatus = unit?.status ?? row.status;
  return (
    <tr className="border-t border-border align-top">
      <td className="px-3 py-2">
        <span className="flex flex-col">
          <span className="text-sm font-medium leading-tight">{row.title}</span>
          <span className="font-mono text-[10px] text-muted-foreground">{row.runId}</span>
        </span>
      </td>
      <td className="px-3 py-2 text-sm">{unit ? unit.label : "—"}</td>
      <td className="px-3 py-2 text-sm">{unit ? unit.agent : "—"}</td>
      <td className="px-3 py-2">
        <span className="font-mono text-xs text-muted-foreground">
          {displayModel(unit?.modelSlug)}
        </span>
      </td>
      <td className="px-3 py-2">
        <StatusPill status={unitStatus} />
      </td>
      <td className="px-3 py-2">
        <span className="text-xs text-muted-foreground">{displayTime(row.startedAt)}</span>
      </td>
      <td className="px-3 py-2">
        <span className="text-xs text-muted-foreground">{displayTime(row.completedAt)}</span>
      </td>
      {isAdmin && (
        <td className="px-3 py-2">
          <span className="font-mono text-xs text-muted-foreground">
            {row.ownerId ?? "—"}
          </span>
        </td>
      )}
    </tr>
  );
}

// ─── Mode-group tables ────────────────────────────────────────────────────────────

function LiveGroupTable({
  group,
  isAdmin,
  now,
}: {
  group: ActivityGroup;
  isAdmin: boolean;
  now: number;
}) {
  const headingId = `activity-group-${group.mode}`;
  return (
    <Card aria-labelledby={headingId}>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 py-4">
        <CardTitle id={headingId} className="text-sm">
          {group.label}
        </CardTitle>
        <Badge variant="secondary" className="tabular-nums">
          {group.runs.length}
        </Badge>
      </CardHeader>
      <CardContent className="px-0 pb-2">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">{`Active ${group.label.toLowerCase()}`}</caption>
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-3 pb-2 font-medium">Run</th>
                <th scope="col" className="px-3 pb-2 font-medium">Current unit</th>
                <th scope="col" className="px-3 pb-2 font-medium">Agent</th>
                <th scope="col" className="px-3 pb-2 font-medium">Model</th>
                <th scope="col" className="px-3 pb-2 font-medium">Status</th>
                {isAdmin && (
                  <th scope="col" className="px-3 pb-2 font-medium">Owner</th>
                )}
              </tr>
            </thead>
            <tbody>
              {group.runs.map((run) => (
                <RunRow key={run.runId} run={run as LiveActivityRun} isAdmin={isAdmin} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function HistoryGroupTable({
  group,
  isAdmin,
}: {
  group: ActivityHistoryGroup;
  isAdmin: boolean;
}) {
  const headingId = `history-group-${group.mode}`;
  return (
    <Card aria-labelledby={headingId}>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 py-4">
        <CardTitle id={headingId} className="text-sm">
          {group.label}
        </CardTitle>
        <Badge variant="secondary" className="tabular-nums">
          {group.rows.length}
        </Badge>
      </CardHeader>
      <CardContent className="px-0 pb-2">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">{`Past ${group.label.toLowerCase()}`}</caption>
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-3 pb-2 font-medium">Run</th>
                <th scope="col" className="px-3 pb-2 font-medium">Last unit</th>
                <th scope="col" className="px-3 pb-2 font-medium">Agent</th>
                <th scope="col" className="px-3 pb-2 font-medium">Model</th>
                <th scope="col" className="px-3 pb-2 font-medium">Status</th>
                <th scope="col" className="px-3 pb-2 font-medium">Started</th>
                <th scope="col" className="px-3 pb-2 font-medium">Completed</th>
                {isAdmin && (
                  <th scope="col" className="px-3 pb-2 font-medium">Owner</th>
                )}
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => (
                <HistoryRow
                  key={`${row.mode}:${row.runId}`}
                  row={row}
                  isAdmin={isAdmin}
                />
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Tabs ───────────────────────────────────────────────────────────────────────

type TabKey = "live" | "history";

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "live", label: "Live" },
  { key: "history", label: "History" },
];

function TabBar({
  active,
  onSelect,
}: {
  active: TabKey;
  onSelect: (key: TabKey) => void;
}) {
  return (
    <div role="tablist" aria-label="Activity view" className="flex gap-1 border-b border-border">
      {TABS.map((tab) => {
        const selected = tab.key === active;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            id={`activity-tab-${tab.key}`}
            aria-selected={selected}
            aria-controls={`activity-panel-${tab.key}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.key)}
            className={cn(
              "-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Live panel ───────────────────────────────────────────────────────────────────

function LivePanel() {
  const { runs, isAdmin, truncated, isLoading, error, isConnected } = useActivity();
  // A single render-time clock for the live pulse so every row agrees.
  const now = Date.now();
  const groups = useMemo(() => groupByMode(runs), [runs]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Read-only view of currently active runs. Refreshes every 5s and merges
        live updates. Metadata only — no transcripts.
      </p>

      {!isConnected && (
        <span
          className="inline-flex w-fit items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-600"
          role="status"
        >
          <WifiOff className="h-3.5 w-3.5" aria-hidden />
          Live updates disconnected — polling
        </span>
      )}

      {truncated && (
        <div
          className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600"
          role="status"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          The list was capped. Some active runs are not shown.
        </div>
      )}

      {isLoading ? (
        <CenteredState
          icon={<Loader2 className="h-5 w-5 motion-safe:animate-spin" />}
          title="Loading activity…"
        />
      ) : error ? (
        <CenteredState
          tone="destructive"
          icon={<AlertTriangle className="h-5 w-5" />}
          title="Could not load activity"
          description={errorMessage(error)}
        />
      ) : groups.length === 0 ? (
        <CenteredState
          icon={<ActivityIcon className="h-5 w-5" />}
          title="No active runs"
          description="Nothing is running right now. This view updates automatically when a run starts."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <LiveGroupTable key={group.mode} group={group} isAdmin={isAdmin} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── History panel ──────────────────────────────────────────────────────────────

function HistoryPanel() {
  const { items, isAdmin, hasMore, isLoading, isFetchingMore, error, loadMore } =
    useActivityHistory();
  const groups = useMemo(() => groupHistoryByMode(items), [items]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Read-only history of past runs across all modes. Metadata only — no
        transcripts.
      </p>

      {isLoading ? (
        <CenteredState
          icon={<Loader2 className="h-5 w-5 motion-safe:animate-spin" />}
          title="Loading history…"
        />
      ) : error ? (
        <CenteredState
          tone="destructive"
          icon={<AlertTriangle className="h-5 w-5" />}
          title="Could not load history"
          description={errorMessage(error)}
        />
      ) : groups.length === 0 ? (
        <CenteredState
          icon={<ActivityIcon className="h-5 w-5" />}
          title="No past runs"
          description="Completed, failed, and cancelled runs will appear here."
        />
      ) : (
        <>
          <div className="flex flex-col gap-4">
            {groups.map((group) => (
              <HistoryGroupTable key={group.mode} group={group} isAdmin={isAdmin} />
            ))}
          </div>
          {hasMore && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={loadMore}
                disabled={isFetchingMore}
                className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                {isFetchingMore && (
                  <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
                )}
                {isFetchingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────────

export default function Activity() {
  const [tab, setTab] = useState<TabKey>("live");

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 py-4">
        <ActivityIcon className="h-5 w-5 text-muted-foreground" aria-hidden />
        <h1 className="text-lg font-semibold tracking-tight">Activity</h1>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          <TabBar active={tab} onSelect={setTab} />

          <div
            role="tabpanel"
            id="activity-panel-live"
            aria-labelledby="activity-tab-live"
            hidden={tab !== "live"}
          >
            {tab === "live" && <LivePanel />}
          </div>
          <div
            role="tabpanel"
            id="activity-panel-history"
            aria-labelledby="activity-tab-history"
            hidden={tab !== "history"}
          >
            {tab === "history" && <HistoryPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}
