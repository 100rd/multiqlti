/**
 * SwarmResultView — Display merged output plus expandable per-clone outputs.
 *
 * Shown after a run completes when swarm data is present for a stage.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Clock, Zap, GitMerge } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SwarmMerger, SwarmSplitter } from "./SwarmConfigPanel";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SwarmCloneResult {
  cloneIndex: number;
  status: "succeeded" | "failed";
  output?: string;
  error?: string;
  tokensUsed: number;
  durationMs: number;
  systemPromptPreview: string;
}

export interface SwarmMeta {
  succeededCount: number;
  failedCount: number;
  totalTokensUsed: number;
  mergerUsed: SwarmMerger;
  splitterUsed: SwarmSplitter;
  durationMs: number;
}

export interface SwarmResultViewProps {
  mergedOutput: string;
  cloneResults: SwarmCloneResult[];
  meta: SwarmMeta;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ─── Clone output card ────────────────────────────────────────────────────────

interface CloneOutputCardProps {
  clone: SwarmCloneResult;
}

function CloneOutputCard({ clone }: CloneOutputCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={cn(
        "rounded border bg-background",
        clone.status === "succeeded"
          ? "border-green-500/20"
          : "border-destructive/20",
      )}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        aria-expanded={expanded}
        aria-label={`Clone ${clone.cloneIndex + 1} output details`}
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setExpanded((v) => !v)}
      >
        {clone.status === "succeeded" ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" aria-hidden="true" />
        ) : (
          <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" aria-hidden="true" />
        )}

        <span className="text-xs font-mono font-medium shrink-0">
          Clone {clone.cloneIndex + 1}
        </span>

        {/* Status badge */}
        <Badge
          className={cn(
            "text-[10px] h-4 px-1.5 shrink-0",
            clone.status === "succeeded"
              ? "bg-green-500/20 text-green-700 dark:text-green-400"
              : "bg-destructive/20 text-destructive",
          )}
        >
          {clone.status}
        </Badge>

        {/* System prompt preview */}
        {clone.systemPromptPreview && (
          <span className="text-[10px] text-muted-foreground truncate flex-1 italic">
            {clone.systemPromptPreview}
          </span>
        )}

        {/* Stats */}
        <div className="flex items-center gap-3 ml-auto shrink-0">
          {clone.tokensUsed > 0 && (
            <span className="text-[10px] font-mono text-muted-foreground flex items-center gap-1">
              <Zap className="h-2.5 w-2.5" aria-hidden="true" />
              {formatTokens(clone.tokensUsed)}
            </span>
          )}
          <span className="text-[10px] font-mono text-muted-foreground flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" aria-hidden="true" />
            {formatDuration(clone.durationMs)}
          </span>
          {expanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 border-t border-border pt-2 space-y-2">
          {clone.status === "failed" && clone.error && (
            <div className="rounded bg-destructive/10 border border-destructive/20 px-3 py-2">
              <p className="text-xs text-destructive font-mono">{clone.error}</p>
            </div>
          )}
          {clone.status === "succeeded" && clone.output && (
            <pre className="text-xs font-mono whitespace-pre-wrap bg-muted/30 rounded p-3 border border-border overflow-auto max-h-64">
              {clone.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ─── SwarmResultView (exported) ───────────────────────────────────────────────

export default function SwarmResultView({
  mergedOutput,
  cloneResults,
  meta,
}: SwarmResultViewProps) {
  const [clonesExpanded, setClonesExpanded] = useState(false);

  const sortedClones = [...cloneResults].sort((a, b) => a.cloneIndex - b.cloneIndex);

  return (
    <div className="space-y-4" aria-label="Swarm result">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center gap-3 px-3 py-2 rounded border border-border bg-muted/20 text-[10px] font-mono text-muted-foreground">
        <span className="flex items-center gap-1">
          <GitMerge className="h-3 w-3" aria-hidden="true" />
          {meta.splitterUsed} → {meta.mergerUsed}
        </span>
        <span className="flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3 text-green-500" aria-hidden="true" />
          {meta.succeededCount} succeeded
        </span>
        {meta.failedCount > 0 && (
          <span className="flex items-center gap-1 text-destructive">
            <XCircle className="h-3 w-3" aria-hidden="true" />
            {meta.failedCount} failed
          </span>
        )}
        <span className="flex items-center gap-1">
          <Zap className="h-3 w-3" aria-hidden="true" />
          {formatTokens(meta.totalTokensUsed)} tokens
        </span>
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" aria-hidden="true" />
          {formatDuration(meta.durationMs)}
        </span>
      </div>

      {/* Merged output */}
      <div className="space-y-1">
        <h4 className="text-xs font-semibold text-foreground">Merged Output</h4>
        <pre className="text-xs font-mono whitespace-pre-wrap bg-muted/30 rounded p-4 border border-border overflow-auto">
          {mergedOutput}
        </pre>
      </div>

      {/* Collapsible clone outputs */}
      <div className="space-y-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs w-full flex items-center justify-between px-3 rounded border border-border bg-muted/10 hover:bg-muted/30"
          onClick={() => setClonesExpanded((v) => !v)}
          aria-expanded={clonesExpanded}
          aria-controls="swarm-clone-outputs"
        >
          <span>
            Clone Outputs ({meta.succeededCount} succeeded
            {meta.failedCount > 0 && `, ${meta.failedCount} failed`})
          </span>
          {clonesExpanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
        </Button>

        {clonesExpanded && (
          <div id="swarm-clone-outputs" className="space-y-2">
            {sortedClones.map((clone) => (
              <CloneOutputCard key={clone.cloneIndex} clone={clone} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
