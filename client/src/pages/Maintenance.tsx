/**
 * Maintenance Autopilot Dashboard — Phase 6.11
 *
 * Four-tab interface (audit tab admin-only):
 *   - Overview: health score, open findings summary, last scan activity
 *   - Policies: CRUD for maintenance policies with inline editing + admin auto-trigger config
 *   - Scans: scan history with expandable finding details (CVE / log-analysis / container sub-sections)
 *   - Audit: auto-trigger pipeline run audit log (admin only)
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  RefreshCw,
  Settings2,
  ChevronDown,
  ChevronRight,
  Clock,
  Activity,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Plus,
  Trash2,
  Play,
  Box,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";

// ─── API Types ────────────────────────────────────────────────────────────────

interface MaintenancePolicyRow {
  id: string;
  workspaceId: string | null;
  enabled: boolean;
  schedule: string;
  categories: Array<{
    category: string;
    enabled: boolean;
    severity: string;
  }>;
  severityThreshold: string;
  autoMerge: boolean;
  notifyChannels: string[];
  createdAt: string;
  updatedAt: string;
  // Phase 6.11 additions
  autoTriggerEnabled: boolean;
  autoTriggerPipelineId: string | null;
  logSourceConfig: { type: "file" | "http"; path?: string; url?: string } | null;
}

interface ScoutFinding {
  id: string;
  scanId: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  description: string;
  currentValue: string;
  recommendedValue: string;
  autoFixable: boolean;
  status: "open" | "actioned" | "dismissed";
  references?: string[];
}

interface MaintenanceScanRow {
  id: string;
  policyId: string | null;
  workspaceId: string | null;
  status: "running" | "completed" | "failed";
  findings: ScoutFinding[];
  importantCount: number;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

interface DashboardData {
  totalPolicies: number;
  enabledPolicies: number;
  totalScans: number;
  openFindings: number;
  severityCounts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  lastScanAt: string | null;
  recentScans: MaintenanceScanRow[];
}

interface HealthData {
  score: number;
  breakdown: {
    openFindings: number;
    complianceCoverage: number;
    meanTimeToFix: number;
    scanFrequency: number;
  };
  trend: "improving" | "stable" | "declining";
}

// Phase 6.11: Audit record for auto-triggered pipeline runs
interface AutoTriggerAuditRecord {
  id: string;
  scanId: string;
  findingId: string;
  pipelineRunId: string;
  triggeredAt: string;
  triggeredBy: string;
}

// ─── API Helpers ──────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── Severity Badge ───────────────────────────────────────────────────────────

const SEVERITY_STYLES: Record<ScoutFinding["severity"], string> = {
  critical: "bg-red-600 text-white",
  high: "bg-orange-500 text-white",
  medium: "bg-yellow-500 text-white",
  low: "bg-blue-500 text-white",
  info: "bg-gray-400 text-white",
};

function SeverityBadge({ severity }: { severity: ScoutFinding["severity"] }) {
  return (
    <span
      className={cn(
        "inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
        SEVERITY_STYLES[severity],
      )}
    >
      {severity}
    </span>
  );
}

// ─── Health Score Ring ────────────────────────────────────────────────────────

function HealthRing({ score, trend }: { score: number; trend: HealthData["trend"] }) {
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  const ringColor =
    score >= 80 ? "stroke-green-500" : score >= 60 ? "stroke-yellow-500" : "stroke-red-500";

  const TrendIcon =
    trend === "improving" ? CheckCircle2 : trend === "declining" ? XCircle : Activity;
  const trendColor =
    trend === "improving"
      ? "text-green-600"
      : trend === "declining"
        ? "text-red-600"
        : "text-gray-500";

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width="100" height="100" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="currentColor" strokeWidth="8" className="text-muted/20" />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={ringColor}
          style={{ transform: "rotate(-90deg)", transformOrigin: "50% 50%", transition: "stroke-dashoffset 0.5s ease" }}
        />
        <text x="50" y="54" textAnchor="middle" fontSize="18" fontWeight="bold" fill="currentColor" className="fill-foreground">
          {score}
        </text>
      </svg>
      <div className={cn("flex items-center gap-1 text-sm font-medium", trendColor)}>
        <TrendIcon className="h-4 w-4" />
        {trend}
      </div>
    </div>
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab() {
  const { data: dashboard, isLoading: dashLoading } = useQuery<DashboardData>({
    queryKey: ["/api/maintenance/dashboard"],
    queryFn: () => apiFetch("/api/maintenance/dashboard"),
    refetchInterval: 30_000,
  });

  // Health is per-workspace; show aggregate from dashboard when no workspace selected
  const hasRecentScan = dashboard?.recentScans?.[0]?.workspaceId;
  const { data: health } = useQuery<HealthData>({
    queryKey: ["/api/maintenance/health", hasRecentScan],
    queryFn: () =>
      hasRecentScan
        ? apiFetch<HealthData>(`/api/maintenance/health/${hasRecentScan}`)
        : Promise.resolve({ score: 0, breakdown: { openFindings: 0, complianceCoverage: 0, meanTimeToFix: 0, scanFrequency: 0 }, trend: "stable" as const }),
    enabled: true,
  });

  if (dashLoading) {
    return <div className="py-12 text-center text-muted-foreground text-sm">Loading dashboard...</div>;
  }

  if (!dashboard) {
    return <div className="py-12 text-center text-muted-foreground text-sm">No data available.</div>;
  }

  return (
    <div className="space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={<Shield className="h-5 w-5 text-blue-500" />}
          label="Active Policies"
          value={`${dashboard.enabledPolicies}/${dashboard.totalPolicies}`}
        />
        <StatCard
          icon={<Activity className="h-5 w-5 text-purple-500" />}
          label="Total Scans"
          value={dashboard.totalScans}
        />
        <StatCard
          icon={<AlertTriangle className="h-5 w-5 text-orange-500" />}
          label="Open Findings"
          value={dashboard.openFindings}
          alert={dashboard.openFindings > 0}
        />
        <StatCard
          icon={<Clock className="h-5 w-5 text-gray-500" />}
          label="Last Scan"
          value={dashboard.lastScanAt ? new Date(dashboard.lastScanAt).toLocaleDateString() : "Never"}
        />
      </div>

      {/* Health + Severity */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Health Score */}
        <div className="rounded-lg border bg-card p-5">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">
            Workspace Health
          </h3>
          {health ? (
            <div className="flex items-center gap-6">
              <HealthRing score={health.score} trend={health.trend} />
              <div className="space-y-2 text-sm">
                <div className="flex justify-between gap-8">
                  <span className="text-muted-foreground">Open Findings</span>
                  <span className="font-medium">{health.breakdown.openFindings}</span>
                </div>
                <div className="flex justify-between gap-8">
                  <span className="text-muted-foreground">Compliance</span>
                  <span className="font-medium">{health.breakdown.complianceCoverage}%</span>
                </div>
                <div className="flex justify-between gap-8">
                  <span className="text-muted-foreground">Scans Run</span>
                  <span className="font-medium">{health.breakdown.scanFrequency}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-muted-foreground text-sm">No scan data available.</div>
          )}
        </div>

        {/* Severity Breakdown */}
        <div className="rounded-lg border bg-card p-5">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">
            Open Findings by Severity
          </h3>
          <div className="space-y-3">
            {(["critical", "high", "medium", "low"] as const).map((sev) => {
              const count = dashboard.severityCounts[sev] ?? 0;
              const max = Math.max(1, ...Object.values(dashboard.severityCounts));
              return (
                <div key={sev} className="flex items-center gap-3">
                  <div className="w-16 text-right">
                    <SeverityBadge severity={sev} />
                  </div>
                  <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        sev === "critical"
                          ? "bg-red-500"
                          : sev === "high"
                            ? "bg-orange-400"
                            : sev === "medium"
                              ? "bg-yellow-400"
                              : "bg-blue-400",
                      )}
                      style={{ width: `${(count / max) * 100}%` }}
                    />
                  </div>
                  <span className="w-8 text-sm font-medium text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Recent Scans */}
      <div className="rounded-lg border bg-card p-5">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">
          Recent Scans
        </h3>
        {dashboard.recentScans.length === 0 ? (
          <div className="text-muted-foreground text-sm py-4 text-center">No scans yet.</div>
        ) : (
          <div className="space-y-2">
            {dashboard.recentScans.slice(0, 5).map((scan) => (
              <div key={scan.id} className="flex items-center gap-3 text-sm py-2 border-b last:border-b-0">
                <ScanStatusIcon status={scan.status} />
                <span className="flex-1 font-mono text-xs text-muted-foreground truncate">{scan.id}</span>
                <span className="text-muted-foreground">{scan.importantCount} important</span>
                <span className="text-muted-foreground">
                  {new Date(scan.createdAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  alert,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  alert?: boolean;
}) {
  return (
    <div className={cn("rounded-lg border bg-card p-4", alert && "border-orange-400")}>
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className={cn("text-2xl font-bold", alert && "text-orange-500")}>{value}</div>
    </div>
  );
}

function ScanStatusIcon({ status }: { status: MaintenanceScanRow["status"] }) {
  if (status === "completed") return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />;
  if (status === "failed") return <XCircle className="h-4 w-4 text-red-500 shrink-0" />;
  return <RefreshCw className="h-4 w-4 text-blue-500 animate-spin shrink-0" />;
}

// ─── Policies Tab ─────────────────────────────────────────────────────────────

const DEFAULT_SCHEDULE = "0 9 * * 1";

// Phase 6.11: Policy card with optional admin auto-trigger section
function PolicyCard({ policy }: { policy: MaintenancePolicyRow }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const qc = useQueryClient();

  const [autoExpanded, setAutoExpanded] = useState(false);
  const [draftEnabled, setDraftEnabled] = useState(policy.autoTriggerEnabled ?? false);
  const [draftPipelineId, setDraftPipelineId] = useState(policy.autoTriggerPipelineId ?? "");
  const [validationError, setValidationError] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/maintenance/policies/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/maintenance/policies"] });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`/api/maintenance/policies/${id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/maintenance/policies"] });
    },
  });

  const triggerMutation = useMutation({
    mutationFn: (policyId: string) =>
      apiFetch("/api/maintenance/scans/trigger", {
        method: "POST",
        body: JSON.stringify({ policyId }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/maintenance/scans"] });
    },
  });

  const autoTriggerMutation = useMutation({
    mutationFn: ({
      id,
      autoTriggerEnabled,
      autoTriggerPipelineId,
    }: {
      id: string;
      autoTriggerEnabled: boolean;
      autoTriggerPipelineId: string | null;
    }) =>
      apiFetch(`/api/maintenance/policies/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ autoTriggerEnabled, autoTriggerPipelineId }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/maintenance/policies"] });
      setAutoExpanded(false);
    },
  });

  const handleAutoTriggerSave = () => {
    setValidationError(null);
    if (draftEnabled && !draftPipelineId.trim()) {
      setValidationError("Pipeline ID is required when auto-trigger is enabled.");
      return;
    }
    autoTriggerMutation.mutate({
      id: policy.id,
      autoTriggerEnabled: draftEnabled,
      autoTriggerPipelineId: draftEnabled ? draftPipelineId.trim() : null,
    });
  };

  const handleAutoTriggerCancel = () => {
    setDraftEnabled(policy.autoTriggerEnabled ?? false);
    setDraftPipelineId(policy.autoTriggerPipelineId ?? "");
    setValidationError(null);
    setAutoExpanded(false);
  };

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      {/* Policy header row */}
      <div className="flex items-center gap-3">
        {policy.enabled ? (
          <ShieldCheck className="h-5 w-5 text-green-500 shrink-0" />
        ) : (
          <Shield className="h-5 w-5 text-muted-foreground shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs text-muted-foreground">{policy.id.slice(0, 8)}…</span>
            <span className="text-sm font-medium">{policy.schedule}</span>
            <span className="text-xs border rounded px-1.5 py-0.5">{policy.severityThreshold}</span>
            {!policy.enabled && (
              <span className="text-xs text-muted-foreground border rounded px-1.5 py-0.5">disabled</span>
            )}
            {policy.autoTriggerEnabled && (
              <span className="text-xs border border-purple-300 text-purple-600 rounded px-1.5 py-0.5 dark:border-purple-700 dark:text-purple-400">
                auto-trigger on
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => triggerMutation.mutate(policy.id)}
            disabled={triggerMutation.isPending || !policy.workspaceId}
            title={policy.workspaceId ? "Trigger scan now" : "No workspace linked"}
            className="p-1.5 rounded hover:bg-muted disabled:opacity-40"
          >
            <Play className="h-4 w-4" />
          </button>
          <button
            onClick={() => toggleMutation.mutate({ id: policy.id, enabled: !policy.enabled })}
            disabled={toggleMutation.isPending}
            className="p-1.5 rounded hover:bg-muted"
          >
            <Settings2 className="h-4 w-4" />
          </button>
          <button
            onClick={() => deleteMutation.mutate(policy.id)}
            disabled={deleteMutation.isPending}
            className="p-1.5 rounded hover:bg-destructive/10 text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Admin: Auto-trigger settings toggle */}
      {isAdmin && (
        <div className="border-t pt-2">
          <button
            onClick={() => setAutoExpanded((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {autoExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Auto-trigger settings
          </button>

          {autoExpanded && (
            <div className="mt-3 space-y-3 pl-1">
              {/* Enable switch */}
              <div className="flex items-center gap-3">
                <Switch
                  id={`auto-trigger-${policy.id}`}
                  checked={draftEnabled}
                  onCheckedChange={setDraftEnabled}
                />
                <label
                  htmlFor={`auto-trigger-${policy.id}`}
                  className="text-sm cursor-pointer select-none"
                >
                  Enable auto-trigger pipeline on new findings
                </label>
              </div>

              {/* Pipeline ID input (only shown when enabled) */}
              {draftEnabled && (
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Pipeline ID <span className="text-destructive">*</span>
                  </label>
                  <input
                    className="border rounded px-2 py-1 text-sm bg-background w-64"
                    value={draftPipelineId}
                    onChange={(e) => setDraftPipelineId(e.target.value)}
                    placeholder="e.g. pipeline-abc123"
                  />
                </div>
              )}

              {/* Validation error */}
              {validationError && (
                <p className="text-destructive text-xs">{validationError}</p>
              )}
              {autoTriggerMutation.isError && (
                <p className="text-destructive text-xs">
                  {(autoTriggerMutation.error as Error).message}
                </p>
              )}

              {/* Save / Cancel */}
              <div className="flex gap-2">
                <button
                  onClick={handleAutoTriggerSave}
                  disabled={autoTriggerMutation.isPending}
                  className="rounded bg-primary text-primary-foreground px-3 py-1 text-xs hover:bg-primary/90 disabled:opacity-50"
                >
                  {autoTriggerMutation.isPending ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={handleAutoTriggerCancel}
                  className="rounded border px-3 py-1 text-xs hover:bg-muted"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PoliciesTab() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newSchedule, setNewSchedule] = useState(DEFAULT_SCHEDULE);
  const [newSeverity, setNewSeverity] = useState<string>("high");

  const { data: policies, isLoading } = useQuery<MaintenancePolicyRow[]>({
    queryKey: ["/api/maintenance/policies"],
    queryFn: () => apiFetch("/api/maintenance/policies"),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch<MaintenancePolicyRow>("/api/maintenance/policies", {
        method: "POST",
        body: JSON.stringify({
          schedule: newSchedule,
          enabled: true,
          severityThreshold: newSeverity,
          categories: [],
          autoMerge: false,
          notifyChannels: [],
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/maintenance/policies"] });
      setCreating(false);
      setNewSchedule(DEFAULT_SCHEDULE);
    },
  });

  if (isLoading) {
    return <div className="py-12 text-center text-muted-foreground text-sm">Loading policies...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New Policy
        </button>
      </div>

      {creating && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <h4 className="font-medium text-sm">New Policy</h4>
          <div className="flex gap-3 flex-wrap">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Cron Schedule</label>
              <input
                className="border rounded px-2 py-1 text-sm bg-background w-40"
                value={newSchedule}
                onChange={(e) => setNewSchedule(e.target.value)}
                placeholder="0 9 * * 1"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Severity Threshold</label>
              <select
                className="border rounded px-2 py-1 text-sm bg-background"
                value={newSeverity}
                onChange={(e) => setNewSeverity(e.target.value)}
              >
                {["critical", "high", "medium", "low", "info"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending}
              className="rounded bg-primary text-primary-foreground px-3 py-1 text-sm hover:bg-primary/90 disabled:opacity-50"
            >
              {createMutation.isPending ? "Creating..." : "Create"}
            </button>
            <button
              onClick={() => setCreating(false)}
              className="rounded border px-3 py-1 text-sm hover:bg-muted"
            >
              Cancel
            </button>
          </div>
          {createMutation.isError && (
            <p className="text-destructive text-xs">{(createMutation.error as Error).message}</p>
          )}
        </div>
      )}

      {(policies ?? []).length === 0 && !creating ? (
        <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground text-sm">
          No policies configured. Create one to start automated maintenance scanning.
        </div>
      ) : (
        <div className="space-y-2">
          {(policies ?? []).map((policy) => (
            <PolicyCard key={policy.id} policy={policy} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Scans Tab — Categorised Finding Sub-Sections ────────────────────────────

const SEVERITY_ORDER: Array<ScoutFinding["severity"]> = ["critical", "high", "medium", "low", "info"];

function sortBySeverity(findings: ScoutFinding[]): ScoutFinding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
}

/** CVE Findings sub-section */
function CveFindingsSection({ findings }: { findings: ScoutFinding[] }) {
  const cveFindings = sortBySeverity(findings.filter((f) => f.category === "cve_scan"));
  if (cveFindings.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-red-500" />
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          CVE Findings ({cveFindings.length})
        </h4>
      </div>
      {cveFindings.map((f) => (
        <div key={f.id} className="rounded border p-3 text-sm space-y-1.5">
          <div className="flex items-start gap-2">
            <SeverityBadge severity={f.severity} />
            <div className="flex-1 min-w-0">
              <p className="font-medium">{f.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{f.description}</p>
              {f.currentValue && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  CVSS score: <span className="font-medium text-foreground">{f.currentValue}</span>
                </p>
              )}
            </div>
          </div>
          {f.references && f.references.length > 0 && (
            <div className="flex flex-wrap gap-2 pl-0.5">
              {f.references.map((ref) => (
                <a
                  key={ref}
                  href={ref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-blue-600 underline underline-offset-2 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 truncate max-w-xs"
                >
                  {ref}
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Log Analysis sub-section */
function LogAnalysisSection({ findings }: { findings: ScoutFinding[] }) {
  const logFindings = sortBySeverity(findings.filter((f) => f.category === "log_analysis"));
  if (logFindings.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-purple-500" />
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Log Analysis ({logFindings.length})
        </h4>
      </div>
      {logFindings.map((f) => (
        <div key={f.id} className="rounded border p-3 text-sm">
          <div className="flex items-start gap-2">
            <SeverityBadge severity={f.severity} />
            <div className="flex-1 min-w-0">
              <p className="font-medium">{f.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{f.description}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Container Scan sub-section */
function ContainerScanSection({ findings }: { findings: ScoutFinding[] }) {
  const containerFindings = sortBySeverity(findings.filter((f) => f.category === "container_scan"));
  if (containerFindings.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Box className="h-4 w-4 text-teal-500" />
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Container Scan ({containerFindings.length})
        </h4>
      </div>
      {containerFindings.map((f) => (
        <div
          key={f.id}
          className={cn(
            "rounded border p-3 text-sm",
            f.severity === "info" && "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/20",
          )}
        >
          <div className="flex items-start gap-2">
            <SeverityBadge severity={f.severity} />
            <div className="flex-1 min-w-0">
              <p className="font-medium">{f.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{f.description}</p>
              {f.severity === "info" && (
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 italic">
                  Tip: Install Trivy for full scanning
                </p>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Scans Tab ────────────────────────────────────────────────────────────────

const CATEGORISED_CATEGORIES = new Set(["cve_scan", "log_analysis", "container_scan"]);

function ScansTab() {
  const [expandedScan, setExpandedScan] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const qc = useQueryClient();

  const { data: scans, isLoading } = useQuery<MaintenanceScanRow[]>({
    queryKey: ["/api/maintenance/scans"],
    queryFn: () => apiFetch("/api/maintenance/scans"),
    refetchInterval: 15_000,
  });

  const handleAction = async (
    findingId: string,
    scanId: string,
    action: "sdlc" | "backlog" | "dismiss",
  ) => {
    setActionLoading(findingId);
    try {
      await apiFetch(`/api/maintenance/findings/${findingId}/action`, {
        method: "POST",
        body: JSON.stringify({ action, scanId }),
      });
      await qc.invalidateQueries({ queryKey: ["/api/maintenance/scans"] });
    } finally {
      setActionLoading(null);
    }
  };

  if (isLoading) {
    return <div className="py-12 text-center text-muted-foreground text-sm">Loading scans...</div>;
  }

  const sortedScans = [...(scans ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <div className="space-y-2">
      {sortedScans.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground text-sm">
          No scans yet. Trigger a scan from the Policies tab.
        </div>
      ) : (
        sortedScans.map((scan) => {
          const isExpanded = expandedScan === scan.id;
          const openFindings = scan.findings.filter((f) => f.status === "open");
          // Findings NOT handled by a dedicated category section
          const otherFindings = scan.findings.filter(
            (f) => !CATEGORISED_CATEGORIES.has(f.category),
          );

          return (
            <div key={scan.id} className="rounded-lg border bg-card overflow-hidden">
              <button
                className="w-full flex items-center gap-3 p-4 text-left hover:bg-muted/50"
                onClick={() => setExpandedScan(isExpanded ? null : scan.id)}
              >
                <ScanStatusIcon status={scan.status} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-mono text-xs text-muted-foreground">{scan.id.slice(0, 12)}…</span>
                    <span>{scan.findings.length} findings</span>
                    {openFindings.length > 0 && (
                      <span className="text-orange-500 font-medium">{openFindings.length} open</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {new Date(scan.createdAt).toLocaleString()}
                    {scan.completedAt && (
                      <span className="ml-2">
                        · completed {new Date(scan.completedAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
              </button>

              {isExpanded && (
                <div className="border-t bg-muted/20 p-4 space-y-4">
                  {scan.findings.length === 0 ? (
                    <div className="text-sm text-muted-foreground text-center py-4">
                      No findings in this scan.
                    </div>
                  ) : (
                    <>
                      {/* Phase 6.11: Categorised sub-sections */}
                      <CveFindingsSection findings={scan.findings} />
                      <LogAnalysisSection findings={scan.findings} />
                      <ContainerScanSection findings={scan.findings} />

                      {/* Generic findings (non-categorised) */}
                      {otherFindings.length > 0 && (
                        <div className="space-y-2">
                          {(CATEGORISED_CATEGORIES.size > 0 &&
                            scan.findings.some((f) => CATEGORISED_CATEGORIES.has(f.category))) && (
                            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              Other Findings ({otherFindings.length})
                            </h4>
                          )}
                          {otherFindings.map((finding) => (
                            <FindingRow
                              key={finding.id}
                              finding={finding}
                              scanId={scan.id}
                              actionLoading={actionLoading}
                              onAction={handleAction}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function FindingRow({
  finding,
  scanId,
  actionLoading,
  onAction,
}: {
  finding: ScoutFinding;
  scanId: string;
  actionLoading: string | null;
  onAction: (id: string, scanId: string, action: "sdlc" | "backlog" | "dismiss") => Promise<void>;
}) {
  return (
    <div
      className={cn(
        "rounded border p-3 text-sm",
        finding.status === "dismissed" && "opacity-50",
        finding.status === "actioned" && "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/20",
      )}
    >
      <div className="flex items-start gap-2">
        <SeverityBadge severity={finding.severity} />
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">{finding.title}</p>
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{finding.description}</p>
          <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
            <span>Category: {finding.category.replace(/_/g, " ")}</span>
            {finding.autoFixable && (
              <span className="text-green-600 font-medium">auto-fixable</span>
            )}
          </div>
        </div>
        {finding.status === "open" && (
          <div className="flex gap-1 shrink-0">
            {(["sdlc", "backlog", "dismiss"] as const).map((action) => (
              <button
                key={action}
                onClick={() => onAction(finding.id, scanId, action)}
                disabled={actionLoading === finding.id}
                className={cn(
                  "rounded px-2 py-0.5 text-[11px] font-medium border transition-colors",
                  action === "dismiss"
                    ? "border-muted-foreground/30 text-muted-foreground hover:bg-muted"
                    : "border-primary/30 text-primary hover:bg-primary/10",
                  actionLoading === finding.id && "opacity-50",
                )}
              >
                {action}
              </button>
            ))}
          </div>
        )}
        {finding.status !== "open" && (
          <span className="text-xs text-muted-foreground shrink-0 capitalize">{finding.status}</span>
        )}
      </div>
    </div>
  );
}

// ─── Audit Tab (Admin Only) ───────────────────────────────────────────────────

function AuditTab() {
  const { data: records, isLoading } = useQuery<AutoTriggerAuditRecord[]>({
    queryKey: ["/api/maintenance/auto-trigger-audit"],
    queryFn: () => apiFetch("/api/maintenance/auto-trigger-audit"),
  });

  if (isLoading) {
    return <div className="py-12 text-center text-muted-foreground text-sm">Loading audit log...</div>;
  }

  const rows = records ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Auto-Trigger Pipeline Runs
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Records of pipelines automatically triggered by maintenance scan findings.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground text-sm">
          No auto-triggered pipeline runs yet.
        </div>
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b">
              <tr>
                <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Triggered At
                </th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Scan ID
                </th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Finding ID
                </th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Pipeline Run ID
                </th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Triggered By
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((record, idx) => (
                <tr key={record.id} className={cn("border-b last:border-b-0", idx % 2 === 1 && "bg-muted/20")}>
                  <td className="px-4 py-2 text-xs whitespace-nowrap">
                    {new Date(record.triggeredAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                    {record.scanId.slice(0, 12)}…
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                    {record.findingId.slice(0, 12)}…
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                    {record.pipelineRunId.slice(0, 12)}…
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {record.triggeredBy.slice(0, 20)}{record.triggeredBy.length > 20 ? "…" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type Tab = "overview" | "policies" | "scans" | "audit";

export default function Maintenance() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [activeTab, setActiveTab] = useState<Tab>("overview");

  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: "overview", label: "Overview", icon: <ShieldAlert className="h-4 w-4" /> },
    { id: "policies", label: "Policies", icon: <Settings2 className="h-4 w-4" /> },
    { id: "scans", label: "Scans", icon: <Activity className="h-4 w-4" /> },
    // Audit tab: admin only
    ...(isAdmin
      ? [{ id: "audit" as const, label: "Audit", icon: <Clock className="h-4 w-4" /> }]
      : []),
  ];

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Shield className="h-6 w-6" />
          Maintenance Autopilot
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Automated dependency, security, and license scanning for your workspaces.
        </p>
      </div>

      {/* Tab Bar */}
      <div className="flex gap-1 border-b">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              activeTab === tab.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === "overview" && <OverviewTab />}
      {activeTab === "policies" && <PoliciesTab />}
      {activeTab === "scans" && <ScansTab />}
      {activeTab === "audit" && isAdmin && <AuditTab />}
    </div>
  );
}
