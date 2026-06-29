/**
 * TaskGroupList — multi-model task groups, rendered as an ITERATION LINEAGE TREE
 * (YAML-style nesting) instead of the prior status buckets. Each task GROUP is a
 * PARENT node and its ITERATIONS nest beneath it, indented with a tree connector
 * (border-left). Iteration 1 sits on top; later iterations — the inherited
 * re-runs — follow under the same parent.
 *
 * WHERE THE ITERATIONS COME FROM: the LIST endpoint (`GET /api/task-groups`)
 * returns group rows WITHOUT iterations (just name/status/taskCount/
 * completedCount/createdAt). The iterations live on a separate endpoint,
 * `GET /api/task-groups/:id/iterations` → `{ items: IterationSummary[] }`. So
 * each group renders as a COLLAPSIBLE parent that fetches its iterations ON
 * EXPAND (the query is `enabled` only while the node is open, so a collapsed
 * group fetches nothing). Active (running/pending) groups default expanded;
 * terminal groups default collapsed. We render only fields the endpoints return
 * — group: name/status/taskCount/completedCount/createdAt; iteration:
 * iterationNumber/status/completedCount/taskCount/startedAt/completedAt. Nothing
 * invented.
 *
 * Presentation-only: the group fetch (useTaskGroups) is unchanged; the
 * iterations query reuses the shared apiRequest transport (carries x-project-id).
 */
import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { useTaskGroups, useDeleteTaskGroup } from "@/hooks/use-task-groups";
import { apiRequest } from "@/hooks/use-pipeline";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Trash2,
  ListChecks,
  ChevronRight,
  ChevronDown,
  Loader2,
} from "lucide-react";

const statusColors: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-blue-500 text-white",
  completed: "bg-green-600 text-white",
  failed: "bg-red-600 text-white",
  cancelled: "bg-gray-500 text-white",
};

type TaskGroupItem = {
  id: string;
  name: string;
  description: string;
  status: string;
  taskCount: number;
  completedCount: number;
  createdAt: string;
};

/** Iteration summary as returned by GET /api/task-groups/:id/iterations. */
type IterationSummary = {
  iterationNumber: number;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  completedCount: number;
  taskCount: number;
};

/** Terminal task-group statuses — these never re-run, so default collapsed. */
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Relative "2h ago" label; empty string for missing/unparseable timestamps. */
function whenLabel(ts: string | null | undefined): string {
  if (!ts) return "";
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return "";
  }
}

function createdMs(g: TaskGroupItem): number {
  const t = new Date(g.createdAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

// ─── Per-iteration leaf (the inherited re-run signal) ─────────────────────────

/** One iteration line in the lineage tree: number, status, progress, time. */
function IterationLine({ it }: { it: IterationSummary }) {
  return (
    <li
      data-testid="task-group-iteration"
      className="flex items-center gap-2 text-xs py-0.5"
    >
      <span className="font-medium tabular-nums shrink-0">
        Iteration {it.iterationNumber}
      </span>
      <Badge className={`${statusColors[it.status] ?? "bg-muted"} text-[10px] px-1.5 py-0`}>
        {it.status}
      </Badge>
      <span className="text-muted-foreground tabular-nums">
        {it.completedCount}/{it.taskCount}
      </span>
      <span
        className="ml-auto text-muted-foreground whitespace-nowrap"
        title={
          (it.completedAt ?? it.startedAt)
            ? new Date((it.completedAt ?? it.startedAt) as string).toLocaleString()
            : undefined
        }
      >
        {whenLabel(it.completedAt ?? it.startedAt)}
      </span>
    </li>
  );
}

// ─── Group parent node (collapsible; iterations fetched on expand) ─────────────

function GroupNode({
  g,
  onDelete,
}: {
  g: TaskGroupItem;
  onDelete: (id: string) => void;
}) {
  const [, navigate] = useLocation();
  const terminal = isTerminalStatus(g.status);
  const [expanded, setExpanded] = useState(!terminal);

  // Iterations live on a separate endpoint — fetch ONLY while expanded; keep a
  // light poll while the group is still active so live re-runs stream in.
  const { data, isLoading } = useQuery<{ items: IterationSummary[] }>({
    queryKey: ["/api/task-groups", g.id, "iterations"],
    queryFn: () => apiRequest("GET", `/api/task-groups/${g.id}/iterations`),
    enabled: expanded,
    refetchInterval: expanded && !terminal ? 3000 : false,
  });
  // Iteration 1 on top — sort ascending; endpoint order isn't guaranteed.
  const iterations = [...(data?.items ?? [])].sort(
    (a, b) => a.iterationNumber - b.iterationNumber,
  );

  return (
    <Card data-testid="task-group-node" className="overflow-hidden">
      {/* Parent header — clicking it opens the group detail; chevron toggles. */}
      <div
        className="cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => navigate(`/task-groups/${g.id}`)}
      >
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                aria-label={expanded ? "Collapse iterations" : "Expand iterations"}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded((v) => !v);
                }}
              >
                {expanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </button>
              <CardTitle className="text-base truncate">{g.name}</CardTitle>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Badge className={statusColors[g.status] ?? "bg-muted"}>{g.status}</Badge>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-red-500"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (confirm("Delete this task group?")) onDelete(g.id);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground line-clamp-2">{g.description}</p>
          <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
            <span>
              {g.completedCount}/{g.taskCount} tasks completed
            </span>
            <span title={new Date(g.createdAt).toLocaleString()}>
              {whenLabel(g.createdAt)}
            </span>
          </div>
        </CardContent>
      </div>

      {/* Nested iterations — YAML-style indentation with a border-left connector. */}
      {expanded && (
        <div className="border-t border-border px-6 py-3">
          <ol className="ml-2 border-l border-border/70 pl-4 space-y-0.5">
            {isLoading && iterations.length === 0 && (
              <li className="flex items-center gap-2 text-xs text-muted-foreground py-0.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading iterations…
              </li>
            )}
            {!isLoading && iterations.length === 0 && (
              <li className="text-xs text-muted-foreground py-0.5">
                No iterations yet
              </li>
            )}
            {iterations.map((it) => (
              <IterationLine key={it.iterationNumber} it={it} />
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
}

export default function TaskGroupList() {
  const { data: groups, isLoading } = useTaskGroups();
  const deleteMutation = useDeleteTaskGroup();

  if (isLoading) {
    return <div className="p-6 text-muted-foreground">Loading task groups...</div>;
  }

  const items = (groups ?? []) as TaskGroupItem[];
  // Most-recent first — the lineage tree reads top-to-bottom by recency.
  const ordered = [...items].sort((a, b) => createdMs(b) - createdMs(a));

  return (
    // MainLayout's <main> clips overflow, so this page owns its own vertical
    // scroll — otherwise a long list of task groups gets cut off at the fold.
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Task Groups</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Coordinate multi-model task execution with dependency graphs
            </p>
          </div>
          <Link href="/task-groups/new">
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              New Task Group
            </Button>
          </Link>
        </div>

        {items.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <ListChecks className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No task groups yet. Create one to get started.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {ordered.map((g) => (
              <GroupNode key={g.id} g={g} onDelete={(id) => deleteMutation.mutate(id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}