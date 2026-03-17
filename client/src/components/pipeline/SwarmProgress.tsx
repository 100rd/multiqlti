import { CheckCircle2, Circle, Loader2, XCircle, GitMerge, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SwarmCloneResult, SwarmMerger } from "@shared/types";

interface SwarmProgressProps {
  cloneCount: number;
  cloneResults: Partial<SwarmCloneResult>[];
  isCompleted: boolean;
  isMerging?: boolean;
  mergerUsed?: SwarmMerger;
}

type CloneStatus = "pending" | "running" | "succeeded" | "failed";

function cloneStatus(result: Partial<SwarmCloneResult> | undefined): CloneStatus {
  if (!result) return "pending";
  if (result.status === "succeeded") return "succeeded";
  if (result.status === "failed") return "failed";
  return "running";
}

function StatusIcon({ status }: { status: CloneStatus }) {
  switch (status) {
    case "running":
      return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />;
    case "succeeded":
      return <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />;
    case "failed":
      return <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />;
    default:
      return <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
  }
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function CloneCard({
  cloneIndex,
  result,
}: {
  cloneIndex: number;
  result: Partial<SwarmCloneResult> | undefined;
}) {
  const status = cloneStatus(result);
  return (
    <div
      className={cn(
        "flex items-start gap-2 px-2 py-1.5 rounded text-xs border",
        "bg-muted/20 border-border",
        status === "running" && "bg-blue-500/5 border-blue-500/20",
        status === "succeeded" && "bg-green-500/5 border-green-500/20",
        status === "failed" && "bg-destructive/5 border-destructive/20",
      )}
    >
      <StatusIcon status={status} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono font-medium">Clone {cloneIndex + 1}</span>
          {result?.durationMs !== undefined && status === "succeeded" && (
            <span className="text-[10px] text-muted-foreground shrink-0">
              {formatDuration(result.durationMs)}
            </span>
          )}
        </div>
        {result?.systemPromptPreview && (
          <p className="text-[10px] text-muted-foreground truncate mt-0.5">
            {result.systemPromptPreview}
          </p>
        )}
        {status === "succeeded" && result?.tokensUsed !== undefined && result.tokensUsed > 0 && (
          <span className="text-[10px] font-mono text-muted-foreground">
            {result.tokensUsed.toLocaleString()} tokens
          </span>
        )}
        {status === "failed" && result?.error && (
          <p className="text-[10px] text-destructive mt-0.5 truncate">{result.error}</p>
        )}
      </div>
    </div>
  );
}

export default function SwarmProgress({
  cloneCount,
  cloneResults,
  isCompleted,
  isMerging = false,
  mergerUsed,
}: SwarmProgressProps) {
  const resultByIndex = new Map(cloneResults.map((r) => [r.cloneIndex ?? -1, r]));
  const succeededCount = cloneResults.filter((r) => r.status === "succeeded").length;
  const failedCount = cloneResults.filter((r) => r.status === "failed").length;
  const completedCount = succeededCount + failedCount;

  const progressPct = cloneCount > 0 ? (completedCount / cloneCount) * 100 : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Layers className="h-3.5 w-3.5" />
          <span className="font-medium">
            Swarm — {cloneCount} clone{cloneCount !== 1 ? "s" : ""}
          </span>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">
          {completedCount}/{cloneCount} done
          {failedCount > 0 && (
            <span className="text-destructive ml-1">({failedCount} failed)</span>
          )}
        </span>
      </div>

      <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            failedCount > 0 && succeededCount === 0 ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <div className="space-y-1">
        {Array.from({ length: cloneCount }, (_, i) => (
          <CloneCard key={i} cloneIndex={i} result={resultByIndex.get(i)} />
        ))}
      </div>

      {(isMerging || isCompleted) && completedCount > 0 && (
        <div
          className={cn(
            "flex items-center gap-2 px-2 py-1.5 rounded text-xs border",
            isMerging
              ? "border-primary/30 bg-primary/5 text-primary"
              : "border-green-500/20 bg-green-500/5 text-green-600 dark:text-green-400",
          )}
        >
          {isMerging
            ? <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
            : <GitMerge className="h-3.5 w-3.5 shrink-0" />}
          <span>
            {isMerging
              ? `Merging ${succeededCount} clone result${succeededCount !== 1 ? "s" : ""}${mergerUsed ? ` (${mergerUsed})` : ""}...`
              : `Merged ${succeededCount} clone${succeededCount !== 1 ? "s" : ""} — ${mergerUsed ?? "concatenate"}`}
          </span>
        </div>
      )}
    </div>
  );
}
