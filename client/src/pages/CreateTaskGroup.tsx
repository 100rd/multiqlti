import { useState } from "react";
import { useLocation } from "wouter";
import { useCreateTaskGroup } from "@/hooks/use-task-groups";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { Link } from "wouter";

// ─── Types ───────────────────────────────────────────────────────────────────

type ExecutionMode = "direct_llm" | "pipeline_run";

interface TaskDraft {
  id: string; // local-only key for React rendering
  name: string;
  description: string;
  executionMode: ExecutionMode;
  dependsOn: string[]; // names of other tasks in the draft list
}

interface GroupDraft {
  name: string;
  description: string;
  input: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyTask(): TaskDraft {
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    executionMode: "direct_llm",
    dependsOn: [],
  };
}

// ─── Sub-component: single task row ──────────────────────────────────────────

interface TaskRowProps {
  task: TaskDraft;
  index: number;
  siblingNames: string[]; // names of all OTHER tasks
  onChange: (updated: TaskDraft) => void;
  onRemove: () => void;
}

function TaskRow({ task, index, siblingNames, onChange, onRemove }: TaskRowProps) {
  function toggleDep(name: string) {
    const next = task.dependsOn.includes(name)
      ? task.dependsOn.filter((d) => d !== name)
      : [...task.dependsOn, name];
    onChange({ ...task, dependsOn: next });
  }

  return (
    <Card className="relative">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Task {index + 1}
        </CardTitle>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-red-500"
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor={`task-name-${task.id}`}>Name *</Label>
            <Input
              id={`task-name-${task.id}`}
              placeholder="e.g. Summarise input"
              value={task.name}
              onChange={(e) => onChange({ ...task, name: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`task-mode-${task.id}`}>Execution mode *</Label>
            <Select
              value={task.executionMode}
              onValueChange={(v) =>
                onChange({ ...task, executionMode: v as ExecutionMode })
              }
            >
              <SelectTrigger id={`task-mode-${task.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="direct_llm">Direct LLM</SelectItem>
                <SelectItem value="pipeline_run">Pipeline run</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor={`task-desc-${task.id}`}>Description *</Label>
          <Textarea
            id={`task-desc-${task.id}`}
            placeholder="What should this task do?"
            rows={2}
            value={task.description}
            onChange={(e) => onChange({ ...task, description: e.target.value })}
          />
        </div>

        {siblingNames.length > 0 && (
          <div className="space-y-1">
            <Label>Depends on</Label>
            <div className="flex flex-wrap gap-2">
              {siblingNames.map((name) => {
                const active = task.dependsOn.includes(name);
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => toggleDep(name)}
                    className="focus:outline-none"
                  >
                    <Badge
                      className={
                        active
                          ? "bg-primary text-primary-foreground cursor-pointer"
                          : "bg-muted text-muted-foreground cursor-pointer hover:bg-muted/70"
                      }
                    >
                      {name}
                    </Badge>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Validation ───────────────────────────────────────────────────────────────

interface ValidationErrors {
  name?: string;
  description?: string;
  input?: string;
  tasks?: string;
  taskErrors?: Record<string, { name?: string; description?: string }>;
}

function validate(group: GroupDraft, tasks: TaskDraft[]): ValidationErrors {
  const errors: ValidationErrors = {};

  if (!group.name.trim()) errors.name = "Name is required.";
  if (!group.description.trim()) errors.description = "Description is required.";
  if (!group.input.trim()) errors.input = "Input is required.";
  if (tasks.length === 0) errors.tasks = "Add at least one task.";

  const taskErrors: Record<string, { name?: string; description?: string }> = {};
  tasks.forEach((t) => {
    const te: { name?: string; description?: string } = {};
    if (!t.name.trim()) te.name = "Task name is required.";
    if (!t.description.trim()) te.description = "Task description is required.";
    if (Object.keys(te).length > 0) taskErrors[t.id] = te;
  });
  if (Object.keys(taskErrors).length > 0) errors.taskErrors = taskErrors;

  return errors;
}

function hasErrors(errors: ValidationErrors): boolean {
  return (
    !!errors.name ||
    !!errors.description ||
    !!errors.input ||
    !!errors.tasks ||
    (errors.taskErrors != null && Object.keys(errors.taskErrors).length > 0)
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function CreateTaskGroup() {
  const [, navigate] = useLocation();
  const createMutation = useCreateTaskGroup();

  const [group, setGroup] = useState<GroupDraft>({
    name: "",
    description: "",
    input: "",
  });
  const [tasks, setTasks] = useState<TaskDraft[]>([emptyTask()]);
  const [submitted, setSubmitted] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const errors = validate(group, tasks);

  function updateTask(id: string, updated: TaskDraft) {
    setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
  }

  function removeTask(id: string) {
    setTasks((prev) => {
      const remaining = prev.filter((t) => t.id !== id);
      const removedName = prev.find((t) => t.id === id)?.name ?? "";
      // Remove stale dependency references
      return remaining.map((t) => ({
        ...t,
        dependsOn: t.dependsOn.filter((d) => d !== removedName),
      }));
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (hasErrors(errors)) return;

    setMutationError(null);
    try {
      const result = await createMutation.mutateAsync({
        name: group.name.trim(),
        description: group.description.trim(),
        input: group.input.trim(),
        tasks: tasks.map((t, i) => ({
          name: t.name.trim(),
          description: t.description.trim(),
          executionMode: t.executionMode,
          dependsOn: t.dependsOn,
          sortOrder: i,
        })),
      });
      const created = result as { id: string };
      navigate(`/task-groups/${created.id}`);
    } catch (err) {
      setMutationError(
        err instanceof Error ? err.message : "Failed to create task group."
      );
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/task-groups">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">New Task Group</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Define a group of tasks that run with dependency ordering
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} noValidate className="space-y-6">
        {/* Group details */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Group details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="group-name">Name *</Label>
              <Input
                id="group-name"
                placeholder="e.g. Research pipeline"
                value={group.name}
                onChange={(e) => setGroup({ ...group, name: e.target.value })}
              />
              {submitted && errors.name && (
                <p className="text-xs text-red-500">{errors.name}</p>
              )}
            </div>

            <div className="space-y-1">
              <Label htmlFor="group-description">Description *</Label>
              <Textarea
                id="group-description"
                placeholder="What does this task group accomplish?"
                rows={2}
                value={group.description}
                onChange={(e) =>
                  setGroup({ ...group, description: e.target.value })
                }
              />
              {submitted && errors.description && (
                <p className="text-xs text-red-500">{errors.description}</p>
              )}
            </div>

            <div className="space-y-1">
              <Label htmlFor="group-input">Input *</Label>
              <Textarea
                id="group-input"
                placeholder="The overall objective or context passed to all tasks"
                rows={4}
                value={group.input}
                onChange={(e) => setGroup({ ...group, input: e.target.value })}
              />
              {submitted && errors.input && (
                <p className="text-xs text-red-500">{errors.input}</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Tasks */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Tasks</h2>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setTasks((prev) => [...prev, emptyTask()])}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add task
            </Button>
          </div>

          {submitted && errors.tasks && (
            <p className="text-xs text-red-500">{errors.tasks}</p>
          )}

          {tasks.map((task, index) => {
            const siblingNames = tasks
              .filter((t) => t.id !== task.id && t.name.trim() !== "")
              .map((t) => t.name.trim());

            const taskErr = errors.taskErrors?.[task.id];

            return (
              <div key={task.id} className="space-y-1">
                <TaskRow
                  task={task}
                  index={index}
                  siblingNames={siblingNames}
                  onChange={(updated) => updateTask(task.id, updated)}
                  onRemove={() => removeTask(task.id)}
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

        {/* Mutation error */}
        {mutationError && (
          <p className="text-sm text-red-500">{mutationError}</p>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <Link href="/task-groups">
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </Link>
          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Creating..." : "Create task group"}
          </Button>
        </div>
      </form>
    </div>
  );
}
