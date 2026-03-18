import { useState, useEffect, useCallback } from "react";
import { useParams } from "wouter";
import { usePipelineRun, useCancelRun, useApproveStage, useRejectStage, useExportRun, usePipeline, useSwarmResults } from "@/hooks/use-pipeline";
import { usePipelineEvents, useWebSocket } from "@/hooks/use-websocket";
import StageProgress from "@/components/pipeline/StageProgress";
import QuestionPanel from "@/components/pipeline/QuestionPanel";
import StageOutput from "@/components/pipeline/StageOutput";
import DelegationLog from "@/components/pipeline/DelegationLog";
import SwarmProgress from "@/components/pipeline/SwarmProgress";
import SwarmResultView from "@/components/pipeline/SwarmResultView";
import { ManagerDecisionFeed } from "@/components/manager/ManagerDecisionFeed";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StopCircle, ArrowLeft, Loader2, CheckCircle2, XCircle, Download, ChevronDown } from "lucide-react";
import { Link } from "wouter";
import { SDLC_TEAMS } from "@shared/constants";
import type { PipelineStageConfig, SwarmResult, SwarmCloneResult, SwarmMerger } from "@shared/types";
import { cn } from "@/lib/utils";


// Live-tracking state for a swarm clone during execution (not yet a completed SwarmCloneResult)
interface SwarmCloneState {
  cloneIndex: number;
  status: "running" | "succeeded" | "failed";
  systemPromptPreview?: string;
  tokensUsed?: number;
  outputPreview?: string;
  durationMs?: number;
  error?: string;
}

// ─── SwarmResultLoader: fetches results and renders SwarmResultView ────────────

interface SwarmResultLoaderProps {
  runId: string;
  stageIndex: number;
}

function SwarmResultLoader({ runId, stageIndex }: SwarmResultLoaderProps) {
  const { data, isLoading } = useSwarmResults(runId, stageIndex);
  if (isLoading) return null;
  if (!data?.swarmMeta || !data?.cloneResults) return null;
  return (
    <SwarmResultView
      mergedOutput={""}
      cloneResults={data.cloneResults}
      swarmMeta={data.swarmMeta}
    />
  );
}

const statusColors: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-blue-500/20 text-blue-700",
  paused: "bg-amber-500/20 text-amber-700",
  completed: "bg-emerald-500/20 text-emerald-700",
  failed: "bg-red-500/20 text-red-700",
  cancelled: "bg-muted text-muted-foreground",
  rejected: "bg-red-500/20 text-red-700",
};

