import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Layers, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SwarmCloneResult, SwarmResult } from "@shared/types";

interface SwarmResultViewProps {
  mergedOutput: string;
  cloneResults: SwarmCloneResult[];
  swarmMeta: SwarmResult;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function CloneResultRow({ result }: { result: SwarmCloneResult }) {
  const [expanded, setExpanded] = useState(false);
  const succeeded = result.status === "succeeded";

  return (
    <div className={cn(
      "rounded border text-xs",
      succeeded ? "border-green-500/20 bg-green-500/5" : "border-destructive/20 bg-destructive/5",
    )}>
      <button
        type="button"
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left"
        onClick={() => setExpanded((p) => !p)}
      >
        {succeeded
          ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
          : <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />}
        <span className="font-mono font-medium flex-1">Clone {result.cloneIndex + 1}</span>
        {succeeded && result.tokensUsed > 0 && (
          <span className="text-[10px] font-mono text-muted-foreground">
            {result.tokensUsed.toLocaleString()} tokens
          </span>
        )}
        {result.durationMs > 0 && (
          <span className="text-[10px] font-mono text-muted-foreground">
            {formatDuration(result.durationMs)}
          </span>
        )}
        {expanded
          ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="px-3 pb-2 space-y-1.5 border-t border-border/50">
          {result.systemPromptPreview && (
            <div>
              <p className="text-[10px] text-muted-foreground font-medium mt-1.5">System prompt preview</p>
              <p className="text-[10px] font-mono text-muted-foreground/80 break-all">
                {result.systemPromptPreview}
              </p>
            </div>
          )}
          {succeeded && result.output && (
            <div>
              <p className="text-[10px] text-muted-foreground font-medium mt-1.5">Output</p>
              <pre className="text-[10px] font-mono whitespace-pre-wrap break-words text-foreground/90 max-h-48 overflow-y-auto">
                {result.output}
              </pre>
            </div>
          )}
          {!succeeded && result.error && (
            <div>
              <p className="text-[10px] text-destructive font-medium mt-1.5">Error</p>
              <p className="text-[10px] font-mono text-destructive/80">{result.error}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SwarmResultView({
  mergedOutput,
  cloneResults,
  swarmMeta,
}: SwarmResultViewProps) {
  const [clonesExpanded, setClonesExpanded] = useState(false);

  return (
    <div className="space-y-3">
      {/* Summary bar */}
      <div className="flex items-center gap-2 px-2 py-1.5 rounded border border-border bg-muted/30 text-xs">
        <Layers className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="font-medium text-muted-foreground">Swarm result</span>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground">
          {swarmMeta.succeededCount} succeeded
          {swarmMeta.failedCount > 0 && (
            <span className="text-destructive ml-1">/ {swarmMeta.failedCount} failed</span>
          )}
          {" · "}
          {swarmMeta.mergerUsed} merger
          {" · "}
          {swarmMeta.totalTokensUsed.toLocaleString()} tokens
          {" · "}
          {formatDuration(swarmMeta.durationMs)}
        </span>
      </div>

      {/* Merged output */}
      <div>
        <p className="text-[10px] font-medium text-muted-foreground mb-1">Merged output</p>
        <pre className="text-xs font-mono whitespace-pre-wrap break-words text-foreground/90 bg-muted/20 rounded border border-border p-2 max-h-80 overflow-y-auto">
          {mergedOutput}
        </pre>
      </div>

      {/* Collapsible clone outputs */}
      <div>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setClonesExpanded((p) => !p)}
        >
          {clonesExpanded
            ? <ChevronDown className="h-3 w-3" />
            : <ChevronRight className="h-3 w-3" />}
          <span>
            Clone outputs ({swarmMeta.succeededCount} succeeded
            {swarmMeta.failedCount > 0 ? `, ${swarmMeta.failedCount} failed` : ""})
          </span>
        </button>

        {clonesExpanded && (
          <div className="mt-2 space-y-1.5">
            {cloneResults.map((r) => (
              <CloneResultRow key={r.cloneIndex} result={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
