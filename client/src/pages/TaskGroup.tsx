/**
 * Task Group detail page.
 *
 * Three surfaces share this page:
 *  - the read-only run view (tasks + live activity stream + progress) — the
 *    default;
 *  - an EDIT mode (status-driven, mirrors the server which is authoritative):
 *      pending  → full edit (group name/description/input + add/remove/edit
 *                 tasks + dependsOn-by-id);
 *      terminal → relabel only (group name/description);
 *      running  → no edit controls (read-only).
 *    Edit errors surface inline: 409 = "Can't edit a running/completed group",
 *    400 = "Dependency cycle / dangling reference";
 *  - a read-only TIMELINE panel (buildTimeline) showing each task's
 *    status + startedAt→completedAt duration + model/team in chronological order.
 *    Summary/error stay behind the owner-gated detail (GET :id is owner-scoped).
 *
 * SECURITY: all group/task text is user-authored and rendered as INERT React
 * text — never via dangerouslySetInnerHTML.
 */
import { useRoute } from "wouter";
import {
  useTaskGroup,
  useStartTaskGroup,
  useCancelTaskGroup,
  useRetryTask,
  useUpdateTaskGroup,
  useUpdateTask,
  useAddTask,
  useDeleteTask,
  editErrorMessage,
} from "@/hooks/use-task-groups";
import { useTaskGroupEvents } from "@/hooks/use-task-events";
import { useActiveModels } from "@/hooks/use-pipeline";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Play,
  XCircle,
  RotateCcw,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Loader2,
  AlertCircle,
  Ban,
  Activity,
  Pencil,
  Plus,
  Save,
} from "lucide-react";
import { Link } from "wouter";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  TaskRow,
  isGroupEditable,
  isGroupRelabelOnly,
  addTaskToList,
  removeTaskFromList,
  updateTaskInList,
  validate,
  hasErrors,
  type TaskDraft,
  type GroupDraft,
  type SiblingOption,
  type ExecutionMode,
  type ModelOption,
} from "@/components/task-groups/task-form";
import {
  buildTimeline,
  formatDuration,
  timelineSpanMs,
  type TimelineEntry,
} from "@/components/task-groups/timeline";

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

// ─── Server task shape (from GET /api/task-groups/:id) ────────────────────────

