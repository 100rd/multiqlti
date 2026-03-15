import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Download, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── API types ───────────────────────────────────────────────────────────────

interface StatsOverview {
  totalRequests: number;
  totalTokens: { input: number; output: number; total: number };
  totalCostUsd: number;
  totalRuns: number;
}

interface ModelStat {
  modelSlug: string;
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  avgLatencyMs: number;
  errorRate: number;
}

interface TimelinePoint {
  date: string;
  requests: number;
  tokens: number;
  costUsd: number;
}

interface LlmRequestRow {
  id: number;
  createdAt: string | null;
  modelSlug: string;
  provider: string;
  teamId: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  latencyMs: number;
  status: string;
  runId: string | null;
}

interface RequestsResponse {
  rows: LlmRequestRow[];
  total: number;
  page: number;
  limit: number;
}

// ─── Fetchers ────────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Small utilities ─────────────────────────────────────────────────────────

function fmt(n: number, decimals = 0) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(decimals);
}

function fmtCost(n: number) {
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

// ─── Summary Cards ───────────────────────────────────────────────────────────

function SummaryCards({ overview }: { overview: StatsOverview }) {
  const cards = [
    { label: "Total Requests", value: fmt(overview.totalRequests) },
    { label: "Total Tokens", value: fmt(overview.totalTokens.total) },
    { label: "Pipeline Runs", value: fmt(overview.totalRuns) },
    { label: "Estimated Cost", value: fmtCost(overview.totalCostUsd) },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-lg border border-border bg-card p-4"
        >
          <p className="text-xs text-muted-foreground">{c.label}</p>
          <p className="text-2xl font-semibold mt-1">{c.value}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Timeline Chart ───────────────────────────────────────────────────────────

type Granularity = "day" | "week";
type ChartMetric = "requests" | "tokens" | "costUsd";

function TimelineChart() {
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [metric, setMetric] = useState<ChartMetric>("requests");

  const { data, isLoading } = useQuery<TimelinePoint[]>({
    queryKey: ["stats-timeline", granularity],
    queryFn: () => fetchJson(`/api/stats/timeline?granularity=${granularity}`),
  });

  const metricLabels: Record<ChartMetric, string> = {
    requests: "Requests",
    tokens: "Tokens",
    costUsd: "Cost ($)",
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm font-medium">Timeline</p>
        <div className="flex gap-2 flex-wrap">
          <div className="flex gap-1">
            {(["day", "week"] as Granularity[]).map((g) => (
              <button
                key={g}
                onClick={() => setGranularity(g)}
                className={cn(
                  "text-xs px-2 py-1 rounded border transition-colors",
                  granularity === g
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:border-primary/50",
                )}
              >
                {g.charAt(0).toUpperCase() + g.slice(1)}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {(Object.keys(metricLabels) as ChartMetric[]).map((m) => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className={cn(
                  "text-xs px-2 py-1 rounded border transition-colors",
                  metric === m
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:border-primary/50",
                )}
              >
                {metricLabels[m]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="h-48 flex items-center justify-center text-xs text-muted-foreground">
          Loading...
        </div>
      ) : !data || data.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-xs text-muted-foreground">
          No data yet — run a pipeline to generate statistics.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10 }}
              tickFormatter={(v: string) => v.slice(5)}
            />
            <YAxis tick={{ fontSize: 10 }} width={50} tickFormatter={(v) => fmt(v as number)} />
            <Tooltip
              contentStyle={{ fontSize: 11 }}
              formatter={(v: number) =>
                metric === "costUsd" ? fmtCost(v) : fmt(v)
              }
            />
            <Area
              type="monotone"
              dataKey={metric}
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              fill="url(#areaGrad)"
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ─── Model Breakdown Table ────────────────────────────────────────────────────

type ModelSortKey = keyof ModelStat;

function ModelTable() {
  const { data, isLoading } = useQuery<ModelStat[]>({
    queryKey: ["stats-by-model"],
    queryFn: () => fetchJson("/api/stats/by-model"),
  });

  const [sortKey, setSortKey] = useState<ModelSortKey>("requests");
  const [sortAsc, setSortAsc] = useState(false);

  const toggleSort = (key: ModelSortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  };

  const sorted = [...(data ?? [])].sort((a, b) => {
    const av = a[sortKey] as number;
    const bv = b[sortKey] as number;
    return sortAsc ? av - bv : bv - av;
  });

  const cols: { label: string; key: ModelSortKey; fmt?: (v: number) => string }[] = [
    { label: "Model", key: "modelSlug" },
    { label: "Provider", key: "provider" },
    { label: "Requests", key: "requests", fmt: (v) => fmt(v) },
    { label: "Tokens", key: "inputTokens", fmt: (v) => fmt(v) },
    { label: "Cost", key: "costUsd", fmt: (v) => fmtCost(v) },
    { label: "Avg Latency", key: "avgLatencyMs", fmt: (v) => `${Math.round(v)}ms` },
    { label: "Error Rate", key: "errorRate", fmt: (v) => `${(v * 100).toFixed(1)}%` },
  ];

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-sm font-medium mb-3">Per-Model Breakdown</p>
        <p className="text-xs text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <p className="text-sm font-medium">Per-Model Breakdown</p>
      {sorted.length === 0 ? (
        <p className="text-xs text-muted-foreground">No data yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border">
                {cols.map((c) => (
                  <th
                    key={c.key}
                    className="text-left pb-2 pr-4 text-muted-foreground font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                    onClick={() => toggleSort(c.key)}
                  >
                    {c.label} {sortKey === c.key ? (sortAsc ? "▲" : "▼") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={row.modelSlug} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="py-2 pr-4 font-mono">{row.modelSlug}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{row.provider}</td>
                  <td className="py-2 pr-4">{fmt(row.requests)}</td>
                  <td className="py-2 pr-4">{fmt(row.inputTokens + row.outputTokens)}</td>
                  <td className="py-2 pr-4">{fmtCost(row.costUsd)}</td>
                  <td className="py-2 pr-4">{Math.round(row.avgLatencyMs)}ms</td>
                  <td className="py-2 pr-4">{(row.errorRate * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Request Log ─────────────────────────────────────────────────────────────

function RequestLog() {
  const [page, setPage] = useState(1);
  const [modelFilter, setModelFilter] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const params = new URLSearchParams({
    page: String(page),
    limit: "50",
    ...(modelFilter ? { model: modelFilter } : {}),
    ...(providerFilter ? { provider: providerFilter } : {}),
    ...(statusFilter ? { status: statusFilter } : {}),
  });

  const { data, isLoading } = useQuery<RequestsResponse>({
    queryKey: ["stats-requests", page, modelFilter, providerFilter, statusFilter],
    queryFn: () => fetchJson(`/api/stats/requests?${params}`),
  });

  const { data: detail } = useQuery<LlmRequestRow & { messages: unknown; responseContent: string }>({
    queryKey: ["stats-request-detail", expandedId],
    queryFn: () => fetchJson(`/api/stats/requests/${expandedId}`),
    enabled: expandedId !== null,
  });

  const totalPages = data ? Math.ceil(data.total / 50) : 1;

  async function handleExport(format: "csv" | "json") {
    const res = await fetch(`/api/stats/export?format=${format}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelFilter || undefined,
        provider: providerFilter || undefined,
        status: statusFilter || undefined,
      }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `llm_requests.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm font-medium">Request Log</p>
        <div className="flex gap-2">
          <button
            onClick={() => handleExport("csv")}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:border-primary/50 text-muted-foreground"
          >
            <Download className="h-3 w-3" /> CSV
          </button>
          <button
            onClick={() => handleExport("json")}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:border-primary/50 text-muted-foreground"
          >
            <Download className="h-3 w-3" /> JSON
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <input
          type="text"
          placeholder="Filter by model..."
          value={modelFilter}
          onChange={(e) => { setModelFilter(e.target.value); setPage(1); }}
          className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground placeholder:text-muted-foreground"
        />
        <input
          type="text"
          placeholder="Filter by provider..."
          value={providerFilter}
          onChange={(e) => { setProviderFilter(e.target.value); setPage(1); }}
          className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground placeholder:text-muted-foreground"
        />
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground"
        >
          <option value="">All statuses</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
        </select>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : !data || data.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No requests found.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  {["Time", "Model", "Team", "In Tok", "Out Tok", "Cost", "Latency", "Status"].map((h) => (
                    <th key={h} className="text-left pb-2 pr-3 text-muted-foreground font-medium whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <>
                    <tr
                      key={row.id}
                      className="border-b border-border/50 hover:bg-muted/30 cursor-pointer"
                      onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                    >
                      <td className="py-1.5 pr-3 text-muted-foreground whitespace-nowrap">
                        {fmtDate(row.createdAt).slice(0, 16)}
                      </td>
                      <td className="py-1.5 pr-3 font-mono truncate max-w-[150px]">{row.modelSlug}</td>
                      <td className="py-1.5 pr-3 text-muted-foreground">{row.teamId ?? "—"}</td>
                      <td className="py-1.5 pr-3">{fmt(row.inputTokens)}</td>
                      <td className="py-1.5 pr-3">{fmt(row.outputTokens)}</td>
                      <td className="py-1.5 pr-3">{row.estimatedCostUsd ? fmtCost(row.estimatedCostUsd) : "—"}</td>
                      <td className="py-1.5 pr-3">{row.latencyMs}ms</td>
                      <td className="py-1.5 pr-3">
                        <span className={cn(
                          "px-1.5 py-0.5 rounded text-[10px] font-medium",
                          row.status === "success"
                            ? "bg-green-500/10 text-green-500"
                            : "bg-red-500/10 text-red-500",
                        )}>
                          {row.status}
                        </span>
                      </td>
                      <td className="py-1.5">
                        {expandedId === row.id
                          ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
                          : <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        }
                      </td>
                    </tr>
                    {expandedId === row.id && detail && (
                      <tr key={`${row.id}-detail`} className="border-b border-border/50">
                        <td colSpan={9} className="pb-3 pr-3">
                          <div className="rounded-md border border-border bg-muted/20 p-3 space-y-2 text-xs">
                            <div>
                              <p className="text-muted-foreground font-medium mb-1">Messages</p>
                              <pre className="text-[11px] whitespace-pre-wrap font-mono max-h-40 overflow-y-auto">
                                {JSON.stringify(detail.messages, null, 2)}
                              </pre>
                            </div>
                            {detail.responseContent && (
                              <div>
                                <p className="text-muted-foreground font-medium mb-1">Response</p>
                                <pre className="text-[11px] whitespace-pre-wrap font-mono max-h-40 overflow-y-auto">
                                  {detail.responseContent}
                                </pre>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{data.total} total</span>
            <div className="flex gap-2 items-center">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-2 py-1 rounded border border-border disabled:opacity-40 hover:border-primary/50"
              >
                Prev
              </button>
              <span>{page} / {totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-2 py-1 rounded border border-border disabled:opacity-40 hover:border-primary/50"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Statistics() {
  const { data: overview, isLoading: overviewLoading } = useQuery<StatsOverview>({
    queryKey: ["stats-overview"],
    queryFn: () => fetchJson("/api/stats/overview"),
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="h-16 border-b border-border flex items-center px-6 shrink-0">
        <h1 className="text-base font-semibold">Statistics</h1>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {overviewLoading || !overview ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-border bg-card p-4 animate-pulse h-20" />
            ))}
          </div>
        ) : (
          <SummaryCards overview={overview} />
        )}

        <TimelineChart />
        <ModelTable />
        <RequestLog />
      </div>
    </div>
  );
}
