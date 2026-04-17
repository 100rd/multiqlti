/**
 * Workspace LLM Reasoning-Chain Trace Viewer (issue #278)
 *
 * Routes:
 *   /workspaces/:id/traces        — list view (trace summaries)
 *   /workspaces/:id/traces/:run_id — detail view (span tree + detail panel)
 *
 * Features:
 * - List view: table of trace summaries with tokens, cost, latency
 * - Detail view: span tree waterfall (left) + span detail panel (right)
 * - Per-span: prompt, response, tool calls, tokens, cost, latency
 * - Reasoning-chain tree hierarchy (LLM → Tool → Strategy spans)
 */

import { useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Loader2,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Activity,
  DollarSign,
  Hash,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { WorkspaceTraceSummary, WorkspaceTraceDetail, TraceSpan } from "@shared/types";

// ─── Auth / API helper ────────────────────────────────────────────────────────

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function apiGet<T>(url: string): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// ─── Span colour helpers ──────────────────────────────────────────────────────

type SpanKind = "llm" | "tool" | "strategy" | "stage" | "other";

function getSpanKind(span: TraceSpan): SpanKind {
  const k = span.attributes["openinference.span.kind"] as string | undefined;
  if (k === "LLM") return "llm";
  if (k === "TOOL" || span.name.startsWith("tool.")) return "tool";
  if (span.name.startsWith("strategy.")) return "strategy";
  const STAGE_NAMES = new Set(["planning","architecture","development","testing","code_review","deployment","monitoring","fact_check"]);
  if (STAGE_NAMES.has(span.name)) return "stage";
  return "other";
}

const KIND_COLOUR: Record<SpanKind, string> = {
  llm:      "bg-violet-500",
  tool:     "bg-emerald-500",
  strategy: "bg-amber-500",
  stage:    "bg-blue-500",
  other:    "bg-slate-400",
};

const KIND_BADGE: Record<SpanKind, string> = {
  llm:      "bg-violet-100 text-violet-700 border-violet-300",
  tool:     "bg-emerald-100 text-emerald-700 border-emerald-300",
  strategy: "bg-amber-100 text-amber-700 border-amber-300",
  stage:    "bg-blue-100 text-blue-700 border-blue-300",
  other:    "bg-slate-100 text-slate-600 border-slate-300",
};

// ─── Tree helpers ─────────────────────────────────────────────────────────────

interface SpanNode {
  span: TraceSpan;
  depth: number;
  children: SpanNode[];
}

function buildSpanTree(spans: TraceSpan[]): SpanNode[] {
  const byId = new Map<string, SpanNode>();
  for (const span of spans) {
    byId.set(span.spanId, { span, depth: 0, children: [] });
  }

  const roots: SpanNode[] = [];
  for (const node of byId.values()) {
    const pid = node.span.parentSpanId;
    if (pid && byId.has(pid)) {
      byId.get(pid)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const assignDepth = (node: SpanNode, d: number) => {
    node.depth = d;
    for (const child of node.children) {
      assignDepth(child, d + 1);
    }
  };
  for (const r of roots) assignDepth(r, 0);

  return roots;
}

function flattenTree(roots: SpanNode[]): SpanNode[] {
  const out: SpanNode[] = [];
  const visit = (node: SpanNode) => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const r of roots) visit(r);
  return out;
}

// ─── Span Detail Panel ────────────────────────────────────────────────────────

interface SpanDetailPanelProps {
  span: TraceSpan;
  onClose: () => void;
}

function SpanDetailPanel({ span, onClose }: SpanDetailPanelProps) {
  const duration = span.endTime > 0 ? span.endTime - span.startTime : 0;
  const kind = getSpanKind(span);

  const attrs = span.attributes;
  const prompt    = attrs["input.value"]  as string | undefined;
  const response  = attrs["output.value"] as string | undefined;
  const sysPrompt = attrs["llm.prompts.0.system"] as string | undefined;
  const toolArgs  = attrs["tool.call.arguments"] as string | undefined;
  const toolResult= attrs["tool.call.result"] as string | undefined;
  const model     = attrs["llm.model"]   as string | undefined;
  const provider  = attrs["llm.provider"] as string | undefined;
  const promptTok = attrs["llm.token_count.prompt"] as number | undefined;
  const compTok   = attrs["llm.token_count.completion"] as number | undefined;
  const totalTok  = attrs["llm.token_count.total"] as number | undefined;
  const costUsd   = attrs["llm.cost_usd"] as number | undefined;
  const temp      = attrs["llm.invocation_parameters.temperature"] as number | undefined;
  const maxTok    = attrs["llm.invocation_parameters.max_tokens"] as number | undefined;

  return (
    <div className="text-xs h-full flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 p-4 border-b border-border shrink-0">
        <div className="min-w-0">
          <p className="font-semibold font-mono text-sm truncate">{span.name}</p>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant={span.status === "ok" ? "default" : "destructive"} className="text-[10px]">
              {span.status}
            </Badge>
            <span className={cn("px-1.5 py-0.5 rounded text-[10px] border font-medium", KIND_BADGE[kind])}>
              {kind.toUpperCase()}
            </span>
            <span className="text-muted-foreground">{duration}ms</span>
          </div>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onClose}>
          ×
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Model info */}
        {(model || provider) && (
          <section>
            <p className="text-muted-foreground font-medium mb-1">Model</p>
            <div className="font-mono bg-muted/50 rounded px-2 py-1">
              {provider && <span className="text-muted-foreground">{provider} / </span>}
              {model && <span>{model}</span>}
            </div>
          </section>
        )}

        {/* Token usage */}
        {totalTok !== undefined && (
          <section>
            <p className="text-muted-foreground font-medium mb-1">Token Usage</p>
            <div className="grid grid-cols-3 gap-1 text-center">
              <div className="bg-muted/50 rounded p-1">
                <p className="text-muted-foreground text-[10px]">Prompt</p>
                <p className="font-mono font-medium">{promptTok ?? 0}</p>
              </div>
              <div className="bg-muted/50 rounded p-1">
                <p className="text-muted-foreground text-[10px]">Completion</p>
                <p className="font-mono font-medium">{compTok ?? 0}</p>
              </div>
              <div className="bg-muted/50 rounded p-1">
                <p className="text-muted-foreground text-[10px]">Total</p>
                <p className="font-mono font-medium">{totalTok}</p>
              </div>
            </div>
          </section>
        )}

        {/* Cost */}
        {costUsd !== undefined && costUsd > 0 && (
          <section>
            <p className="text-muted-foreground font-medium mb-1">Cost</p>
            <p className="font-mono">${costUsd.toFixed(6)}</p>
          </section>
        )}

        {/* Parameters */}
        {(temp !== undefined || maxTok !== undefined) && (
          <section>
            <p className="text-muted-foreground font-medium mb-1">Parameters</p>
            <div className="space-y-0.5">
              {temp !== undefined && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">temperature</span>
                  <span className="font-mono">{temp}</span>
                </div>
              )}
              {maxTok !== undefined && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">max_tokens</span>
                  <span className="font-mono">{maxTok}</span>
                </div>
              )}
            </div>
          </section>
        )}

        {/* System Prompt */}
        {sysPrompt && (
          <section>
            <p className="text-muted-foreground font-medium mb-1">System Prompt</p>
            <pre className="bg-muted/50 rounded p-2 whitespace-pre-wrap break-all text-[11px] max-h-32 overflow-auto">
              {sysPrompt}
            </pre>
          </section>
        )}

        {/* Prompt */}
        {prompt && (
          <section>
            <p className="text-muted-foreground font-medium mb-1">Prompt</p>
            <pre className="bg-muted/50 rounded p-2 whitespace-pre-wrap break-all text-[11px] max-h-40 overflow-auto">
              {prompt}
            </pre>
          </section>
        )}

        {/* Response */}
        {response && (
          <section>
            <p className="text-muted-foreground font-medium mb-1">Response</p>
            <pre className="bg-muted/50 rounded p-2 whitespace-pre-wrap break-all text-[11px] max-h-40 overflow-auto">
              {response}
            </pre>
          </section>
        )}

        {/* Tool args */}
        {toolArgs && (
          <section>
            <p className="text-muted-foreground font-medium mb-1">Tool Arguments</p>
            <pre className="bg-muted/50 rounded p-2 whitespace-pre-wrap break-all text-[11px] max-h-32 overflow-auto">
              {toolArgs}
            </pre>
          </section>
        )}

        {/* Tool result */}
        {toolResult && (
          <section>
            <p className="text-muted-foreground font-medium mb-1">Tool Result</p>
            <pre className="bg-muted/50 rounded p-2 whitespace-pre-wrap break-all text-[11px] max-h-32 overflow-auto">
              {toolResult}
            </pre>
          </section>
        )}

        {/* All attributes */}
        {Object.keys(attrs).length > 0 && (
          <section>
            <p className="text-muted-foreground font-medium mb-1">All Attributes</p>
            <table className="w-full">
              <tbody>
                {Object.entries(attrs).map(([k, v]) => (
                  <tr key={k} className="border-b border-border last:border-0">
                    <td className="py-0.5 pr-2 text-muted-foreground font-mono align-top max-w-[120px] truncate">{k}</td>
                    <td className="py-0.5 font-mono break-all">{String(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* Events */}
        {span.events.length > 0 && (
          <section>
            <p className="text-muted-foreground font-medium mb-1">Events</p>
            <div className="space-y-1">
              {span.events.map((e, i) => (
                <div key={i} className="flex gap-2 border-b border-border last:border-0 py-0.5">
                  <span className="text-muted-foreground shrink-0">
                    +{e.timestamp - span.startTime}ms
                  </span>
                  <span className="font-mono">{e.name}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ─── Span Tree Row ────────────────────────────────────────────────────────────

interface SpanRowProps {
  node: SpanNode;
  traceStart: number;
  totalDuration: number;
  isSelected: boolean;
  isExpanded: boolean;
  hasChildren: boolean;
  onSelect: () => void;
  onToggle: () => void;
}

function SpanRow({
  node,
  traceStart,
  totalDuration,
  isSelected,
  isExpanded,
  hasChildren,
  onSelect,
  onToggle,
}: SpanRowProps) {
  const { span, depth } = node;
  const kind = getSpanKind(span);
  const colour = KIND_COLOUR[kind];
  const duration = span.endTime > 0 ? span.endTime - span.startTime : 0;
  const spanStart = span.startTime - traceStart;
  const spanEnd   = (span.endTime || span.startTime) - traceStart;
  const leftPct   = totalDuration > 0 ? (spanStart / totalDuration) * 100 : 0;
  const widthPct  = totalDuration > 0
    ? Math.max(((spanEnd - spanStart) / totalDuration) * 100, 0.3)
    : 0.3;

  return (
    <div
      className={cn(
        "flex items-center h-8 cursor-pointer rounded hover:bg-muted/50 font-mono text-xs",
        isSelected && "bg-muted",
      )}
      style={{ paddingLeft: `${depth * 14 + 4}px` }}
    >
      {/* Expand/collapse chevron */}
      <div
        className="w-5 shrink-0 flex items-center justify-center"
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
      >
        {hasChildren ? (
          isExpanded
            ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
            : <ChevronRight className="h-3 w-3 text-muted-foreground" />
        ) : null}
      </div>

      {/* Span name */}
      <div
        className="w-44 shrink-0 pr-2 truncate text-foreground"
        title={span.name}
        onClick={onSelect}
      >
        {span.name}
      </div>

      {/* Waterfall bar */}
      <div className="flex-1 relative h-4" onClick={onSelect}>
        <div
          className={cn("absolute h-full rounded-sm transition-all", colour, isSelected && "ring-1 ring-primary")}
          style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: "2px" }}
        />
      </div>

      {/* Duration */}
      <div className="w-20 shrink-0 text-right text-muted-foreground pl-2" onClick={onSelect}>
        {duration}ms
      </div>
    </div>
  );
}

// ─── Trace Detail View ────────────────────────────────────────────────────────

interface TraceDetailViewProps {
  workspaceId: string;
  runId: string;
}

function TraceDetailView({ workspaceId, runId }: TraceDetailViewProps) {
  const [selectedSpan, setSelectedSpan] = useState<TraceSpan | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: detail, isLoading, error } = useQuery<WorkspaceTraceDetail>({
    queryKey: ["/api/workspaces", workspaceId, "traces", runId],
    queryFn: () => apiGet<WorkspaceTraceDetail>(`/api/workspaces/${workspaceId}/traces/${runId}`),
    enabled: !!workspaceId && !!runId,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading trace…</span>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="p-6 text-sm text-destructive">
        {error ? `Error: ${(error as Error).message}` : `No trace found for run ${runId}`}
      </div>
    );
  }

  const sorted = [...detail.spans].sort((a, b) => a.startTime - b.startTime);
  const roots  = buildSpanTree(sorted);

  const traceStart    = sorted[0]?.startTime ?? 0;
  const traceEnd      = Math.max(...sorted.map((s) => s.endTime || s.startTime), traceStart);
  const totalDuration = Math.max(traceEnd - traceStart, 1);

  // Flatten with collapse-awareness
  const flatNodes: SpanNode[] = [];
  const visitNode = (node: SpanNode) => {
    flatNodes.push(node);
    if (expanded.has(node.span.spanId) || node.depth === 0) {
      for (const child of node.children) visitNode(child);
    }
  };

  // Auto-expand all top-level nodes
  const hasAnExpanded = expanded.size > 0;
  if (!hasAnExpanded) {
    for (const root of roots) {
      expanded.add(root.span.spanId);
    }
  }

  for (const root of roots) visitNode(root);

  const toggleExpand = (spanId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(spanId)) next.delete(spanId);
      else next.add(spanId);
      return next;
    });
  };

  const timeMarkers = [0, 0.25, 0.5, 0.75, 1].map((pct) => ({
    pct,
    label: pct === 0 ? "0ms" : pct === 1 ? `${totalDuration}ms` : `${Math.round(totalDuration * pct)}ms`,
  }));

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-14 border-b border-border flex items-center px-6 gap-3 bg-card shrink-0">
        <Link href={`/workspaces/${workspaceId}/traces`}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h2 className="text-sm font-semibold truncate">Trace — {runId}</h2>
        <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><Hash className="h-3 w-3" />{detail.spanCount} spans</span>
          <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{totalDuration}ms</span>
          {detail.totalTokens > 0 && (
            <span className="flex items-center gap-1"><Activity className="h-3 w-3" />{detail.totalTokens} tok</span>
          )}
          {detail.costUsd > 0 && (
            <span className="flex items-center gap-1"><DollarSign className="h-3 w-3" />${detail.costUsd.toFixed(5)}</span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Span tree */}
        <main className="flex-1 overflow-auto p-4 font-mono text-xs select-none">
          {/* Timeline header */}
          <div className="flex items-center mb-1">
            <div className="w-5 shrink-0" />
            <div className="w-44 shrink-0" />
            <div className="flex-1 relative h-5">
              {timeMarkers.map(({ pct, label }) => (
                <span
                  key={pct}
                  className="absolute text-muted-foreground text-[10px] -translate-x-1/2"
                  style={{ left: `${pct * 100}%` }}
                >
                  {label}
                </span>
              ))}
            </div>
            <div className="w-20 shrink-0" />
          </div>

          {/* Divider */}
          <div className="flex items-center mb-2">
            <div className="w-5 shrink-0" />
            <div className="w-44 shrink-0" />
            <div className="flex-1 h-px bg-border" />
            <div className="w-20 shrink-0" />
          </div>

          {/* Rows */}
          {flatNodes.map((node) => (
            <SpanRow
              key={node.span.spanId}
              node={node}
              traceStart={traceStart}
              totalDuration={totalDuration}
              isSelected={selectedSpan?.spanId === node.span.spanId}
              isExpanded={expanded.has(node.span.spanId)}
              hasChildren={node.children.length > 0}
              onSelect={() => setSelectedSpan(node.span)}
              onToggle={() => toggleExpand(node.span.spanId)}
            />
          ))}

          {flatNodes.length === 0 && (
            <div className="text-center text-muted-foreground py-8">No spans recorded.</div>
          )}
        </main>

        {/* Detail panel */}
        {selectedSpan && (
          <aside className="w-80 border-l border-border overflow-hidden flex flex-col">
            <SpanDetailPanel span={selectedSpan} onClose={() => setSelectedSpan(null)} />
          </aside>
        )}
      </div>
    </div>
  );
}

// ─── Trace List View ──────────────────────────────────────────────────────────

interface TraceListViewProps {
  workspaceId: string;
}

function TraceListView({ workspaceId }: TraceListViewProps) {
  const { data, isLoading, error, refetch } = useQuery<{
    traces: WorkspaceTraceSummary[];
    total: number;
  }>({
    queryKey: ["/api/workspaces", workspaceId, "traces"],
    queryFn: () => apiGet(`/api/workspaces/${workspaceId}/traces?limit=50&offset=0`),
    enabled: !!workspaceId,
  });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-14 border-b border-border flex items-center px-6 gap-3 bg-card shrink-0">
        <Link href={`/workspaces/${workspaceId}`}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h2 className="text-sm font-semibold">LLM Traces</h2>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-8 w-8"
          onClick={() => refetch()}
          disabled={isLoading}
        >
          <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
        </Button>
      </div>

      <main className="flex-1 overflow-auto p-6">
        {isLoading && (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">Loading traces…</span>
          </div>
        )}

        {error && (
          <div className="text-sm text-destructive p-4">
            Error: {(error as Error).message}
          </div>
        )}

        {data && data.traces.length === 0 && (
          <div className="text-center text-muted-foreground py-16 text-sm">
            No traces recorded yet. Traces appear here once pipeline runs complete.
          </div>
        )}

        {data && data.traces.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground mb-3">{data.total} traces total</p>
            <div className="border border-border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Run ID</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Model</th>
                    <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground">Spans</th>
                    <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground">Tokens</th>
                    <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground">Cost</th>
                    <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {data.traces.map((t) => {
                    const duration = t.endTime - t.startTime;
                    return (
                      <tr
                        key={t.traceId}
                        className="border-b border-border last:border-0 hover:bg-muted/40 cursor-pointer"
                      >
                        <td className="px-4 py-2">
                          <Link href={`/workspaces/${workspaceId}/traces/${t.runId}`}>
                            <span className="font-mono text-xs text-primary hover:underline truncate block max-w-[180px]">
                              {t.runId}
                            </span>
                          </Link>
                        </td>
                        <td className="px-4 py-2">
                          <div className="text-xs text-muted-foreground truncate max-w-[140px]">
                            {t.provider && <span className="mr-1">{t.provider} /</span>}
                            {t.model}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-xs">{t.spanCount}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs">
                          {t.totalTokens > 0 ? t.totalTokens.toLocaleString() : "—"}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-xs">
                          {t.costUsd > 0 ? `$${t.costUsd.toFixed(5)}` : "—"}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-xs">{duration}ms</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ─── Page Entry Points ────────────────────────────────────────────────────────

/** List page: /workspaces/:id/traces */
export function WorkspaceTracesPage() {
  const [, params] = useRoute("/workspaces/:id/traces");
  const workspaceId = params?.id ?? "";

  return <TraceListView workspaceId={workspaceId} />;
}

/** Detail page: /workspaces/:id/traces/:run_id */
export function WorkspaceTraceDetailPage() {
  const [, params] = useRoute("/workspaces/:id/traces/:run_id");
  const workspaceId = params?.id ?? "";
  const runId       = params?.run_id ?? "";

  return <TraceDetailView workspaceId={workspaceId} runId={runId} />;
}
