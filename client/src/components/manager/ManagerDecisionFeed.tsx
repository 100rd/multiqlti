import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, CheckCircle2, XCircle, ArrowRight } from "lucide-react";
import { useWebSocket } from "@/hooks/use-websocket";
import { useManagerIterations } from "@/hooks/use-manager-iterations";
import type { WsEvent } from "@shared/types";
import { cn } from "@/lib/utils";

interface ManagerDecisionFeedProps {
  runId: string;
  isRunActive: boolean;
}

interface DecisionEntry {
  iterationNumber: number;
  action: "dispatch" | "complete" | "fail";
  teamId?: string;
  task?: string;
  reasoning: string;
  tokensUsed: number;
  timestamp: string;
  teamResult?: string;
  type: "decision";
}

interface CompleteEntry {
  type: "complete";
  status: "completed" | "failed";
  totalIterations: number;
  outcome: string;
  totalTokensUsed: number;
  totalDurationMs: number;
  timestamp: string;
}

interface ErrorEntry {
  type: "error";
  iteration: number;
  error: string;
  timestamp: string;
}

type FeedEntry = DecisionEntry | CompleteEntry | ErrorEntry;

const actionColors = {
  dispatch: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  complete: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  fail: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

export function ManagerDecisionFeed({ runId, isRunActive }: ManagerDecisionFeedProps) {
  const { lastEvent } = useWebSocket(runId);
  const { data: iterationData, refetch } = useManagerIterations(runId, isRunActive);
  const feedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new events
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [lastEvent, iterationData]);

  // Convert stored iterations + live WS events to a unified feed
  const storedIterations = iterationData?.iterations ?? [];

  const feedEntries: FeedEntry[] = storedIterations.map((iter) => ({
    type: "decision" as const,
    iterationNumber: iter.iterationNumber,
    action: (iter.decision as { action: string }).action as "dispatch" | "complete" | "fail",
    teamId: (iter.decision as { teamId?: string }).teamId,
    task: (iter.decision as { task?: string }).task,
    reasoning: (iter.decision as { reasoning: string }).reasoning,
    tokensUsed: iter.tokensUsed,
    timestamp: new Date(iter.createdAt).toISOString(),
    teamResult: iter.teamResult ?? undefined,
  }));

  // Add live WS complete/error events not yet in DB
  const liveEvent = lastEvent as WsEvent | null;
  if (liveEvent && (liveEvent.type === "manager:complete" || liveEvent.type === "manager:error")) {
    if (liveEvent.type === "manager:complete") {
      const payload = liveEvent.payload as {
        totalIterations: number;
        outcome: string;
        status: "completed" | "failed";
        totalTokensUsed: number;
        totalDurationMs: number;
      };
      feedEntries.push({
        type: "complete",
        status: payload.status,
        totalIterations: payload.totalIterations,
        outcome: payload.outcome,
        totalTokensUsed: payload.totalTokensUsed,
        totalDurationMs: payload.totalDurationMs,
        timestamp: liveEvent.timestamp,
      });
    } else if (liveEvent.type === "manager:error") {
      const payload = liveEvent.payload as { iteration: number; error: string };
      feedEntries.push({
        type: "error",
        iteration: payload.iteration,
        error: payload.error,
        timestamp: liveEvent.timestamp,
      });
    }
  }

  if (feedEntries.length === 0 && !isRunActive) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
        No manager decisions recorded.
      </div>
    );
  }

  if (feedEntries.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Waiting for manager decisions...
      </div>
    );
  }

  return (
    <div ref={feedRef} className="space-y-3 max-h-[600px] overflow-y-auto pr-1">
      {feedEntries.map((entry, idx) => {
        if (entry.type === "decision") {
          return <DecisionCard key={`decision-${entry.iterationNumber}`} entry={entry} />;
        }
        if (entry.type === "complete") {
          return <CompleteCard key={`complete-${idx}`} entry={entry} />;
        }
        if (entry.type === "error") {
          return <ErrorCard key={`error-${idx}`} entry={entry} />;
        }
        return null;
      })}
      {isRunActive && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground px-2 py-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          Manager is deciding next step...
        </div>
      )}
    </div>
  );
}

function DecisionCard({ entry }: { entry: DecisionEntry }) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <Card className="border-l-4 border-l-blue-400">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-muted-foreground">
              #{entry.iterationNumber}
            </span>
            <Badge className={cn("text-xs", actionColors[entry.action])}>
              {entry.action}
            </Badge>
            {entry.teamId && (
              <span className="flex items-center gap-1 text-xs font-medium">
                <ArrowRight className="h-3 w-3" />
                {entry.teamId.replace("_", " ")}
              </span>
            )}
          </div>
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {entry.tokensUsed} tokens
          </span>
        </div>

        {entry.task && (
          <p className="mt-2 text-xs text-foreground font-medium">
            Task: {entry.task}
          </p>
        )}

        <div className="mt-2">
          <button
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Hide reasoning" : "Show reasoning"}
          </button>
          {expanded && (
            <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
              {entry.reasoning}
            </p>
          )}
        </div>

        {entry.teamResult && (
          <div className="mt-2">
            <details>
              <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                Team output ({Math.ceil(entry.teamResult.length / 1024)}KB)
              </summary>
              <pre className="mt-1 text-xs bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto">
                {entry.teamResult.slice(0, 2000)}
                {entry.teamResult.length > 2000 && "\n...[truncated]"}
              </pre>
            </details>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Need React for DecisionCard
import React from "react";

function CompleteCard({ entry }: { entry: CompleteEntry }) {
  const durationSec = Math.round(entry.totalDurationMs / 1000);
  return (
    <Card
      className={cn(
        "border-l-4",
        entry.status === "completed" ? "border-l-emerald-400" : "border-l-red-400",
      )}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-2">
          {entry.status === "completed" ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          ) : (
            <XCircle className="h-4 w-4 text-red-500" />
          )}
          <span className="text-sm font-semibold">
            {entry.status === "completed" ? "Goal Achieved" : "Run Failed"}
          </span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{entry.outcome}</p>
        <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
          <span>{entry.totalIterations} iterations</span>
          <span>{entry.totalTokensUsed} total tokens</span>
          <span>{durationSec}s</span>
        </div>
      </CardContent>
    </Card>
  );
}

function ErrorCard({ entry }: { entry: ErrorEntry }) {
  return (
    <Card className="border-l-4 border-l-red-400">
      <CardContent className="p-4">
        <div className="flex items-center gap-2">
          <XCircle className="h-4 w-4 text-red-500" />
          <span className="text-sm font-semibold">Manager Error</span>
          <span className="text-xs text-muted-foreground">iteration {entry.iteration}</span>
        </div>
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{entry.error}</p>
      </CardContent>
    </Card>
  );
}
