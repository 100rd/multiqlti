/**
 * ConnectionUsageTab — Usage metrics panel for a workspace connection.
 *
 * Displays:
 *  - Calls/day sparkline (last 30 days)
 *  - Top tools by invocation count
 *  - Error rate (last 7 days) — shown as percentage
 *  - P95 latency (last 30 days) — shown in ms
 *  - Orphan badge when no calls in last 30 days
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  Clock,
  AlertCircle,
  Wrench,
  TrendingDown,
  Loader2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ConnectionUsageMetrics } from "@shared/types";

// ─── API fetch ────────────────────────────────────────────────────────────────

async function fetchUsageMetrics(
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionUsageMetrics> {
  const res = await fetch(
    `/api/workspaces/${workspaceId}/connections/${connectionId}/usage`,
    { credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json() as Promise<ConnectionUsageMetrics>;
}

// ─── Mini bar chart ───────────────────────────────────────────────────────────

function MiniBarChart({ data }: { data: Array<{ date: string; count: number }> }) {
  const maxCount = useMemo(() => Math.max(1, ...data.map((d) => d.count)), [data]);

  if (data.length === 0) {
    return (
      <div className="flex items-end gap-0.5 h-10 text-muted-foreground text-xs">
        No data
      </div>
    );
  }

  return (
    <div className="flex items-end gap-px h-10" aria-label="Calls per day chart">
      {data.map((d) => (
        <div
          key={d.date}
          title={`${d.date}: ${d.count} call${d.count === 1 ? "" : "s"}`}
          className="flex-1 bg-primary/70 rounded-sm min-w-[2px] transition-all hover:bg-primary"
          style={{ height: `${Math.max(4, Math.round((d.count / maxCount) * 40))}px` }}
        />
      ))}
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface ConnectionUsageTabProps {
  workspaceId: string;
  connectionId: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ConnectionUsageTab({
  workspaceId,
  connectionId,
}: ConnectionUsageTabProps) {
  const { data, isLoading, isError, error } = useQuery<ConnectionUsageMetrics, Error>({
    queryKey: ["connection-usage", workspaceId, connectionId],
    queryFn: () => fetchUsageMetrics(workspaceId, connectionId),
    staleTime: 60_000, // 1 minute
    retry: 1,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>Loading usage metrics…</span>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex items-center gap-2 py-8 text-destructive text-sm">
        <AlertCircle className="w-4 h-4" />
        <span>Failed to load usage metrics: {error?.message ?? "Unknown error"}</span>
      </div>
    );
  }

  const totalCalls = data.callsPerDay.reduce((s, d) => s + d.count, 0);
  const errorPercent = (data.errorRate7d * 100).toFixed(1);

  return (
    <div className="space-y-4">
      {/* Orphan notice */}
      {data.isOrphan && (
        <div className="flex items-center gap-2 p-3 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400 text-sm">
          <TrendingDown className="w-4 h-4 flex-shrink-0" />
          <span>
            This connection has had no tool calls in the last 30 days. Consider removing it
            if it is no longer needed.
          </span>
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-1 pt-3 px-3">
            <CardTitle className="text-xs text-muted-foreground font-medium flex items-center gap-1">
              <BarChart3 className="w-3.5 h-3.5" />
              Total calls (30d)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3">
            <p className="text-2xl font-semibold tabular-nums">{totalCalls.toLocaleString()}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1 pt-3 px-3">
            <CardTitle className="text-xs text-muted-foreground font-medium flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" />
              Error rate (7d)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3">
            <p
              className={`text-2xl font-semibold tabular-nums ${
                data.errorRate7d > 0.1 ? "text-destructive" : ""
              }`}
            >
              {errorPercent}%
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1 pt-3 px-3">
            <CardTitle className="text-xs text-muted-foreground font-medium flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" />
              P95 latency (30d)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3">
            <p className="text-2xl font-semibold tabular-nums">{data.p95LatencyMs}ms</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1 pt-3 px-3">
            <CardTitle className="text-xs text-muted-foreground font-medium flex items-center gap-1">
              <Wrench className="w-3.5 h-3.5" />
              Unique tools
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3">
            <p className="text-2xl font-semibold tabular-nums">{data.topTools.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Calls/day chart */}
      <Card>
        <CardHeader className="pb-2 pt-3 px-4">
          <CardTitle className="text-sm font-medium">Calls per day (last 30 days)</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <MiniBarChart data={data.callsPerDay} />
        </CardContent>
      </Card>

      {/* Top tools */}
      {data.topTools.length > 0 && (
        <Card>
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-sm font-medium">Top tools (last 30 days)</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-2">
            {data.topTools.map((t) => {
              const maxCount = data.topTools[0]?.count ?? 1;
              const pct = Math.round((t.count / maxCount) * 100);
              return (
                <div key={t.toolName} className="space-y-0.5">
                  <div className="flex justify-between text-xs">
                    <span className="font-mono truncate max-w-[70%]">{t.toolName}</span>
                    <span className="text-muted-foreground tabular-nums">{t.count.toLocaleString()}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary/70 rounded-full transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
