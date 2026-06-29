/**
 * TaskGroupList — multi-model task groups, GROUPED BY STATUS BUCKET to restore
 * focus when many runs pile up. Multiple groups can target the same workspace,
 * so a flat list buried the runs that actually need attention. We bucket into
 * Active (running) → Pending → Terminal (completed/failed/cancelled), each a
 * section with a count; within a section, most-recent first (createdAt desc).
 * Rows keep their existing info (name, taskCount/completedCount, status) and add
 * a relative timestamp. Presentation-only: the fetch (useTaskGroups) is unchanged.
 */
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { useTaskGroups, useDeleteTaskGroup } from "@/hooks/use-task-groups";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, ListChecks } from "lucide-react";

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

type BucketKey = "active" | "pending" | "terminal";

/** Status → bucket. Anything unrecognised falls into Pending (safest middle). */
function bucketOf(status: string): BucketKey {
  if (status === "running") return "active";
  if (status === "completed" || status === "failed" || status === "cancelled") return "terminal";
  return "pending";
}

/** Fixed section order — what needs attention first. */
const BUCKET_ORDER: { key: BucketKey; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "pending", label: "Pending" },
  { key: "terminal", label: "Terminal" },
];

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

export default function TaskGroupList() {
  const { data: groups, isLoading } = useTaskGroups();
  const deleteMutation = useDeleteTaskGroup();

  if (isLoading) {
    return <div className="p-6 text-muted-foreground">Loading task groups...</div>;
  }

  const items = (groups ?? []) as TaskGroupItem[];

  // Bucket by status, then order each bucket most-recent first.
  const buckets = new Map<BucketKey, TaskGroupItem[]>();
  for (const g of items) {
    const key = bucketOf(g.status);
    const arr = buckets.get(key);
    if (arr) arr.push(g);
    else buckets.set(key, [g]);
  }
  const sections = BUCKET_ORDER.map(({ key, label }) => ({
    key,
    label,
    items: (buckets.get(key) ?? []).sort((a, b) => createdMs(b) - createdMs(a)),
  })).filter((s) => s.items.length > 0);

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
        <div className="space-y-6">
          {sections.map((section) => (
            <section key={section.key} data-testid="task-group-section">
              <div className="flex items-baseline gap-2 mb-2 px-1">
                <h2 className="text-sm font-semibold">{section.label}</h2>
                <span className="text-[11px] text-muted-foreground">
                  {section.items.length}
                </span>
              </div>
              <div className="space-y-3">
                {section.items.map((g) => (
                  <Link key={g.id} href={`/task-groups/${g.id}`}>
                    <Card className="cursor-pointer hover:border-primary/50 transition-colors">
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-base">{g.name}</CardTitle>
                          <div className="flex items-center gap-2">
                            <Badge className={statusColors[g.status] ?? "bg-muted"}>
                              {g.status}
                            </Badge>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-red-500"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (confirm("Delete this task group?")) {
                                  deleteMutation.mutate(g.id);
                                }
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
                          <span>{g.completedCount}/{g.taskCount} tasks completed</span>
                          <span title={new Date(g.createdAt).toLocaleString()}>
                            {whenLabel(g.createdAt)}
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
