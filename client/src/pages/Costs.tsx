/**
 * Workspace Cost Reporting UI (issue #279)
 *
 * Route: /workspaces/:id/costs
 *
 * Features:
 * - Stacked area chart of daily spend (by provider)
 * - Budget status cards with usage bars
 * - Top pipelines by cost
 * - Provider breakdown table
 * - CSV export button
 * - Budget CRUD dialog
 */

import { useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Loader2,
  RefreshCw,
  DollarSign,
  AlertTriangle,
  Download,
  Plus,
  Trash2,
  Edit2,
  ShieldAlert,
  Bell,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type BudgetPeriod = "day" | "week" | "month";

interface CostSummaryPoint {
  date: string;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
}

interface ProviderBreakdown {
  provider: string;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  callCount: number;
}

interface PipelineRollup {
  pipelineRunId: string;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  callCount: number;
}

interface BudgetRow {
  id: string;
  workspaceId: string;
  provider: string | null;
  period: BudgetPeriod;
  limitUsd: number;
  hard: boolean;
  notifyAtPct: number[];
  createdAt: string;
  updatedAt: string;
}

interface BudgetStatus {
  budget: BudgetRow;
  periodToDateUsd: number;
  usagePct: number;
  crossedThresholds: number[];
}

interface CostSummaryResponse {
  period: BudgetPeriod;
  periodStart: string;
  periodEnd: string;
  totalCostUsd: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  dailySeries: CostSummaryPoint[];
  byProvider: ProviderBreakdown[];
  topPipelines: PipelineRollup[];
  budgetStatuses: BudgetStatus[];
}

interface BudgetsResponse {
  budgets: BudgetRow[];
}

// ─── API helpers ──────────────────────────────────────────────────────────────

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

async function apiPatch<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

async function apiDelete(url: string): Promise<void> {
  const res = await fetch(url, { method: "DELETE", headers: authHeaders() });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
}

// ─── Mini chart ───────────────────────────────────────────────────────────────

const PROVIDER_COLOURS: Record<string, string> = {
  anthropic: "#8b5cf6",
  google:    "#22c55e",
  xai:       "#f59e0b",
  ollama:    "#3b82f6",
  vllm:      "#ec4899",
  lmstudio:  "#14b8a6",
  mock:      "#94a3b8",
};

function providerColour(provider: string): string {
  return PROVIDER_COLOURS[provider.toLowerCase()] ?? "#94a3b8";
}

interface MiniBarChartProps {
  series: CostSummaryPoint[];
  providers: ProviderBreakdown[];
  height?: number;
}

/** Simple SVG bar chart — no external charting library dependency. */
function MiniBarChart({ series, height = 120 }: MiniBarChartProps) {
  if (series.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-muted-foreground text-sm"
        style={{ height }}
      >
        No data for this period
      </div>
    );
  }

  const maxCost = Math.max(...series.map((p) => p.costUsd), 0.000001);
  const barWidth = Math.max(4, Math.floor(600 / series.length) - 2);
  const svgWidth = series.length * (barWidth + 2);

  return (
    <svg
      viewBox={`0 0 ${svgWidth} ${height}`}
      className="w-full"
      style={{ height }}
      preserveAspectRatio="none"
    >
      {series.map((point, i) => {
        const barH = Math.max(2, (point.costUsd / maxCost) * (height - 16));
        const x = i * (barWidth + 2);
        const y = height - barH - 4;
        return (
          <rect
            key={point.date}
            x={x}
            y={y}
            width={barWidth}
            height={barH}
            fill="#8b5cf6"
            opacity={0.8}
            rx={1}
          >
            <title>{`${point.date}: $${point.costUsd.toFixed(4)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

// ─── Budget usage bar ─────────────────────────────────────────────────────────

function BudgetUsageBar({ usagePct, hard }: { usagePct: number; hard: boolean }) {
  const pct = Math.min(100, usagePct);
  const colour = pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
      <div
        className={cn("h-2 rounded-full transition-all", colour, hard && pct >= 100 ? "animate-pulse" : "")}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ─── Budget form dialog ───────────────────────────────────────────────────────

interface BudgetFormState {
  provider: string;
  period: BudgetPeriod;
  limitUsd: string;
  hard: boolean;
  notifyAtPct: string;
}

const EMPTY_FORM: BudgetFormState = {
  provider: "",
  period: "month",
  limitUsd: "",
  hard: false,
  notifyAtPct: "50,80,100",
};

interface BudgetDialogProps {
  workspaceId: string;
  editing?: BudgetRow;
  onClose: () => void;
}

function BudgetDialog({ workspaceId, editing, onClose }: BudgetDialogProps) {
  const qc = useQueryClient();
  const [form, setForm] = useState<BudgetFormState>(
    editing
      ? {
          provider: editing.provider ?? "",
          period: editing.period,
          limitUsd: String(editing.limitUsd),
          hard: editing.hard,
          notifyAtPct: editing.notifyAtPct.join(","),
        }
      : EMPTY_FORM,
  );
  const [err, setErr] = useState<string>("");

  const parseNotifyPct = (raw: string): number[] =>
    raw
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n >= 0 && n <= 100);

  const createMut = useMutation({
    mutationFn: (body: unknown) =>
      apiPost(`/api/workspaces/${workspaceId}/budgets`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/workspaces", workspaceId, "budgets"] });
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const updateMut = useMutation({
    mutationFn: (body: unknown) =>
      apiPatch(`/api/workspaces/${workspaceId}/budgets/${editing!.id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/workspaces", workspaceId, "budgets"] });
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const limitUsd = parseFloat(form.limitUsd);
    if (isNaN(limitUsd) || limitUsd <= 0) {
      setErr("Limit must be a positive number");
      return;
    }
    const body = {
      provider: form.provider || undefined,
      period: form.period,
      limitUsd,
      hard: form.hard,
      notifyAtPct: parseNotifyPct(form.notifyAtPct),
    };
    if (editing) {
      updateMut.mutate(body);
    } else {
      createMut.mutate(body);
    }
  }

  const isPending = createMut.isPending || updateMut.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background border rounded-lg shadow-xl p-6 w-full max-w-md">
        <h3 className="text-lg font-semibold mb-4">
          {editing ? "Edit Budget" : "New Budget"}
        </h3>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              Provider (leave blank for all)
            </label>
            <input
              className="w-full rounded border px-3 py-2 text-sm bg-background"
              placeholder="anthropic, google, xai, …"
              value={form.provider}
              onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Period</label>
              <select
                className="w-full rounded border px-3 py-2 text-sm bg-background"
                value={form.period}
                onChange={(e) => setForm((f) => ({ ...f, period: e.target.value as BudgetPeriod }))}
              >
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Limit (USD)</label>
              <input
                type="number"
                min="0.001"
                step="0.01"
                className="w-full rounded border px-3 py-2 text-sm bg-background"
                placeholder="10.00"
                value={form.limitUsd}
                onChange={(e) => setForm((f) => ({ ...f, limitUsd: e.target.value }))}
                required
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              Alert thresholds % (comma-separated)
            </label>
            <input
              className="w-full rounded border px-3 py-2 text-sm bg-background"
              placeholder="50,80,100"
              value={form.notifyAtPct}
              onChange={(e) => setForm((f) => ({ ...f, notifyAtPct: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="hard"
              checked={form.hard}
              onChange={(e) => setForm((f) => ({ ...f, hard: e.target.checked }))}
              className="rounded"
            />
            <label htmlFor="hard" className="text-sm">
              Hard block (prevent calls when limit reached)
            </label>
          </div>
          {err && <p className="text-red-500 text-sm">{err}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : editing ? "Save" : "Create"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

function CostsView({ workspaceId }: { workspaceId: string }) {
  const [period, setPeriod] = useState<BudgetPeriod>("month");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingBudget, setEditingBudget] = useState<BudgetRow | undefined>(undefined);
  const qc = useQueryClient();

  const summaryQuery = useQuery<CostSummaryResponse>({
    queryKey: ["/api/workspaces", workspaceId, "costs", "summary", period],
    queryFn: () =>
      apiGet<CostSummaryResponse>(`/api/workspaces/${workspaceId}/costs/summary?period=${period}`),
    enabled: !!workspaceId,
    refetchInterval: 60_000,
  });

  const budgetsQuery = useQuery<BudgetsResponse>({
    queryKey: ["/api/workspaces", workspaceId, "budgets"],
    queryFn: () => apiGet<BudgetsResponse>(`/api/workspaces/${workspaceId}/budgets`),
    enabled: !!workspaceId,
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      apiDelete(`/api/workspaces/${workspaceId}/budgets/${id}`),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ["/api/workspaces", workspaceId, "budgets"] }),
  });

  function handleCsvExport() {
    const token = getAuthToken();
    const url = `/api/workspaces/${workspaceId}/costs/export?period=${period}`;
    const a = document.createElement("a");
    // If auth is Bearer token, open in same tab (token in header not URL)
    if (token) {
      void fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.blob())
        .then((blob) => {
          const href = URL.createObjectURL(blob);
          a.href = href;
          a.download = `costs-${period}.csv`;
          a.click();
          URL.revokeObjectURL(href);
        });
    } else {
      a.href = url;
      a.download = `costs-${period}.csv`;
      a.click();
    }
  }

  const summary = summaryQuery.data;
  const budgets = budgetsQuery.data?.budgets ?? [];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href={`/workspaces/${workspaceId}`}>
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Workspace
            </Button>
          </Link>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <DollarSign className="h-6 w-6 text-emerald-500" />
            Cost Reporting
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {/* Period selector */}
          <div className="flex rounded-lg border overflow-hidden text-sm">
            {(["day", "week", "month"] as BudgetPeriod[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={cn(
                  "px-3 py-1.5 capitalize transition-colors",
                  period === p
                    ? "bg-primary text-primary-foreground"
                    : "bg-background hover:bg-muted",
                )}
              >
                {p}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => summaryQuery.refetch()}>
            <RefreshCw className={cn("h-4 w-4", summaryQuery.isFetching && "animate-spin")} />
          </Button>
          <Button variant="outline" size="sm" onClick={handleCsvExport}>
            <Download className="h-4 w-4 mr-1" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Error state */}
      {summaryQuery.isError && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive text-sm">
          {summaryQuery.error instanceof Error ? summaryQuery.error.message : "Failed to load cost data"}
        </div>
      )}

      {/* Loading state */}
      {summaryQuery.isLoading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {summary && (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KpiCard
              label="Total Cost"
              value={`$${summary.totalCostUsd.toFixed(4)}`}
              sub={`${summary.period} to date`}
              icon={<DollarSign className="h-4 w-4 text-emerald-500" />}
            />
            <KpiCard
              label="Prompt Tokens"
              value={summary.totalPromptTokens.toLocaleString()}
              sub="input tokens"
            />
            <KpiCard
              label="Completion Tokens"
              value={summary.totalCompletionTokens.toLocaleString()}
              sub="output tokens"
            />
            <KpiCard
              label="Providers"
              value={String(summary.byProvider.length)}
              sub="active providers"
            />
          </div>

          {/* Daily spend chart */}
          <div className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
              Daily Spend
            </h2>
            <MiniBarChart
              series={summary.dailySeries}
              providers={summary.byProvider}
              height={120}
            />
            <div className="mt-2 flex flex-wrap gap-3">
              {summary.byProvider.map((p) => (
                <span key={p.provider} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-sm"
                    style={{ background: providerColour(p.provider) }}
                  />
                  {p.provider}
                </span>
              ))}
            </div>
          </div>

          {/* Provider breakdown + Top pipelines */}
          <div className="grid md:grid-cols-2 gap-4">
            {/* Provider breakdown */}
            <div className="rounded-lg border bg-card p-4">
              <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
                By Provider
              </h2>
              {summary.byProvider.length === 0 ? (
                <p className="text-sm text-muted-foreground">No data</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b">
                      <th className="text-left pb-2">Provider</th>
                      <th className="text-right pb-2">Cost</th>
                      <th className="text-right pb-2">Calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byProvider.map((p) => (
                      <tr key={p.provider} className="border-b last:border-0">
                        <td className="py-2 flex items-center gap-2">
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ background: providerColour(p.provider) }}
                          />
                          {p.provider}
                        </td>
                        <td className="py-2 text-right font-mono text-xs">
                          ${p.costUsd.toFixed(4)}
                        </td>
                        <td className="py-2 text-right text-muted-foreground">
                          {p.callCount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Top pipelines */}
            <div className="rounded-lg border bg-card p-4">
              <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
                Top Pipelines by Cost
              </h2>
              {summary.topPipelines.length === 0 ? (
                <p className="text-sm text-muted-foreground">No pipeline runs recorded</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b">
                      <th className="text-left pb-2">Run ID</th>
                      <th className="text-right pb-2">Cost</th>
                      <th className="text-right pb-2">Calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.topPipelines.slice(0, 8).map((p) => (
                      <tr key={p.pipelineRunId} className="border-b last:border-0">
                        <td className="py-2 font-mono text-xs truncate max-w-[140px]">
                          {p.pipelineRunId.slice(0, 8)}…
                        </td>
                        <td className="py-2 text-right font-mono text-xs">
                          ${p.costUsd.toFixed(4)}
                        </td>
                        <td className="py-2 text-right text-muted-foreground">
                          {p.callCount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Budget statuses */}
          {summary.budgetStatuses.length > 0 && (
            <div className="rounded-lg border bg-card p-4">
              <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
                Budget Status
              </h2>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {summary.budgetStatuses.map(({ budget, periodToDateUsd, usagePct, crossedThresholds }) => (
                  <div key={budget.id} className="rounded-lg border p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        {budget.hard ? (
                          <ShieldAlert className="h-3.5 w-3.5 text-red-500" />
                        ) : (
                          <Bell className="h-3.5 w-3.5 text-amber-500" />
                        )}
                        <span className="text-sm font-medium">
                          {budget.provider ?? "All providers"}
                        </span>
                      </div>
                      <Badge
                        className={cn(
                          "text-xs",
                          usagePct >= 100
                            ? "bg-red-100 text-red-700 border-red-300"
                            : usagePct >= 80
                            ? "bg-amber-100 text-amber-700 border-amber-300"
                            : "bg-emerald-100 text-emerald-700 border-emerald-300",
                        )}
                      >
                        {usagePct.toFixed(0)}%
                      </Badge>
                    </div>
                    <BudgetUsageBar usagePct={usagePct} hard={budget.hard} />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>${periodToDateUsd.toFixed(4)}</span>
                      <span>of ${budget.limitUsd.toFixed(2)} / {budget.period}</span>
                    </div>
                    {crossedThresholds.length > 0 && (
                      <div className="flex items-center gap-1 text-xs text-amber-600">
                        <AlertTriangle className="h-3 w-3" />
                        Alert: {crossedThresholds.join("%, ")}% thresholds crossed
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Budget management */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Budgets
          </h2>
          <Button size="sm" onClick={() => { setEditingBudget(undefined); setDialogOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" />
            New Budget
          </Button>
        </div>

        {budgetsQuery.isLoading && (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}

        {budgets.length === 0 && !budgetsQuery.isLoading && (
          <p className="text-sm text-muted-foreground">
            No budgets configured. Create one to track and enforce spending limits.
          </p>
        )}

        {budgets.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b">
                <th className="text-left pb-2">Provider</th>
                <th className="text-left pb-2">Period</th>
                <th className="text-right pb-2">Limit</th>
                <th className="text-left pb-2">Type</th>
                <th className="text-left pb-2">Alerts</th>
                <th className="text-right pb-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {budgets.map((b) => (
                <tr key={b.id} className="border-b last:border-0">
                  <td className="py-2">{b.provider ?? <span className="text-muted-foreground italic">All</span>}</td>
                  <td className="py-2 capitalize">{b.period}</td>
                  <td className="py-2 text-right font-mono text-xs">${b.limitUsd.toFixed(2)}</td>
                  <td className="py-2">
                    {b.hard ? (
                      <Badge className="bg-red-100 text-red-700 border-red-300 text-xs">Hard</Badge>
                    ) : (
                      <Badge className="bg-amber-100 text-amber-700 border-amber-300 text-xs">Soft</Badge>
                    )}
                  </td>
                  <td className="py-2 text-xs text-muted-foreground">
                    {b.notifyAtPct.length > 0 ? b.notifyAtPct.join("%, ") + "%" : "—"}
                  </td>
                  <td className="py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { setEditingBudget(b); setDialogOpen(true); }}
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => deleteMut.mutate(b.id)}
                        disabled={deleteMut.isPending}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Budget dialog */}
      {dialogOpen && (
        <BudgetDialog
          workspaceId={workspaceId}
          editing={editingBudget}
          onClose={() => { setDialogOpen(false); setEditingBudget(undefined); }}
        />
      )}
    </div>
  );
}

// ─── KPI card ──────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
        {icon}
      </div>
      <div className="text-xl font-bold font-mono">{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
    </div>
  );
}

// ─── Exported page component ──────────────────────────────────────────────────

export default function Costs() {
  const [, params] = useRoute("/workspaces/:id/costs");
  const workspaceId = params?.id ?? "";
  return <CostsView workspaceId={workspaceId} />;
}