export default function PipelineRun() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId ?? "";
  const { data: run, isLoading } = usePipelineRun(runId);
  const cancelMutation = useCancelRun();
  const approveMutation = useApproveStage();
  const rejectMutation = useRejectStage();
  const exportMutation = useExportRun();
  const pipelineEvents = usePipelineEvents(runId);
  const { data: pipeline } = usePipeline(run?.pipelineId ?? "");
  const isManagerMode = pipeline != null && (pipeline as Record<string, unknown>).managerConfig != null;

  const [rejectReasonMap, setRejectReasonMap] = useState<Record<number, string>>({});

  // ─── Swarm state (keyed by stageExecutionId) ────────────────────────────────
  interface SwarmStageState {
    cloneCount: number;
    cloneResults: SwarmCloneState[];
    isMerging: boolean;
    isCompleted: boolean;
    mergerUsed?: SwarmMerger;
    stageIndex: number;
  }
  const [swarmStates, setSwarmStates] = useState<Map<string, SwarmStageState>>(new Map());

  // ─── Swarm WS event handler ─────────────────────────────────────────────────
  const { lastEvent } = useWebSocket(runId);

  const handleSwarmEvent = useCallback(() => {
    if (!lastEvent || lastEvent.runId !== runId) return;
    const seId = lastEvent.stageExecutionId;
    if (!seId) return;
    const p = lastEvent.payload;

    // Cast to string for swarm event types (added in shared/types.ts by Phase 6.7 backend branch)
    const eventType = lastEvent.type as string;
    switch (eventType) {
      case "swarm:started": {
        const cloneCount = p.cloneCount as number;
        const merger = p.merger as SwarmMerger;
        const stageIndex = p.stageIndex as number ?? 0;
        setSwarmStates(prev => {
          const next = new Map(prev);
          next.set(seId, {
            cloneCount,
            cloneResults: [],
            isMerging: false,
            isCompleted: false,
            mergerUsed: merger,
            stageIndex,
          });
          return next;
        });
        break;
      }
      case "swarm:clone:started": {
        const cloneIndex = p.cloneIndex as number;
        const systemPromptPreview = p.systemPromptPreview as string | undefined;
        setSwarmStates(prev => {
          const next = new Map(prev);
          const existing = next.get(seId);
          if (!existing) return prev;
          const filtered = existing.cloneResults.filter(r => r.cloneIndex !== cloneIndex);
          next.set(seId, {
            ...existing,
            cloneResults: [...filtered, { cloneIndex, status: "running", systemPromptPreview }],
          });
          return next;
        });
        break;
      }
      case "swarm:clone:completed": {
        const cloneIndex = p.cloneIndex as number;
        const tokensUsed = p.tokensUsed as number | undefined;
        const outputPreview = p.outputPreview as string | undefined;
        const durationMs = p.durationMs as number | undefined;
        setSwarmStates(prev => {
          const next = new Map(prev);
          const existing = next.get(seId);
          if (!existing) return prev;
          const filtered = existing.cloneResults.filter(r => r.cloneIndex !== cloneIndex);
          next.set(seId, {
            ...existing,
            cloneResults: [
              ...filtered,
              { cloneIndex, status: "succeeded", tokensUsed, outputPreview, durationMs },
            ],
          });
          return next;
        });
        break;
      }
      case "swarm:clone:failed": {
        const cloneIndex = p.cloneIndex as number;
        const error = p.error as string | undefined;
        setSwarmStates(prev => {
          const next = new Map(prev);
          const existing = next.get(seId);
          if (!existing) return prev;
          const filtered = existing.cloneResults.filter(r => r.cloneIndex !== cloneIndex);
          next.set(seId, {
            ...existing,
            cloneResults: [...filtered, { cloneIndex, status: "failed", error }],
          });
          return next;
        });
        break;
      }
      case "swarm:merging": {
        setSwarmStates(prev => {
          const next = new Map(prev);
          const existing = next.get(seId);
          if (!existing) return prev;
          next.set(seId, { ...existing, isMerging: true });
          return next;
        });
        break;
      }
      case "swarm:completed": {
        setSwarmStates(prev => {
          const next = new Map(prev);
          const existing = next.get(seId);
          if (!existing) return prev;
          next.set(seId, { ...existing, isMerging: false, isCompleted: true });
          return next;
        });
        break;
      }
      default:
        break;
    }
  }, [lastEvent, runId]);

  useEffect(() => {
    handleSwarmEvent();
  }, [handleSwarmEvent]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        Run not found
      </div>
    );
  }

  const status = pipelineEvents.status !== "pending" ? pipelineEvents.status : run.status;
  const pipelineStages = (run.stages ?? []) as Array<{
    id: string;
    stageIndex: number;
    teamId: string;
    modelSlug: string;
    status: string;
    output: Record<string, unknown> | null;
    tokensUsed: number;
    approvalStatus?: string | null;
  }>;

  // Merge WS live data with server data for stages
  const stagesMap = pipelineEvents.stages;
  if (stagesMap.size === 0 && pipelineStages.length > 0) {
    for (const s of pipelineStages) {
      stagesMap.set(s.stageIndex, {
        teamId: s.teamId,
        modelSlug: s.modelSlug,
        status: s.status as any,
        output: s.output ?? undefined,
        tokensUsed: s.tokensUsed,
      });
    }
  }

  const completedStages = pipelineStages.filter((s) => s.status === "completed" && s.output);
  const questions = pipelineEvents.questions.length > 0
    ? pipelineEvents.questions
    : (run.questions ?? []);

  const { pendingApprovals, swarmStages } = pipelineEvents;

  // Derive approvals from server data if WS hasn't emitted events yet
  const serverPendingApprovals = pipelineStages
    .filter((s) => s.status === "awaiting_approval" && s.approvalStatus === "pending")
    .map((s) => ({ stageIndex: s.stageIndex, stageExecutionId: s.id, teamId: s.teamId }));

  const activeApprovals = pendingApprovals.length > 0 ? pendingApprovals : serverPendingApprovals;

  const isActiveRun = status === "running" || status === "paused";
  const isTerminal = status === "completed" || status === "failed" || status === "cancelled" || status === "rejected";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-14 border-b border-border flex items-center justify-between px-6 bg-card shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/workflow">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h2 className="text-sm font-semibold truncate max-w-[400px]">
              {run.input?.slice(0, 60)}
              {run.input?.length > 60 ? "..." : ""}
            </h2>
            <div className="flex items-center gap-2 mt-0.5">
              <Badge className={cn("text-[10px] h-4 px-1.5", statusColors[status] ?? "bg-muted text-muted-foreground")}>
                {status}
              </Badge>
              <span className="text-[10px] text-muted-foreground">
                Run {runId.slice(0, 8)}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Export button — always visible */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1"
                disabled={exportMutation.isPending}
              >
                {exportMutation.isPending
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <Download className="h-3 w-3" />}
                Export
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => exportMutation.mutate({ runId, format: "markdown" })}
              >
                Markdown Report
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => exportMutation.mutate({ runId, format: "zip" })}
              >
                ZIP (report + code)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Cancel button */}
          {isActiveRun && (
            <Button
              variant="destructive"
              size="sm"
              className="h-8 text-xs"
              onClick={() => cancelMutation.mutate(runId)}
              disabled={cancelMutation.isPending}
            >
              <StopCircle className="h-3 w-3 mr-1" /> Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Approval Gate Banner */}
      {activeApprovals.length > 0 && (
        <div className="border-b border-amber-200 bg-amber-50 px-6 py-3 shrink-0">
          <p className="text-xs font-medium text-amber-800 mb-2">
            Waiting for approval before continuing
          </p>
          <div className="flex flex-col gap-2">
            {activeApprovals.map((approval) => (
              <div key={approval.stageIndex} className="flex items-center gap-3">
                <span className="text-xs text-amber-700">
                  Stage {approval.stageIndex + 1} ({approval.teamId}) is awaiting approval
                </span>
                <Button
                  size="sm"
                  className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                  disabled={approveMutation.isPending}
                  onClick={() => approveMutation.mutate({ runId, stageIndex: approval.stageIndex })}
                >
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 text-xs"
                  disabled={rejectMutation.isPending}
                  onClick={() => rejectMutation.mutate({
                    runId,
                    stageIndex: approval.stageIndex,
                    reason: rejectReasonMap[approval.stageIndex],
                  })}
                >
                  <XCircle className="h-3 w-3 mr-1" />
                  Reject
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Rejection notice */}
      {status === "rejected" && (
        <div className="border-b border-red-200 bg-red-50 px-6 py-3 shrink-0">
          <p className="text-xs text-red-700">
            This pipeline run was rejected at a governance gate and did not complete.
          </p>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left sidebar — stages + questions */}
        <div className="w-72 border-r border-border bg-card shrink-0 flex flex-col overflow-hidden">
          <ScrollArea className="flex-1 p-4">
            <StageProgress
              stages={stagesMap}
              currentStageIndex={pipelineEvents.currentStageIndex}
            />
            <div className="mt-6">
              <QuestionPanel runId={runId} questions={questions} />
            </div>
          </ScrollArea>
        </div>

        {/* Main area */}
        <div className="flex-1 overflow-hidden">
          <Tabs defaultValue="output" className="h-full flex flex-col">
            <TabsList className={`mx-6 mt-4 grid w-auto ${isManagerMode ? "grid-cols-5" : "grid-cols-4"} max-w-2xl`}>
              <TabsTrigger value="output" className="text-xs">
                Output
              </TabsTrigger>
              <TabsTrigger value="chat" className="text-xs">
                Chat
              </TabsTrigger>
              <TabsTrigger value="raw" className="text-xs">
                Raw Data
              </TabsTrigger>
              <TabsTrigger value="delegations" className="text-xs">
                Delegations
              </TabsTrigger>
              {isManagerMode && (
                <TabsTrigger value="manager" className="text-xs">
                  Manager
                </TabsTrigger>
              )}
            </TabsList>

            <div className="flex-1 overflow-hidden p-6">
              <TabsContent value="output" className="h-full overflow-y-auto">
                <div className="space-y-4">
                  {completedStages.length === 0 && status === "running" && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Pipeline is running...
                    </div>
                  )}
                  {/* Active swarm stages — show live progress */}
                  {Array.from(swarmStages.entries()).map(([stageId, swarmState]) => {
                    const isActive = !swarmState.isCompleted;
                    if (!isActive) return null;
                    return (
                      <div key={stageId} className="p-4 rounded-lg border border-border bg-card">
                        <SwarmProgress
                          cloneCount={swarmState.cloneCount}
                          cloneResults={swarmState.cloneResults}
                          isCompleted={swarmState.isCompleted}
                          isMerging={swarmState.isMerging}
                          mergerUsed={swarmState.mergerUsed}
                        />
                      </div>
                    );
                  })}

                  {completedStages.map((stage) => {
                    const team =
                      SDLC_TEAMS[
                        stage.teamId as keyof typeof SDLC_TEAMS
                      ];
                    const swarmMeta = stage.output?.swarmMeta as SwarmResult | undefined;
                    const hasSwarmData = swarmMeta != null && Array.isArray((swarmMeta as SwarmResult).cloneResults);
                    return (
                      <div key={stage.id}>
                        <StageOutput
                          key={stage.id}
                          teamId={stage.teamId}
                          teamName={team?.name ?? stage.teamId}
                          output={stage.output!}
                          isActive={
                            stage.stageIndex ===
                            pipelineEvents.currentStageIndex
                          }
                        />
                        {hasSwarmData && (
                          <div className="mt-2 p-4 rounded-lg border border-border bg-card">
                            <SwarmResultView
                              mergedOutput={(stage.output?.raw as string) ?? ""}
                              cloneResults={(swarmMeta as SwarmResult).cloneResults}
                              swarmMeta={swarmMeta as SwarmResult}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {status === "completed" && (
                    <div className="p-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 text-sm text-emerald-700">
                      Pipeline completed successfully.{" "}
                      {completedStages.length} stages executed.
                    </div>
                  )}
                  {status === "failed" && (
                    <div className="p-4 rounded-lg border border-red-500/30 bg-red-500/5 text-sm text-red-700">
                      Pipeline failed. Check the stage outputs for details.
                    </div>
                  )}
                  {status === "rejected" && (
                    <div className="p-4 rounded-lg border border-red-500/30 bg-red-500/5 text-sm text-red-700">
                      Pipeline rejected at a governance gate.{" "}
                      {completedStages.length} stages completed before rejection.
                    </div>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="chat" className="h-full overflow-y-auto">
                <div className="space-y-3">
                  {pipelineEvents.messages.map((msg) => (
                    <div
                      key={msg.id}
                      className="p-3 rounded-lg border border-border"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <Badge
                          variant="outline"
                          className="text-[10px] h-4 px-1.5"
                        >
                          {msg.agentTeam ?? msg.role}
                        </Badge>
                      </div>
                      <p className="text-sm">{msg.content}</p>
                    </div>
                  ))}
                  {pipelineEvents.messages.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      Agent messages will appear here as stages complete.
                    </p>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="raw" className="h-full">
                <ScrollArea className="h-full">
                  <pre className="text-xs font-mono whitespace-pre-wrap p-4 bg-muted rounded-lg">
                    {JSON.stringify(run, null, 2)}
                  </pre>
                </ScrollArea>
              </TabsContent>

              <TabsContent value="delegations" className="h-full overflow-y-auto">
                <DelegationLog
                  runId={runId}
                  isActive={run.status === "running"}
                />
              </TabsContent>

              {isManagerMode && (
                <TabsContent value="manager" className="h-full overflow-y-auto">
                  <div className="space-y-3">
                    <div>
                      <h3 className="text-sm font-medium">Manager Decisions</h3>
                      <p className="text-xs text-muted-foreground mt-1">
                        Real-time feed of manager LLM decisions during this run.
                      </p>
                    </div>
                    <ManagerDecisionFeed
                      runId={runId}
                      isRunActive={run.status === "running"}
                    />
                  </div>
                </TabsContent>
              )}
            </div>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
