/**
 * Shared task-group form pieces, used by BOTH CreateTaskGroup.tsx (create) and
 * TaskGroup.tsx (edit mode). The PURE logic lives in ./task-form-logic (no React
 * imports, node-testable without jsdom); this file owns the presentational
 * TaskRow and re-exports the logic so callers have a single import surface.
 *
 * SECURITY: all task/group text is user-authored and rendered as INERT React
 * text (value/children) — never via dangerouslySetInnerHTML.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Trash2 } from "lucide-react";
import {
  toggleDependency,
  type TaskDraft,
  type SiblingOption,
  type ExecutionMode,
} from "./task-form-logic";

// Re-export the pure logic so existing import sites keep using "@/components/task-groups/task-form".
export {
  emptyTask,
  isGroupEditable,
  isGroupRelabelOnly,
  toggleDependency,
  updateTaskInList,
  removeTaskFromList,
  addTaskToList,
  validate,
  hasErrors,
} from "./task-form-logic";
export type {
  ExecutionMode,
  TaskDraft,
  GroupDraft,
  SiblingOption,
  ValidationErrors,
  ValidateOptions,
  TaskGroupStatus,
} from "./task-form-logic";

// ─── TaskRow (presentational) ────────────────────────────────────────────────

interface TaskRowProps {
  task: TaskDraft;
  index: number;
  /** Sibling options for the dependsOn picker (chip = name, toggles id). */
  siblings: readonly SiblingOption[];
  onChange: (updated: TaskDraft) => void;
  onRemove: () => void;
  /** When true the row is read-only (no inputs, no remove). */
  disabled?: boolean;
}

export function TaskRow({
  task,
  index,
  siblings,
  onChange,
  onRemove,
  disabled = false,
}: TaskRowProps) {
  return (
    <Card className="relative">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Task {index + 1}
        </CardTitle>
        {!disabled && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-red-500"
            onClick={onRemove}
            aria-label={`Remove task ${index + 1}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor={`task-name-${task.id}`}>Name *</Label>
            <Input
              id={`task-name-${task.id}`}
              placeholder="e.g. Summarise input"
              value={task.name}
              disabled={disabled}
              onChange={(e) => onChange({ ...task, name: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`task-mode-${task.id}`}>Execution mode *</Label>
            <Select
              value={task.executionMode}
              disabled={disabled}
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
            disabled={disabled}
            onChange={(e) => onChange({ ...task, description: e.target.value })}
          />
        </div>

        {siblings.length > 0 && (
          <div className="space-y-1">
            <Label>Depends on</Label>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Dependencies"
            >
              {siblings.map((sibling) => {
                const active = task.dependsOn.includes(sibling.id);
                return (
                  <button
                    key={sibling.id}
                    type="button"
                    disabled={disabled}
                    aria-pressed={active}
                    onClick={() => onChange(toggleDependency(task, sibling.id))}
                    className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Badge
                      className={
                        active
                          ? "bg-primary text-primary-foreground cursor-pointer"
                          : "bg-muted text-muted-foreground cursor-pointer hover:bg-muted/70"
                      }
                    >
                      {sibling.name || "(unnamed)"}
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
