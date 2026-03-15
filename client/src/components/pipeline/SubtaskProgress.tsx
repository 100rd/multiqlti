import { CheckCircle2, Circle, Loader2, XCircle, GitBranch, Merge } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ParallelExecutionMeta } from "@shared/types";

interface SubtaskItem {
  subtaskId: string;
  title?: string;
  modelSlug?: string;
  status: "pending" | "running" | "completed" | "failed";
  tokensUsed?: number;
  durationMs?: number;
}

interface SubtaskProgressProps {
  subtasks: SubtaskItem[];
  mergeStrategy?: string;
  meta?: ParallelExecutionMeta;
  isMerging?: boolean;
}

function StatusIcon({ status }: { status: SubtaskItem["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />;
    case "completed":
      return <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />;
    case "failed":
      return <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />;
    default:
      return <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
  }
}

export default function SubtaskProgress({
  subtasks,
  mergeStrategy,
  meta,
  isMerging = false,
}: SubtaskProgressProps) {
  if (subtasks.length === 0) return null;

  const completedCount = subtasks.filter((s) => s.status === "completed").length;
  const failedCount = subtasks.filter((s) => s.status === "failed").length;
  const totalTokens = meta?.totalTokens
    ?? subtasks.reduce((sum, s) => sum + (s.tokensUsed ?? 0), 0);

  return (
    <div className="space-y-2">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <GitBranch className="h-3.5 w-3.5" />
          <span className="font-medium">
            Parallel execution — {subtasks.length} subtask{subtasks.length !== 1 ? "s" : ""}
          </span>
        </div>
        {meta && (
          <span className="text-[10px] font-mono text-muted-foreground">
            {completedCount}/{subtasks.length} done
            {failedCount > 0 && (
              <span className="text-destructive ml-1">({failedCount} failed)</span>
            )}
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            failedCount > 0 && completedCount === 0 ? "bg-destructive" : "bg-primary",
          )}
          style={{
            width: `${subtasks.length > 0 ? (completedCount / subtasks.length) * 100 : 0}%`,
          }}
        />
      </div>

      {/* Subtask list */}
      <div className="space-y-1">
        {subtasks.map((subtask) => (
          <div
            key={subtask.subtaskId}
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 rounded text-xs",
              "border border-border bg-muted/20",
              subtask.status === "running" && "bg-blue-500/5 border-blue-500/20",
              subtask.status === "completed" && "bg-green-500/5 border-green-500/20",
              subtask.status === "failed" && "bg-destructive/5 border-destructive/20",
            )}
          >
            <StatusIcon status={subtask.status} />
            <span className="flex-1 truncate font-mono">
              {subtask.title ?? subtask.subtaskId}
            </span>
            {subtask.modelSlug && (
              <span className="text-[10px] text-muted-foreground shrink-0">
                {subtask.modelSlug}
              </span>
            )}
            {subtask.durationMs !== undefined && subtask.status === "completed" && (
              <span className="text-[10px] text-muted-foreground shrink-0">
                {subtask.durationMs < 1000
                  ? `${subtask.durationMs}ms`
                  : `${(subtask.durationMs / 1000).toFixed(1)}s`}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Merge status */}
      {(isMerging || meta) && (
        <div
          className={cn(
            "flex items-center gap-2 px-2 py-1.5 rounded text-xs border",
            isMerging
              ? "border-primary/30 bg-primary/5 text-primary"
              : "border-green-500/20 bg-green-500/5 text-green-600 dark:text-green-400",
          )}
        >
          {isMerging ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
          ) : (
            <Merge className="h-3.5 w-3.5 shrink-0" />
          )}
          <span>
            {isMerging
              ? `Merging results (${mergeStrategy ?? "auto"})...`
              : `Merged ${meta?.succeededCount ?? completedCount} subtask${(meta?.succeededCount ?? completedCount) !== 1 ? "s" : ""} — ${mergeStrategy ?? "auto"} strategy`}
          </span>
          {!isMerging && totalTokens > 0 && (
            <span className="ml-auto text-[10px] font-mono text-muted-foreground">
              {totalTokens.toLocaleString()} tokens
            </span>
          )}
        </div>
      )}
    </div>
  );
}
