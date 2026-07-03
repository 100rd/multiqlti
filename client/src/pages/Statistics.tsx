import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  Responsive,
  WidthProvider,
  type Layout,
  type ResponsiveLayouts,
} from "react-grid-layout/legacy";
import { Download, ChevronDown, ChevronRight, GripVertical, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  loadLayout,
  saveLayout,
  resetLayout,
} from "@/lib/dashboard-layout";

// react-grid-layout ships its own scoped CSS (targets `.react-grid-item` /
// `.react-resizable-handle` — it does NOT restyle our `.rounded-lg border ...`
// cards). react-resizable provides the resize-handle styles.
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

// ─── API types ───────────────────────────────────────────────────────────────

interface StatsOverview {
  totalRequests: number;
  totalTokens: { input: number; output: number; total: number };
  totalCostUsd: number;
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

interface WorkspaceStat {
  workspaceId: string | null;
  workspaceName: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
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

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(url, {
    ...init,
    headers: { ...authHeaders, ...init?.headers },
  });
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

// ─── Widget shell (drag handle lives on the header only) ───────────────────────
//
// The whole card is the react-grid-layout grid item, but ONLY the `.widget-drag-handle`
// element (grip + title) initiates a drag — RGL's `draggableHandle` prop points at it.
// Action controls (granularity/metric buttons, CSV/JSON export) are rendered as siblings
// of the handle (never inside it), so they stay clickable. The body is independently
// scrollable so inner tables / text selection / sorting keep working while the widget
// has a fixed grid height.

function WidgetShell({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="h-full flex flex-col rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2 shrink-0 border-b border-border/50">
        <div
          className="widget-drag-handle flex items-center gap-1.5 cursor-move select-none min-w-0"
          title="Drag to move"
        >
          <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />
          <p className="text-sm font-medium truncate">{title}</p>
        </div>
        {actions ? <div className="flex gap-2 flex-wrap justify-end">{actions}</div> : null}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-4">{children}</div>
    </div>
  );
}

// ─── Totals widget (formerly SummaryCards) ─────────────────────────────────────

function TotalsWidget({
  overview,
  loading,
}: {
  overview: StatsOverview | undefined;
  loading: boolean;
}) {
  if (loading || !overview) {
    return (
      <WidgetShell title="Totals">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-border bg-background/40 p-4 animate-pulse h-20" />
          ))}
        </div>
      </WidgetShell>
    );
  }

  const cards = [
    { label: "Total Requests", value: fmt(overview.totalRequests) },
    { label: "Total Tokens", value: fmt(overview.totalTokens.total) },
    { label: "Estimated Cost", value: fmtCost(overview.totalCostUsd) },
  ];

  return (
    <WidgetShell title="Totals">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-lg border border-border bg-background/40 p-4">
            <p className="text-xs text-muted-foreground">{c.label}</p>
            <p className="text-2xl font-semibold mt-1">{c.value}</p>
          </div>
        ))}
      </div>
    </WidgetShell>
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

  const actions = (
    <>
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
    </>
  );

  return (
    <WidgetShell title="Timeline" actions={actions}>
      {isLoading ? (
        <div className="h-full min-h-40 flex items-center justify-center text-xs text-muted-foreground">
          Loading...
        </div>
      ) : !data || data.length === 0 ? (
        <div className="h-full min-h-40 flex items-center justify-center text-xs text-muted-foreground">
          No data yet.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%" minHeight={160}>
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
    </WidgetShell>
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

  return (
    <WidgetShell title="Per-Model Breakdown">
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : sorted.length === 0 ? (
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
    </WidgetShell>
  );
}

// ─── Workspace Breakdown Table ─────────────────────────────────────────────────

type WorkspaceSortKey = "requests" | "tokens" | "costUsd" | "workspaceName";

function WorkspaceTable() {
  const { data, isLoading } = useQuery<WorkspaceStat[]>({
    queryKey: ["stats-by-workspace"],
    queryFn: () => fetchJson("/api/stats/by-workspace"),
  });

  const [sortKey, setSortKey] = useState<WorkspaceSortKey>("requests");
  const [sortAsc, setSortAsc] = useState(false);

  const toggleSort = (key: WorkspaceSortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  };

  const valueFor = (row: WorkspaceStat, key: WorkspaceSortKey): number | string => {
    switch (key) {
      case "workspaceName":
        return row.workspaceName;
      case "tokens":
        return row.inputTokens + row.outputTokens;
      case "requests":
        return row.requests;
      case "costUsd":
        return row.costUsd;
    }
  };

  const sorted = [...(data ?? [])].sort((a, b) => {
    const av = valueFor(a, sortKey);
    const bv = valueFor(b, sortKey);
    if (typeof av === "string" || typeof bv === "string") {
      const cmp = String(av).localeCompare(String(bv));
      return sortAsc ? cmp : -cmp;
    }
    return sortAsc ? av - bv : bv - av;
  });

  const cols: { label: string; key: WorkspaceSortKey }[] = [
    { label: "Workspace", key: "workspaceName" },
    { label: "Requests", key: "requests" },
    { label: "Tokens", key: "tokens" },
    { label: "Cost", key: "costUsd" },
  ];

  return (
    <WidgetShell title="Per-Workspace Breakdown">
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : sorted.length === 0 ? (
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
                <tr
                  key={row.workspaceId ?? "__unattributed__"}
                  className="border-b border-border/50 hover:bg-muted/30"
                >
                  <td className="py-2 pr-4">
                    {row.workspaceId === null ? (
                      <span className="text-muted-foreground italic">{row.workspaceName}</span>
                    ) : (
                      row.workspaceName
                    )}
                  </td>
                  <td className="py-2 pr-4">{fmt(row.requests)}</td>
                  <td className="py-2 pr-4">{fmt(row.inputTokens + row.outputTokens)}</td>
                  <td className="py-2 pr-4">{fmtCost(row.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </WidgetShell>
  );
}

// ─── Request Log ─────────────────────────────────────────────────────────────

function RequestLog() {
  const { toast } = useToast();
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
    const token = getAuthToken();
    const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(`/api/stats/export?format=${format}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        model: modelFilter || undefined,
        provider: providerFilter || undefined,
        status: statusFilter || undefined,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      toast({ variant: "destructive", title: "Export failed", description: err.error ?? `HTTP ${res.status}` });
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `llm_requests.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const actions = (
    <>
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
    </>
  );

  return (
    <WidgetShell title="Request Log" actions={actions}>
      <div className="space-y-3">
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
    </WidgetShell>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

// Classic WidthProvider(Responsive) composition from the `legacy` entry point:
// auto-measures container width and supplies responsive breakpoints.
const ResponsiveGridLayout = WidthProvider(Responsive);

const BREAKPOINTS = { lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 };
const COLS = { lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 };

// Scoped interaction CSS for the RGL grid. The pure data/config (draggableHandle,
// isDraggable/isResizable, controlled `layouts`, persistence) is correct in
// isolation; what an SSR/jsdom harness cannot exercise is real pointer-gesture
// arbitration. The grid lives inside an `overflow-y-auto` scroll container, so on
// touch / pen / precision-pointer devices the browser's default `touch-action`
// lets that scroll container claim a gesture that STARTS on a drag/resize handle
// (pan) before RGL's DraggableCore/Resizable can act — the widget then "can't be
// moved or resized". `touch-action: none` on the two handle selectors hands those
// gestures to RGL instead. The z-index keeps the SE resize corner hit-target above
// any widget body content (tables/charts) that paints into the same corner.
const DASHBOARD_GRID_CSS = `
.stats-dashboard-grid .widget-drag-handle { touch-action: none; }
.stats-dashboard-grid .react-resizable-handle { touch-action: none; z-index: 3; }
`;

export default function Statistics() {
  const { data: overview, isLoading: overviewLoading } = useQuery<StatsOverview>({
    queryKey: ["stats-overview"],
    queryFn: () => fetchJson("/api/stats/overview"),
  });

  const [layouts, setLayouts] = useState<ResponsiveLayouts>(() => loadLayout());

  const handleLayoutChange = (_current: Layout, allLayouts: ResponsiveLayouts) => {
    setLayouts(allLayouts);
    saveLayout(allLayouts);
  };

  const handleReset = () => {
    setLayouts(resetLayout());
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="h-16 border-b border-border flex items-center justify-between px-6 shrink-0">
        <h1 className="text-base font-semibold">Statistics</h1>
        <button
          onClick={handleReset}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-border text-muted-foreground hover:border-primary/50 hover:text-foreground transition-colors"
          title="Restore the default dashboard layout"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reset layout
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <style>{DASHBOARD_GRID_CSS}</style>
        <ResponsiveGridLayout
          className="stats-dashboard-grid"
          layouts={layouts}
          breakpoints={BREAKPOINTS}
          cols={COLS}
          rowHeight={40}
          margin={[16, 16]}
          containerPadding={[0, 0]}
          draggableHandle=".widget-drag-handle"
          isDraggable
          isResizable
          useCSSTransforms
          onLayoutChange={handleLayoutChange}
        >
          <div key="totals">
            <TotalsWidget overview={overview} loading={overviewLoading} />
          </div>
          <div key="timeline">
            <TimelineChart />
          </div>
          <div key="by-model">
            <ModelTable />
          </div>
          <div key="by-workspace">
            <WorkspaceTable />
          </div>
          <div key="request-log">
            <RequestLog />
          </div>
        </ResponsiveGridLayout>
      </div>
    </div>
  );
}
