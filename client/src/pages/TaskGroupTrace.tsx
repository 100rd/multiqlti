import { useRoute, Link } from "wouter";
import { useTaskTrace, type TaskTraceSpan } from "@/hooks/use-task-trace";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Clock, Loader2, CheckCircle2, AlertCircle, Cpu, Zap, DollarSign } from "lucide-react";
import { useMemo, useState } from "react";

// ─── Span type → color ─────────────────────────────────────────────────────

const SPAN_COLORS: Record<string, string> = {
  task_group: "bg-blue-500",
  task: "bg-green-500",
  pipeline_run: "bg-purple-500",
  stage: "bg-orange-500",
  llm_call: "bg-red-500",
};

const SPAN_BG_COLORS: Record<string, string> = {
  task_group: "bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800",
  task: "bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800",
  pipeline_run: "bg-purple-50 dark:bg-purple-950 border-purple-200 dark:border-purple-800",
  stage: "bg-orange-50 dark:bg-orange-950 border-orange-200 dark:border-orange-800",
  llm_call: "bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800",
};

const SPAN_LABELS: Record<string, string> = {
  task_group: "Group",
  task: "Task",
  pipeline_run: "Pipeline",
  stage: "Stage",
  llm_call: "LLM",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms === 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatTokens(n: number | undefined): string {
  if (!n) return "-";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

function formatCost(usd: number | undefined): string {
  if (!usd) return "-";
  return `$${usd.toFixed(4)}`;
}

function statusIcon(status: string) {
  switch (status) {
    case "running":
      return <Loader2 className="h-3 w-3 animate-spin text-blue-500" />;
    case "completed":
      return <CheckCircle2 className="h-3 w-3 text-green-500" />;
    case "failed":
      return <AlertCircle className="h-3 w-3 text-red-500" />;
    default:
      return <Clock className="h-3 w-3 text-muted-foreground" />;
  }
}

// ─── Build tree structure ───────────────────────────────────────────────────

interface SpanNode {
  span: TaskTraceSpan;
  children: SpanNode[];
  depth: number;
}

function buildTree(spans: TaskTraceSpan[]): SpanNode[] {
  const byId = new Map<string, SpanNode>();
  const roots: SpanNode[] = [];

  for (const span of spans) {
    byId.set(span.spanId, { span, children: [], depth: 0 });
  }

  for (const span of spans) {
    const node = byId.get(span.spanId)!;
    if (span.parentSpanId && byId.has(span.parentSpanId)) {
      const parent = byId.get(span.parentSpanId)!;
      node.depth = parent.depth + 1;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function flattenTree(nodes: SpanNode[]): SpanNode[] {
  const result: SpanNode[] = [];
  const visit = (node: SpanNode) => {
    result.push(node);
    for (const child of node.children) visit(child);
  };
  for (const root of nodes) visit(root);
  return result;
}

// ─── WaterfallBar ───────────────────────────────────────────────────────────

function WaterfallBar({
  span,
  globalStart,
  globalEnd,
}: {
  span: TaskTraceSpan;
  globalStart: number;
  globalEnd: number;
}) {
  const totalRange = globalEnd - globalStart || 1;
  const left = ((span.startTime - globalStart) / totalRange) * 100;
  const end = span.endTime ?? Date.now();
  const width = Math.max(0.5, ((end - span.startTime) / totalRange) * 100);

  return (
    <div className="relative h-5 w-full">
      <div className="absolute inset-0 bg-muted/30 rounded" />
      <div
        className={`absolute h-full rounded ${SPAN_COLORS[span.type] ?? "bg-gray-500"} ${
          span.status === "running" ? "opacity-70 animate-pulse" : "opacity-90"
        }`}
        style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
      />
    </div>
  );
}

// ─── SpanDetail ─────────────────────────────────────────────────────────────

function SpanDetail({ span }: { span: TaskTraceSpan }) {
  const m = span.metadata;
  return (
    <div className="p-3 space-y-2 text-xs border-t">
      <div className="grid grid-cols-2 gap-2">
        {m.modelSlug && (
          <div>
            <span className="text-muted-foreground">Model:</span>{" "}
            <span className="font-medium">{m.modelSlug}</span>
          </div>
        )}
        {m.provider && (
          <div>
            <span className="text-muted-foreground">Provider:</span>{" "}
            <span className="font-medium">{m.provider}</span>
          </div>
        )}
        {m.tokensUsed != null && (
          <div>
            <span className="text-muted-foreground">Tokens:</span>{" "}
            <span className="font-medium">{formatTokens(m.tokensUsed)}</span>
          </div>
        )}
        {m.estimatedCostUsd != null && (
          <div>
            <span className="text-muted-foreground">Cost:</span>{" "}
            <span className="font-medium">{formatCost(m.estimatedCostUsd)}</span>
          </div>
        )}
        {m.inputSizeBytes != null && (
          <div>
            <span className="text-muted-foreground">Input:</span>{" "}
            <span className="font-medium">{(m.inputSizeBytes / 1024).toFixed(1)} KB</span>
          </div>
        )}
        {m.outputSizeBytes != null && (
          <div>
            <span className="text-muted-foreground">Output:</span>{" "}
            <span className="font-medium">{(m.outputSizeBytes / 1024).toFixed(1)} KB</span>
          </div>
        )}
        {m.taskId && (
          <div>
            <span className="text-muted-foreground">Task ID:</span>{" "}
            <span className="font-mono">{m.taskId.slice(0, 8)}</span>
          </div>
        )}
        {m.pipelineRunId && (
          <div>
            <span className="text-muted-foreground">Run ID:</span>{" "}
            <span className="font-mono">{m.pipelineRunId.slice(0, 8)}</span>
          </div>
        )}
      </div>
      {m.error && (
        <div className="p-2 bg-red-50 dark:bg-red-950 rounded text-red-800 dark:text-red-200">
          {m.error}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function TaskGroupTrace() {
  const [, params] = useRoute("/task-groups/:id/trace");
  const groupId = params?.id ?? "";
  const { data: trace, isLoading, error } = useTaskTrace(groupId);
  const [expandedSpanId, setExpandedSpanId] = useState<string | null>(null);

  const flatSpans = useMemo(() => {
    if (!trace?.spans) return [];
    const tree = buildTree(trace.spans);
    return flattenTree(tree);
  }, [trace?.spans]);

  const globalStart = useMemo(
    () => Math.min(...(flatSpans.map((n) => n.span.startTime).filter(Boolean) as number[]), Date.now()),
    [flatSpans],
  );
  const globalEnd = useMemo(
    () => Math.max(...(flatSpans.map((n) => n.span.endTime ?? Date.now()).filter(Boolean) as number[]), Date.now()),
    [flatSpans],
  );

  if (isLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading trace...
      </div>
    );
  }

  if (error || !trace) {
    return (
      <div className="p-6 space-y-4">
        <Link href={`/task-groups/${groupId}`}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-2" /> Back to Task Group
          </Button>
        </Link>
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <p>No trace data available for this task group.</p>
            <p className="text-xs mt-1">Start the task group to begin recording trace spans.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href={`/task-groups/${groupId}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Request Trace</h1>
          <p className="text-sm text-muted-foreground">
            End-to-end observability for task group execution
          </p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" /> Total Duration
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatDuration(trace.totalDurationMs)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-1">
              <Zap className="h-3.5 w-3.5" /> Total Tokens
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatTokens(trace.totalTokens)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-1">
              <DollarSign className="h-3.5 w-3.5" /> Est. Cost
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCost(trace.totalCostUsd)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-xs">
        {Object.entries(SPAN_LABELS).map(([type, label]) => (
          <div key={type} className="flex items-center gap-1.5">
            <div className={`w-3 h-3 rounded ${SPAN_COLORS[type]}`} />
            <span className="text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>

      {/* Waterfall view */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Waterfall Timeline</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {flatSpans.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              No spans recorded yet.
            </div>
          ) : (
            <div className="divide-y">
              {flatSpans.map((node) => {
                const { span } = node;
                const isExpanded = expandedSpanId === span.spanId;

                return (
                  <div key={span.spanId}>
                    <div
                      className={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors ${
                        isExpanded ? SPAN_BG_COLORS[span.type] ?? "" : ""
                      }`}
                      style={{ paddingLeft: `${12 + node.depth * 24}px` }}
                      onClick={() => setExpandedSpanId(isExpanded ? null : span.spanId)}
                    >
                      {/* Status icon */}
                      <div className="shrink-0">{statusIcon(span.status)}</div>

                      {/* Type badge */}
                      <Badge
                        variant="outline"
                        className={`text-[10px] px-1.5 py-0 shrink-0 ${SPAN_COLORS[span.type]} text-white border-0`}
                      >
                        {SPAN_LABELS[span.type] ?? span.type}
                      </Badge>

                      {/* Name */}
                      <span className="text-sm font-medium truncate min-w-0 max-w-[200px]">
                        {span.name}
                      </span>

                      {/* Duration */}
                      <span className="text-xs text-muted-foreground shrink-0 ml-auto mr-2">
                        {formatDuration(span.durationMs)}
                      </span>

                      {/* Tokens */}
                      {span.metadata.tokensUsed ? (
                        <span className="text-xs text-muted-foreground shrink-0 flex items-center gap-0.5">
                          <Cpu className="h-3 w-3" />
                          {formatTokens(span.metadata.tokensUsed)}
                        </span>
                      ) : null}

                      {/* Waterfall bar */}
                      <div className="w-[300px] shrink-0 hidden lg:block">
                        <WaterfallBar span={span} globalStart={globalStart} globalEnd={globalEnd} />
                      </div>
                    </div>

                    {/* Expanded detail */}
                    {isExpanded && <SpanDetail span={span} />}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
