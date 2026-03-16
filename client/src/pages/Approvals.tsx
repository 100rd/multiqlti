import { useState, useEffect, useCallback } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { wsClient } from "@/lib/websocket";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { Loader2, CheckCircle2, XCircle, ShieldCheck, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import type { ApprovalGateConfig, WsEvent } from "@shared/types";

// ── Types ────────────────────────────────────────────────────────────────────

interface PendingApprovalRow {
  runId: string;
  pipelineId: string;
  pipelineName: string;
  stageIndex: number;
  stageExecutionId: string;
  teamId: string;
  modelSlug: string;
  gateConfig: ApprovalGateConfig | null;
  awaitingSince: string;
  output: Record<string, unknown> | null;
}

interface PendingApprovalsResponse {
  approvals: PendingApprovalRow[];
  total: number;
}

// ── API ──────────────────────────────────────────────────────────────────────

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function apiRequest(method: string, url: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Gate type badge colors ──────────────────────────────────────────────────

function gateTypeBadge(config: ApprovalGateConfig | null): {
  label: string;
  className: string;
} {
  if (!config || config.type === "manual") {
    return {
      label: "Manual",
      className: "bg-blue-500/15 text-blue-700 border-blue-500/30",
    };
  }
  if (config.type === "auto") {
    return {
      label: "Auto-Approve",
      className: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
    };
  }
  return {
    label: `Timeout (${config.timeoutMinutes ?? 0}m)`,
    className: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  };
}

function formatWaitTime(since: string): string {
  const diffMs = Date.now() - new Date(since).getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// ── Approval events that should refresh the list ─────────────────────────────

const APPROVAL_EVENTS = new Set([
  "stage:awaiting_approval",
  "stage:approved",
  "stage:rejected",
  "stage:auto_approved",
  "stage:timeout_approved",
  "stage:timeout_rejected",
]);

// ── Component ────────────────────────────────────────────────────────────────

export default function Approvals() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [rejectTarget, setRejectTarget] = useState<PendingApprovalRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  // Fetch pending approvals
  const {
    data,
    isLoading,
    error,
  } = useQuery<PendingApprovalsResponse>({
    queryKey: ["approvals-pending"],
    queryFn: () => apiRequest("GET", "/api/approvals/pending"),
    refetchInterval: 30_000,
  });

  // WebSocket: invalidate on approval-related events
  const handleWsEvent = useCallback(
    (event: WsEvent) => {
      if (APPROVAL_EVENTS.has(event.type)) {
        queryClient.invalidateQueries({ queryKey: ["approvals-pending"] });
      }
    },
    [queryClient],
  );

  useEffect(() => {
    wsClient.connect();
    const unsub = wsClient.onAny(handleWsEvent);
    return () => {
      unsub();
    };
  }, [handleWsEvent]);

  // Approve mutation
  const approveMutation = useMutation({
    mutationFn: ({
      runId,
      stageIndex,
    }: {
      runId: string;
      stageIndex: number;
    }) =>
      apiRequest("POST", `/api/runs/${runId}/stages/${stageIndex}/approve`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["approvals-pending"] });
      toast({ title: "Approved", description: "Stage has been approved." });
    },
    onError: (err: Error) => {
      toast({
        title: "Approval failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Reject mutation
  const rejectMutation = useMutation({
    mutationFn: ({
      runId,
      stageIndex,
      reason,
    }: {
      runId: string;
      stageIndex: number;
      reason?: string;
    }) =>
      apiRequest("POST", `/api/runs/${runId}/stages/${stageIndex}/reject`, {
        reason,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["approvals-pending"] });
      setRejectTarget(null);
      setRejectReason("");
      toast({ title: "Rejected", description: "Stage has been rejected." });
    },
    onError: (err: Error) => {
      toast({
        title: "Rejection failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handleRejectConfirm = () => {
    if (!rejectTarget) return;
    rejectMutation.mutate({
      runId: rejectTarget.runId,
      stageIndex: rejectTarget.stageIndex,
      reason: rejectReason.trim() || undefined,
    });
  };

  const approvals = data?.approvals ?? [];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-14 border-b border-border flex items-center justify-between px-6 bg-card shrink-0">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h1 className="text-sm font-semibold">Pending Approvals</h1>
          {approvals.length > 0 && (
            <Badge
              variant="secondary"
              className="bg-amber-500/15 text-amber-700 text-[10px] h-5"
            >
              {approvals.length}
            </Badge>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden p-6">
        {isLoading && (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="p-4 rounded-lg border border-red-500/30 bg-red-500/5 text-sm text-red-700">
            Failed to load pending approvals:{" "}
            {error instanceof Error ? error.message : "Unknown error"}
          </div>
        )}

        {!isLoading && !error && approvals.length === 0 && (
          <Empty className="h-full border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShieldCheck className="h-6 w-6" />
              </EmptyMedia>
              <EmptyTitle>No pending approvals</EmptyTitle>
              <EmptyDescription>
                When pipeline stages require approval, they will appear here for
                you to review and approve or reject.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {!isLoading && !error && approvals.length > 0 && (
          <ScrollArea className="h-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Pipeline</TableHead>
                  <TableHead className="text-xs">Stage</TableHead>
                  <TableHead className="text-xs">Run</TableHead>
                  <TableHead className="text-xs">Waiting Since</TableHead>
                  <TableHead className="text-xs">Gate Type</TableHead>
                  <TableHead className="text-xs text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {approvals.map((approval) => {
                  const gate = gateTypeBadge(approval.gateConfig);
                  return (
                    <TableRow key={approval.stageExecutionId}>
                      <TableCell className="text-xs font-medium">
                        {approval.pipelineName}
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="font-mono text-muted-foreground">
                          {approval.stageIndex + 1}.
                        </span>{" "}
                        {approval.teamId}
                        {approval.modelSlug && (
                          <span className="text-muted-foreground ml-1.5">
                            ({approval.modelSlug})
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        <Link
                          href={`/runs/${approval.runId}`}
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          {approval.runId.slice(0, 8)}
                          <ExternalLink className="h-3 w-3" />
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatWaitTime(approval.awaitingSince)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] h-5 px-1.5 border",
                            gate.className,
                          )}
                        >
                          {gate.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center gap-1.5 justify-end">
                          <Button
                            size="sm"
                            className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                            disabled={approveMutation.isPending}
                            onClick={() =>
                              approveMutation.mutate({
                                runId: approval.runId,
                                stageIndex: approval.stageIndex,
                              })
                            }
                            aria-label={`Approve stage ${approval.stageIndex + 1} of ${approval.pipelineName}`}
                          >
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-7 text-xs"
                            disabled={rejectMutation.isPending}
                            onClick={() => {
                              setRejectTarget(approval);
                              setRejectReason("");
                            }}
                            aria-label={`Reject stage ${approval.stageIndex + 1} of ${approval.pipelineName}`}
                          >
                            <XCircle className="h-3 w-3 mr-1" />
                            Reject
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </ScrollArea>
        )}
      </div>

      {/* Reject reason dialog */}
      <Dialog
        open={rejectTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRejectTarget(null);
            setRejectReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Stage</DialogTitle>
            <DialogDescription>
              {rejectTarget && (
                <>
                  Rejecting stage {rejectTarget.stageIndex + 1} (
                  {rejectTarget.teamId}) of pipeline{" "}
                  <strong>{rejectTarget.pipelineName}</strong>. This will stop
                  the pipeline run.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <label
              htmlFor="reject-reason"
              className="text-sm font-medium mb-1.5 block"
            >
              Reason (optional)
            </label>
            <Textarea
              id="reject-reason"
              placeholder="Explain why this stage is being rejected..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              className="min-h-[80px] resize-y"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRejectTarget(null);
                setRejectReason("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRejectConfirm}
              disabled={rejectMutation.isPending}
            >
              {rejectMutation.isPending && (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              )}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
