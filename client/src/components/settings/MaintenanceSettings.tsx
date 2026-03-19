import { useState } from "react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { Loader2, ShieldCheck, Shield } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/hooks/use-pipeline";

const SCHEDULE_PRESETS = [
  { label: "Daily at 9am", value: "0 9 * * *" },
  { label: "Weekly (Mon 9am)", value: "0 9 * * 1" },
  { label: "Monthly (1st, 9am)", value: "0 9 1 * *" },
];

const SEVERITY_OPTIONS = ["critical", "high", "medium", "low", "info"] as const;

interface MaintenancePolicySummary {
  id: string;
  enabled: boolean;
  schedule: string;
  severityThreshold: string;
}

interface MaintenanceSettingsProps {
  /** When true, renders content only without a Card wrapper. Use inside SettingsSection. */
  noCard?: boolean;
}

export default function MaintenanceSettings({ noCard = false }: MaintenanceSettingsProps) {
  const qc = useQueryClient();

  const { data: policies, isLoading } = useQuery<MaintenancePolicySummary[]>({
    queryKey: ["/api/maintenance/policies"],
    queryFn: () =>
      apiRequest("GET", "/api/maintenance/policies") as Promise<MaintenancePolicySummary[]>,
  });

  const firstPolicy = policies?.[0] ?? null;

  const [schedule, setSchedule] = useState(SCHEDULE_PRESETS[1].value);
  const [severity, setSeverity] = useState<string>("high");

  const createPolicy = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/maintenance/policies", {
        enabled: true,
        schedule,
        severityThreshold: severity,
        categories: [],
        autoMerge: false,
        notifyChannels: [],
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["/api/maintenance/policies"] }),
  });

  const togglePolicy = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiRequest("PUT", `/api/maintenance/policies/${id}`, { enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["/api/maintenance/policies"] }),
  });

  const updatePolicy = useMutation({
    mutationFn: ({ id, schedule: s, severityThreshold }: { id: string; schedule: string; severityThreshold: string }) =>
      apiRequest("PUT", `/api/maintenance/policies/${id}`, { schedule: s, severityThreshold }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["/api/maintenance/policies"] }),
  });

  const isEnabled = firstPolicy?.enabled ?? false;

  const inner = (
    <div className={cn("space-y-4", noCard ? "p-4" : "")}>
      <p className="text-xs text-muted-foreground">
        Automatically scan workspaces for dependency updates, security advisories, and license issues.
        Configure and manage scans in detail from the{" "}
        <a href="/maintenance" className="text-primary underline underline-offset-2">
          Maintenance
        </a>{" "}
        page.
      </p>

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading...
        </div>
      ) : (
        <div className="space-y-4">
          {/* Enable/disable toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Enable Autopilot</p>
              <p className="text-xs text-muted-foreground">
                {firstPolicy
                  ? isEnabled
                    ? "Autopilot is active — scans run on schedule"
                    : "Autopilot is paused"
                  : "No policy configured yet"}
              </p>
            </div>
            <Switch
              checked={isEnabled}
              onCheckedChange={(checked) => {
                if (firstPolicy) {
                  togglePolicy.mutate({ id: firstPolicy.id, enabled: checked });
                } else if (checked) {
                  createPolicy.mutate();
                }
              }}
              disabled={togglePolicy.isPending || createPolicy.isPending}
            />
          </div>

          {/* Schedule selector */}
          <div className="flex items-center gap-3">
            <label className="text-xs font-medium w-32 shrink-0">Default Schedule</label>
            <Select
              value={firstPolicy?.schedule ?? schedule}
              onValueChange={(val) => {
                setSchedule(val);
                if (firstPolicy) {
                  updatePolicy.mutate({ id: firstPolicy.id, schedule: val, severityThreshold: firstPolicy.severityThreshold });
                }
              }}
            >
              <SelectTrigger className="h-8 text-xs flex-1">
                <SelectValue placeholder="Select schedule" />
              </SelectTrigger>
              <SelectContent>
                {SCHEDULE_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value} className="text-xs">
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Severity threshold selector */}
          <div className="flex items-center gap-3">
            <label className="text-xs font-medium w-32 shrink-0">Severity Threshold</label>
            <Select
              value={firstPolicy?.severityThreshold ?? severity}
              onValueChange={(val) => {
                setSeverity(val);
                if (firstPolicy) {
                  updatePolicy.mutate({ id: firstPolicy.id, schedule: firstPolicy.schedule, severityThreshold: val });
                }
              }}
            >
              <SelectTrigger className="h-8 text-xs flex-1">
                <SelectValue placeholder="Select threshold" />
              </SelectTrigger>
              <SelectContent>
                {SEVERITY_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s} className="text-xs capitalize">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {(togglePolicy.isError || createPolicy.isError || updatePolicy.isError) && (
            <p className="text-xs text-destructive">
              {((togglePolicy.error ?? createPolicy.error ?? updatePolicy.error) as Error).message}
            </p>
          )}
        </div>
      )}
    </div>
  );

  if (noCard) return inner;

  // Legacy standalone card render (backward-compat for any direct usage)
  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="px-4 py-3 border-b border-border">
        <p className="text-base font-semibold flex items-center gap-2">
          {isEnabled ? (
            <ShieldCheck className="h-4 w-4 text-green-500" />
          ) : (
            <Shield className="h-4 w-4 text-muted-foreground" />
          )}
          Maintenance Autopilot
        </p>
      </div>
      {inner}
    </div>
  );
}