interface ServerTask {
  id: string;
  name: string;
  description: string;
  status: string;
  executionMode: string;
  modelSlug: string | null;
  teamId?: string | null;
  summary: string | null;
  errorMessage: string | null;
  dependsOn: string[];
  sortOrder?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

interface ServerGroup {
  id: string;
  name: string;
  description: string;
  status: string;
  input: string;
  output: unknown;
  createdAt: string;
  tasks: ServerTask[];
}

function asExecutionMode(value: string): ExecutionMode {
  return value === "pipeline_run" ? "pipeline_run" : "direct_llm";
}

// ─── Timeline panel (read-only) ───────────────────────────────────────────────

function TimelinePanel({ entries }: { entries: readonly TimelineEntry[] }) {
  const span = timelineSpanMs(entries);
  return (
    <Card aria-labelledby="timeline-heading">
      <CardHeader className="py-3 flex flex-row items-center justify-between space-y-0">
        <CardTitle id="timeline-heading" className="text-sm font-semibold">
          Timeline
        </CardTitle>
        {span !== null && (
          <span className="text-xs text-muted-foreground tabular-nums">
            total {formatDuration(span)}
          </span>
        )}
      </CardHeader>
      <CardContent className="px-0 pb-2">
        {entries.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            No tasks to show yet.
          </p>
        ) : (
          <ol className="divide-y divide-border">
            {entries.map((e) => (
              <li key={e.id} className="flex items-start gap-3 px-4 py-2">
                <span className="mt-0.5 shrink-0">
                  <StatusBadge status={e.status} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{e.name}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    {e.executionMode && <span>{e.executionMode}</span>}
                    {e.modelSlug && <span className="font-mono">{e.modelSlug}</span>}
                    {e.teamId && <span>team: {e.teamId}</span>}
                    {e.hasRun && e.startedAt && (
                      <span title={e.startedAt}>
                        started {new Date(e.startedAt).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                </div>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatDuration(e.durationMs)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Edit form ────────────────────────────────────────────────────────────────

interface EditFormProps {
  groupId: string;
  group: ServerGroup;
  /** Full edit (pending) vs relabel-only (terminal). */
  fullEdit: boolean;
  onDone: () => void;
}

function EditForm({ groupId, group, fullEdit, onDone }: EditFormProps) {
  const updateGroup = useUpdateTaskGroup(groupId);
  const updateTask = useUpdateTask(groupId);
  const addTask = useAddTask(groupId);
  const deleteTask = useDeleteTask(groupId);
  const modelsQuery = useActiveModels();
  const models = (modelsQuery.data ?? []) as ModelOption[];

  const [draft, setDraft] = useState<GroupDraft>({
    name: group.name,
    description: group.description,
    input: group.input,
  });
  // Edit-mode tasks: dependsOn is keyed by task ID.
  const [tasks, setTasks] = useState<TaskDraft[]>(() =>
    group.tasks
      .slice()
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        executionMode: asExecutionMode(t.executionMode),
        dependsOn: t.dependsOn ?? [],
        modelSlug: t.modelSlug ?? null,
      })),
  );
  // Track which task ids existed on the server so we PATCH vs POST correctly.
  const serverTaskIds = useMemo(
    () => new Set(group.tasks.map((t) => t.id)),
    [group.tasks],
  );

  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errors = validate(draft, tasks, {
    requireInput: fullEdit,
    requireTasks: fullEdit,
  });

  const anyPending =
    updateGroup.isPending ||
    updateTask.isPending ||
    addTask.isPending ||
    deleteTask.isPending;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (hasErrors(errors)) return;
    setError(null);

    try {
      // 1. Group fields. input is only sent in full (pending) edit.
      await updateGroup.mutateAsync(
        fullEdit
          ? {
              name: draft.name.trim(),
              description: draft.description.trim(),
              input: draft.input.trim(),
            }
          : {
              name: draft.name.trim(),
              description: draft.description.trim(),
            },
      );

      if (fullEdit) {
        // 2. Deletions: server tasks no longer present in the draft.
        const draftIds = new Set(tasks.map((t) => t.id));
        for (const t of group.tasks) {
          if (!draftIds.has(t.id)) {
            await deleteTask.mutateAsync(t.id);
          }
        }

        // 3. Upserts in order (sortOrder = index).
        for (let i = 0; i < tasks.length; i++) {
          const t = tasks[i];
          const payload = {
            name: t.name.trim(),
            description: t.description.trim(),
            executionMode: t.executionMode,
            // dependsOn already references task ids; the server validates the
            // final graph (cycle / dangling → 400).
            dependsOn: t.dependsOn,
            sortOrder: i,
            // null clears any pin so the server applies its real default (never "mock").
            modelSlug: t.modelSlug,
          };
          if (serverTaskIds.has(t.id)) {
            await updateTask.mutateAsync({ taskId: t.id, ...payload });
          } else {
            await addTask.mutateAsync(payload);
          }
        }
      }

      onDone();
    } catch (err) {
      setError(editErrorMessage(err));
    }
  }

  function changeTask(id: string, updated: TaskDraft) {
    setTasks((prev) => updateTaskInList(prev, id, updated));
  }

  function removeTask(id: string) {
    // dependsOn is keyed by id here, so the shared reducer strips it cleanly.
    setTasks((prev) => removeTaskFromList(prev, id));
  }

  return (
    <form onSubmit={handleSave} noValidate className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {fullEdit ? "Edit group" : "Rename group"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="edit-name">Name *</Label>
            <Input
              id="edit-name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            {submitted && errors.name && (
              <p className="text-xs text-red-500">{errors.name}</p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-description">Description *</Label>
            <Textarea
              id="edit-description"
              rows={2}
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
            {submitted && errors.description && (
              <p className="text-xs text-red-500">{errors.description}</p>
            )}
          </div>
          {fullEdit && (
            <div className="space-y-1">
              <Label htmlFor="edit-input">Input *</Label>
              <Textarea
                id="edit-input"
                rows={4}
                value={draft.input}
                onChange={(e) => setDraft({ ...draft, input: e.target.value })}
              />
              {submitted && errors.input && (
                <p className="text-xs text-red-500">{errors.input}</p>
              )}
            </div>
          )}
          {!fullEdit && (
            <p className="text-xs text-muted-foreground">
              This group has finished, so only its name and description can be
              changed. Tasks and input are locked.
            </p>
          )}
        </CardContent>
      </Card>

      {fullEdit && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Tasks</h2>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setTasks((prev) => addTaskToList(prev))}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add task
            </Button>
          </div>

          {submitted && errors.tasks && (
            <p className="text-xs text-red-500">{errors.tasks}</p>
          )}

          {tasks.map((task, index) => {
            // EDIT mode: dependsOn keyed by task ID. Sibling option id = task id,
            // chip shows the (possibly edited) sibling name.
            const siblings: SiblingOption[] = tasks
              .filter((t) => t.id !== task.id)
              .map((t) => ({ id: t.id, name: t.name.trim() }));
            const taskErr = errors.taskErrors?.[task.id];

            return (
              <div key={task.id} className="space-y-1">
                <TaskRow
                  task={task}
                  index={index}
                  siblings={siblings}
                  models={models}
                  onChange={(updated) => changeTask(task.id, updated)}
                  onRemove={() => removeTask(task.id)}
                  disabled={anyPending}
                />
                {submitted && taskErr && (
                  <div className="px-1 space-y-0.5">
                    {taskErr.name && (
                      <p className="text-xs text-red-500">{taskErr.name}</p>
                    )}
                    {taskErr.description && (
                      <p className="text-xs text-red-500">
                        {taskErr.description}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={onDone} disabled={anyPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={anyPending}>
          <Save className="h-4 w-4 mr-2" />
          {anyPending ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </form>
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
  const [editing, setEditing] = useState(false);

  // Auto-scroll activity stream
  useEffect(() => {
    activityEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.activity.length]);

  if (isLoading || !data) {
    return <div className="p-6 text-muted-foreground">Loading...</div>;
  }

  const group = data as ServerGroup;

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

  const effectiveStatus =
    events.groupStatus !== "pending" ? events.groupStatus : group.status;
  const canStart = effectiveStatus === "pending";
  const canCancel = effectiveStatus === "running";
  const fullEdit = isGroupEditable(effectiveStatus);
  const relabelOnly = isGroupRelabelOnly(effectiveStatus);
  const canEdit = fullEdit || relabelOnly;

  const timeline = buildTimeline(group.tasks);

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
          {!editing && canEdit && (
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4 mr-2" />
              Edit
            </Button>
          )}
          {!editing && canStart && (
            <Button onClick={() => startMutation.mutate(id)} disabled={startMutation.isPending}>
              <Play className="h-4 w-4 mr-2" />
              Start
            </Button>
          )}
          {!editing && canCancel && (
            <Button variant="destructive" onClick={() => cancelMutation.mutate(id)} disabled={cancelMutation.isPending}>
              <XCircle className="h-4 w-4 mr-2" />
              Cancel
            </Button>
          )}
          {!editing && effectiveStatus !== "pending" && (
            <Link href={`/task-groups/${id}/trace`}>
              <Button variant="outline">
                <Activity className="h-4 w-4 mr-2" />
                Trace
              </Button>
            </Link>
          )}
        </div>
      </div>

      {editing ? (
        <EditForm
          groupId={id}
          group={group}
          fullEdit={fullEdit}
          onDone={() => setEditing(false)}
        />
      ) : (
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

          {/* Right column: Timeline + Activity stream */}
          <div className="space-y-3">
            <TimelinePanel entries={timeline} />

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
      )}
    </div>
  );
}
