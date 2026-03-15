import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWebSocket } from "@/hooks/use-websocket";
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowRight, Network } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WsEvent } from "@shared/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DelegationRow {
  id: string;
  runId: string;
  fromStage: string;
  toStage: string;
  task: string;
  priority: "blocking" | "async";
  status: "pending" | "running" | "completed" | "failed" | "timeout" | "rejected";
  depth: number;
  startedAt: string;
  completedAt: string | null;
}

interface DelegationLogProps {
  runId: string;
  isActive: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return "—";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return "< 1s";
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function isDelegationEvent(type: string): boolean {
  return type === "delegation:requested" ||
    type === "delegation:completed" ||
    type === "delegation:failed";
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: DelegationRow["status"] }) {
  const variants: Record<DelegationRow["status"], { label: string; className: string; spinner?: boolean }> = {
    pending: { label: "pending", className: "bg-muted text-muted-foreground" },
    running: { label: "running", className: "bg-blue-500/20 text-blue-700", spinner: true },
    completed: { label: "completed", className: "bg-emerald-500/20 text-emerald-700" },
    failed: { label: "failed", className: "bg-red-500/20 text-red-700" },
    timeout: { label: "timeout", className: "bg-red-500/20 text-red-700" },
    rejected: { label: "rejected", className: "bg-red-500/20 text-red-700" },
  };

  const v = variants[status] ?? variants.pending;

  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", v.className)}>
      {v.spinner && <Loader2 className="h-3 w-3 animate-spin" />}
      {v.label}
    </span>
  );
}

// ─── Priority badge ────────────────────────────────────────────────────────────

function PriorityBadge({ priority }: { priority: DelegationRow["priority"] }) {
  return (
    <span className={cn(
      "rounded-full px-2 py-0.5 text-xs font-medium",
      priority === "blocking"
        ? "bg-amber-500/20 text-amber-700"
        : "bg-blue-500/20 text-blue-700",
    )}>
      {priority}
    </span>
  );
}

// ─── Stage badge ──────────────────────────────────────────────────────────────

function StageBadge({ stageId }: { stageId: string }) {
  return (
    <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground">
      {stageId}
    </span>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function DelegationLog({ runId, isActive }: DelegationLogProps) {
  const queryClient = useQueryClient();
  const queryKey = ["/api/runs", runId, "delegations"];

  const { data: delegations = [], isLoading } = useQuery<DelegationRow[]>({
    queryKey,
    queryFn: async () => {
      const token = localStorage.getItem("auth_token");
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`/api/runs/${runId}/delegations`, { headers });
      if (!res.ok) throw new Error("Failed to fetch delegations");
      return res.json() as Promise<DelegationRow[]>;
    },
    refetchInterval: isActive ? 3000 : false,
    staleTime: 0,
  });

  // Subscribe to WS events and invalidate query on any delegation event
  const { lastEvent } = useWebSocket(runId);

  useEffect(() => {
    if (!lastEvent) return;
    const event = lastEvent as WsEvent;
    if (event.runId === runId && isDelegationEvent(event.type)) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [lastEvent, runId, queryClient, queryKey]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (delegations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
        <Network className="mb-3 h-8 w-8 opacity-40" />
        <p className="text-sm">No delegations in this run</p>
        <p className="mt-1 text-xs opacity-70">
          Delegations appear when a stage invokes another stage as a sub-task.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="pb-2 pr-4 font-medium">From</th>
            <th className="pb-2 pr-4 font-medium"></th>
            <th className="pb-2 pr-4 font-medium">To</th>
            <th className="pb-2 pr-4 font-medium">Task</th>
            <th className="pb-2 pr-4 font-medium">Priority</th>
            <th className="pb-2 pr-4 font-medium">Status</th>
            <th className="pb-2 font-medium">Duration</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {delegations.map((d) => (
            <tr key={d.id} className="py-2">
              <td className="py-2 pr-4">
                <StageBadge stageId={d.fromStage} />
              </td>
              <td className="pr-4">
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
              </td>
              <td className="py-2 pr-4">
                <StageBadge stageId={d.toStage} />
              </td>
              <td className="py-2 pr-4 max-w-xs" title={d.task}>
                {truncate(d.task, 60)}
              </td>
              <td className="py-2 pr-4">
                <PriorityBadge priority={d.priority} />
              </td>
              <td className="py-2 pr-4">
                <StatusBadge status={d.status} />
              </td>
              <td className="py-2 tabular-nums text-muted-foreground">
                {formatDuration(d.startedAt, d.completedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
