/**
 * SwarmProgress — Live clone progress during a swarm run.
 *
 * Displayed in PipelineRun.tsx when a swarm stage is active.
 * Mirrors SubtaskProgress.tsx layout patterns for visual consistency.
 */
import { CheckCircle2, Circle, Loader2, XCircle, Copy, Merge } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SwarmMerger } from "./SwarmConfigPanel";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SwarmCloneState {
  cloneIndex: number;
  status: "pending" | "running" | "succeeded" | "failed";
  tokensUsed?: number;
  outputPreview?: string;
  error?: string;
  durationMs?: number;
  systemPromptPreview?: string;
}

export interface SwarmProgressProps {
  cloneCount: number;
  cloneResults: SwarmCloneState[];
  isCompleted: boolean;
  isMerging: boolean;
  mergerUsed?: SwarmMerger;
}

// ─── Status icon (mirrors SubtaskProgress) ───────────────────────────────────

function StatusIcon({ status }: { status: SwarmCloneState["status"] }) {
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

// ─── SwarmProgress ───────────────────────────────────────────────────────────

export default function SwarmProgress({
  cloneCount,
  cloneResults,
  isCompleted,
  isMerging,
  mergerUsed,
}: SwarmProgressProps) {
  // Build a map so we always render exactly cloneCount rows, filling in
  // "pending" for clones that have not yet emitted a WS event.
  const resultsByIndex = new Map(cloneResults.map((r) => [r.cloneIndex, r]));

  const rows: SwarmCloneState[] = Array.from({ length: cloneCount }, (_, i) => {
    return resultsByIndex.get(i) ?? { cloneIndex: i, status: "pending" };
  });

  const succeededCount = rows.filter((r) => r.status === "succeeded").length;
  const failedCount = rows.filter((r) => r.status === "failed").length;
  const totalTokens = rows.reduce((sum, r) => sum + (r.tokensUsed ?? 0), 0);

  return (
    <div className="space-y-2" aria-label="Swarm clone progress">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="font-medium">
            Swarm execution — {cloneCount} clone{cloneCount !== 1 ? "s" : ""}
          </span>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">
          {succeededCount}/{cloneCount} done
          {failedCount > 0 && (
            <span className="text-destructive ml-1">({failedCount} failed)</span>
          )}
        </span>
      </div>

      {/* Progress bar */}
      <div
        className="h-1 w-full rounded-full bg-muted overflow-hidden"
        role="progressbar"
        aria-valuenow={succeededCount}
        aria-valuemin={0}
        aria-valuemax={cloneCount}
        aria-label={`${succeededCount} of ${cloneCount} clones completed`}
      >
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            failedCount > 0 && succeededCount === 0
              ? "bg-destructive"
              : "bg-primary",
          )}
          style={{
            width: `${cloneCount > 0 ? (succeededCount / cloneCount) * 100 : 0}%`,
          }}
        />
      </div>

      {/* Clone rows */}
      <div className="space-y-1">
        {rows.map((clone) => (
          <div
            key={clone.cloneIndex}
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 rounded text-xs",
              "border border-border bg-muted/20",
              clone.status === "running" && "bg-blue-500/5 border-blue-500/20",
              clone.status === "succeeded" && "bg-green-500/5 border-green-500/20",
              clone.status === "failed" && "bg-destructive/5 border-destructive/20",
            )}
            aria-label={`Clone ${clone.cloneIndex + 1}: ${clone.status}`}
          >
            <StatusIcon status={clone.status} />

            <span className="font-mono text-muted-foreground shrink-0">
              Clone {clone.cloneIndex + 1}
            </span>

            {clone.status === "running" && clone.systemPromptPreview && (
              <span className="flex-1 truncate text-muted-foreground/70 italic">
                {clone.systemPromptPreview}
              </span>
            )}

            {clone.status === "succeeded" && clone.outputPreview && (
              <span className="flex-1 truncate text-muted-foreground/70 italic">
                {clone.outputPreview}
              </span>
            )}

            {clone.status === "failed" && clone.error && (
              <span className="flex-1 truncate text-destructive">
                {clone.error}
              </span>
            )}

            {clone.status !== "running" && clone.status !== "pending" && (
              <div className="flex items-center gap-2 ml-auto shrink-0">
                {clone.durationMs !== undefined && (
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {clone.durationMs < 1000
                      ? `${clone.durationMs}ms`
                      : `${(clone.durationMs / 1000).toFixed(1)}s`}
                  </span>
                )}
                {clone.tokensUsed !== undefined && clone.tokensUsed > 0 && (
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {clone.tokensUsed.toLocaleString()} tok
                  </span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Merge status — shown when merging or after completion */}
      {(isMerging || isCompleted) && (
        <div
          className={cn(
            "flex items-center gap-2 px-2 py-1.5 rounded text-xs border",
            isMerging
              ? "border-primary/30 bg-primary/5 text-primary"
              : "border-green-500/20 bg-green-500/5 text-green-600 dark:text-green-400",
          )}
          aria-live="polite"
        >
          {isMerging ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
          ) : (
            <Merge className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          <span>
            {isMerging
              ? `Merging ${succeededCount} result${succeededCount !== 1 ? "s" : ""}${mergerUsed ? ` (${mergerUsed})` : ""}...`
              : `Merged ${succeededCount} clone${succeededCount !== 1 ? "s" : ""} — ${mergerUsed ?? "concatenate"} strategy`}
          </span>
          {!isMerging && totalTokens > 0 && (
            <span className="ml-auto text-[10px] font-mono text-muted-foreground">
              {totalTokens.toLocaleString()} tokens total
            </span>
          )}
        </div>
      )}
    </div>
  );
}
