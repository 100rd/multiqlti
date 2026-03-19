import { useRoute } from "wouter";
import { useTaskGroup, useStartTaskGroup, useCancelTaskGroup, useRetryTask } from "@/hooks/use-task-groups";
import { useTaskGroupEvents } from "@/hooks/use-task-events";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Play, XCircle, RotateCcw, ArrowLeft, CheckCircle2, Clock, Loader2, AlertCircle, Ban, Activity } from "lucide-react";
import { Link } from "wouter";
import { useEffect, useRef } from "react";

// ─── Status badges ──────────────────────────────────────────────────────────

const statusConfig: Record<string, { color: string; icon: React.ReactNode }> = {
  pending: { color: "bg-muted text-muted-foreground", icon: <Clock className="h-3 w-3" /> },
  blocked: { color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200", icon: <Clock className="h-3 w-3" /> },
  ready: { color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200", icon: <Play className="h-3 w-3" /> },
  running: { color: "bg-blue-500 text-white", icon: <Loader2 className="h-3 w-3 animate-spin" /> },
  completed: { color: "bg-green-600 text-white", icon: <CheckCircle2 className="h-3 w-3" /> },
  failed: { color: "bg-red-600 text-white", icon: <AlertCircle className="h-3 w-3" /> },
  cancelled: { color: "bg-gray-500 text-white", icon: <Ban className="h-3 w-3" /> },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = statusConfig[status] ?? statusConfig.pending;
  return (
    <Badge className={`${cfg.color} gap-1`}>
      {cfg.icon}
      {status}
    </Badge>
  );
}

// ─── Task Group Detail Page ─────────────────────────────────────────────────

export default function TaskGroupPage() {
  const [, params] = useRoute("/task-groups/:id");
  const id = params?.id ?? "";

  const { data, isLoading } = useTaskGroup(id);
  const events = useTaskGroupEvents(id);
  const startMutation = useStartTaskGroup();
  const cancelMutation = useCancelTaskGroup();
  const retryMutation = useRetryTask();
  const activityEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll activity stream
  useEffect(() => {
    activityEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.activity.length]);

  if (isLoading || !data) {
    return <div className="p-6 text-muted-foreground">Loading...</div>;
  }

  const group = data as {
    id: string;
    name: string;
    description: string;
    status: string;
    input: string;
    output: unknown;
    createdAt: string;
    tasks: Array<{
      id: string;
      name: string;
      description: string;
      status: string;
      executionMode: string;
      modelSlug: string | null;
      summary: string | null;
      errorMessage: string | null;
      dependsOn: string[];
    }>;
  };

  // Merge WS events into task statuses for real-time display
  const taskNameMap = new Map(group.tasks.map((t) => [t.id, t.name]));
  const mergedTasks = group.tasks.map((t) => {
    const wsInfo = events.tasks.get(t.id);
    return {
      ...t,
      status: wsInfo?.status ?? t.status,
      summary: wsInfo?.summary ?? t.summary,
      error: wsInfo?.error ?? t.errorMessage,
    };
  });

  const effectiveStatus = events.groupStatus !== "pending" ? events.groupStatus : group.status;
  const canStart = effectiveStatus === "pending";
  const canCancel = effectiveStatus === "running";

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/task-groups">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{group.name}</h1>
            <StatusBadge status={effectiveStatus} />
          </div>
          <p className="text-sm text-muted-foreground mt-1">{group.description}</p>
        </div>
        <div className="flex gap-2">
          {canStart && (
            <Button onClick={() => startMutation.mutate(id)} disabled={startMutation.isPending}>
              <Play className="h-4 w-4 mr-2" />
              Start
            </Button>
          )}
          {canCancel && (
            <Button variant="destructive" onClick={() => cancelMutation.mutate(id)} disabled={cancelMutation.isPending}>
              <XCircle className="h-4 w-4 mr-2" />
              Cancel
            </Button>
          )}
          {effectiveStatus !== "pending" && (
            <Link href={`/task-groups/${id}/trace`}>
              <Button variant="outline">
                <Activity className="h-4 w-4 mr-2" />
                Trace
              </Button>
            </Link>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Tasks panel */}
        <div className="lg:col-span-2 space-y-3">
          <h2 className="text-lg font-semibold">Tasks</h2>
          {mergedTasks.map((t) => (
            <Card key={t.id} className={t.status === "running" ? "border-blue-500/50" : ""}>
              <CardHeader className="py-3 pb-1">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium">{t.name}</CardTitle>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={t.status} />
                    {t.status === "failed" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => retryMutation.mutate({ groupId: id, taskId: t.id })}
                        disabled={retryMutation.isPending}
                      >
                        <RotateCcw className="h-3 w-3 mr-1" />
                        Retry
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="py-2 space-y-1">
                <p className="text-xs text-muted-foreground">{t.description}</p>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{t.executionMode}</span>
                  {t.modelSlug && <span>{t.modelSlug}</span>}
                  {t.dependsOn.length > 0 && (
                    <span>
                      depends on: {t.dependsOn.map((d) => taskNameMap.get(d) ?? d.slice(0, 8)).join(", ")}
                    </span>
                  )}
                </div>
                {t.summary && (
                  <div className="mt-2 p-2 bg-green-50 dark:bg-green-950 rounded text-xs text-green-800 dark:text-green-200">
                    {t.summary}
                  </div>
                )}
                {t.error && (
                  <div className="mt-2 p-2 bg-red-50 dark:bg-red-950 rounded text-xs text-red-800 dark:text-red-200">
                    {t.error}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Activity stream */}
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Activity</h2>
          <Card>
            <CardContent className="p-0">
              <div className="max-h-[600px] overflow-y-auto p-3 space-y-2 font-mono text-xs">
                {events.activity.length === 0 ? (
                  <p className="text-muted-foreground text-center py-8">
                    {effectiveStatus === "pending" ? "Start the group to see activity" : "No activity yet"}
                  </p>
                ) : (
                  events.activity.map((entry, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="text-muted-foreground shrink-0">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                      <span
                        className={
                          entry.type.includes("failed") ? "text-red-500" :
                          entry.type.includes("completed") ? "text-green-500" :
                          entry.type.includes("started") ? "text-blue-500" :
                          "text-foreground"
                        }
                      >
                        {entry.message}
                      </span>
                    </div>
                  ))
                )}
                <div ref={activityEndRef} />
              </div>
            </CardContent>
          </Card>

          {/* Progress summary */}
          {effectiveStatus === "running" && (
            <Card>
              <CardContent className="py-3">
                <div className="text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Completed</span>
                    <span className="font-medium">{events.completedCount}/{events.totalCount || group.tasks.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Running</span>
                    <span className="font-medium">{events.runningCount}</span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2 mt-2">
                    <div
                      className="bg-green-500 h-2 rounded-full transition-all"
                      style={{
                        width: `${((events.completedCount / (events.totalCount || group.tasks.length)) * 100) || 0}%`,
                      }}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
