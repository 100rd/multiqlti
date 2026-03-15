import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Loader2, GitCompare } from "lucide-react";
import { useLocation } from "wouter";
import { useRunComparison, usePipeline } from "@/hooks/use-pipeline";

interface RunComparisonProps {
  params: { id: string };
}

interface StageExecution {
  id: string;
  runId: string;
  stageIndex: number;
  teamId: string;
  modelSlug: string;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  tokensUsed: number | null;
  startedAt: string | null;
  completedAt: string | null;
}

interface RunWithStages {
  id: string;
  pipelineId: string;
  status: string;
  input: string;
  output: Record<string, unknown> | null;
  currentStageIndex: number;
  startedAt: string | null;
  completedAt: string | null;
  triggeredBy: string | null;
  stages: StageExecution[];
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return "—";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleString();
}

function statusColor(status: string): string {
  switch (status) {
    case "completed": return "bg-emerald-500/20 text-emerald-700";
    case "running": return "bg-blue-500/20 text-blue-700";
    case "failed": return "bg-red-500/20 text-red-700";
    case "pending": return "bg-gray-500/20 text-gray-700";
    default: return "bg-muted text-muted-foreground";
  }
}

function extractOutputText(output: Record<string, unknown> | null): string {
  if (!output) return "(no output)";
  const candidates = ["output", "result", "content", "summary", "response"];
  for (const key of candidates) {
    if (typeof output[key] === "string") return output[key] as string;
  }
  return JSON.stringify(output, null, 2);
}

interface StagePairProps {
  teamId: string;
  stageA: StageExecution | undefined;
  stageB: StageExecution | undefined;
}

function StagePair({ teamId, stageA, stageB }: StagePairProps) {
  const modelDiffers = stageA && stageB && stageA.modelSlug !== stageB.modelSlug;
  const outputA = stageA ? extractOutputText(stageA.output) : "(stage not run)";
  const outputB = stageB ? extractOutputText(stageB.output) : "(stage not run)";

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className={[
        "px-4 py-2 flex items-center justify-between text-xs font-medium",
        modelDiffers ? "bg-amber-500/10 border-b border-amber-500/20" : "bg-muted/50 border-b border-border",
      ].join(" ")}>
        <span className="font-mono text-foreground">{teamId}</span>
        {modelDiffers && (
          <Badge variant="outline" className="text-[9px] h-4 px-1 border-amber-500/50 text-amber-600">
            different models
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-2 divide-x divide-border">
        <div className="p-3 space-y-2">
          {stageA ? (
            <>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="font-mono">{stageA.modelSlug}</span>
                <span>·</span>
                <span>{stageA.tokensUsed ?? 0}tk</span>
                <span>·</span>
                <span>{formatDuration(stageA.startedAt, stageA.completedAt)}</span>
                <Badge className={`text-[9px] h-3.5 px-1 ml-auto ${statusColor(stageA.status)}`}>
                  {stageA.status}
                </Badge>
              </div>
              <pre className="text-[11px] text-foreground whitespace-pre-wrap break-words max-h-48 overflow-y-auto font-mono leading-relaxed">
                {outputA}
              </pre>
            </>
          ) : (
            <span className="text-xs text-muted-foreground italic">Stage not run</span>
          )}
        </div>

        <div className="p-3 space-y-2">
          {stageB ? (
            <>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="font-mono">{stageB.modelSlug}</span>
                <span>·</span>
                <span>{stageB.tokensUsed ?? 0}tk</span>
                <span>·</span>
                <span>{formatDuration(stageB.startedAt, stageB.completedAt)}</span>
                <Badge className={`text-[9px] h-3.5 px-1 ml-auto ${statusColor(stageB.status)}`}>
                  {stageB.status}
                </Badge>
              </div>
              <pre className="text-[11px] text-foreground whitespace-pre-wrap break-words max-h-48 overflow-y-auto font-mono leading-relaxed">
                {outputB}
              </pre>
            </>
          ) : (
            <span className="text-xs text-muted-foreground italic">Stage not run</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function RunComparison({ params }: RunComparisonProps) {
  const { id: pipelineId } = params;
  const [, navigate] = useLocation();

  const searchParams = new URLSearchParams(window.location.search);
  const runsParam = searchParams.get("runs") ?? "";
  const [runId1, runId2] = runsParam.split(",").map((s) => s.trim());

  const { data: pipeline } = usePipeline(pipelineId);
  const { data: comparisonData, isLoading, error } = useRunComparison(runId1, runId2);

  const runs = useMemo(() => {
    if (!comparisonData?.runs) return null;
    return comparisonData.runs as [RunWithStages, RunWithStages];
  }, [comparisonData]);

  const stageTeamIds = useMemo(() => {
    if (!runs) return [];
    const allIds = [
      ...runs[0].stages.map((s) => s.teamId),
      ...runs[1].stages.map((s) => s.teamId),
    ];
    return Array.from(new Set(allIds));
  }, [runs]);

  if (!runId1 || !runId2) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-sm text-muted-foreground">Invalid comparison URL — requires ?runs=id1,id2</p>
        <Button variant="outline" size="sm" onClick={() => navigate(`/pipelines/${pipelineId}`)}>
          <ArrowLeft className="h-3 w-3 mr-2" /> Back to Pipeline
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading comparison...
      </div>
    );
  }

  if (error || !runs) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-sm text-muted-foreground">
          {error instanceof Error ? error.message : "Failed to load comparison"}
        </p>
        <Button variant="outline" size="sm" onClick={() => navigate(`/pipelines/${pipelineId}`)}>
          <ArrowLeft className="h-3 w-3 mr-2" /> Back
        </Button>
      </div>
    );
  }

  const [runA, runB] = runs;

  return (
    <div className="flex flex-col h-full bg-background overflow-y-auto">
      <div className="h-14 border-b border-border flex items-center justify-between px-6 bg-card shrink-0">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => navigate(`/pipelines/${pipelineId}`)}
          >
            <ArrowLeft className="h-3 w-3 mr-1" /> Back
          </Button>
          <div className="w-px h-4 bg-border" />
          <div className="flex items-center gap-2">
            <GitCompare className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              Run Comparison — {pipeline?.name ?? pipelineId}
            </h2>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        <div className="grid grid-cols-2 gap-4">
          <Card className="border-border p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-blue-600">Run A</span>
              <Badge className={`text-[10px] ${statusColor(runA.status)}`}>{runA.status}</Badge>
            </div>
            <div className="text-xs text-muted-foreground font-mono">{runA.id.slice(0, 16)}...</div>
            <div className="text-xs text-foreground line-clamp-2">{runA.input}</div>
            <div className="flex gap-4 text-[10px] text-muted-foreground">
              <span>Started: {formatDate(runA.startedAt)}</span>
              <span>Duration: {formatDuration(runA.startedAt, runA.completedAt)}</span>
            </div>
            <div className="text-[10px] text-muted-foreground">
              {runA.stages.length} stage{runA.stages.length !== 1 ? "s" : ""} · {
                runA.stages.reduce((acc, s) => acc + (s.tokensUsed ?? 0), 0)
              } tokens total
            </div>
          </Card>

          <Card className="border-border p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-violet-600">Run B</span>
              <Badge className={`text-[10px] ${statusColor(runB.status)}`}>{runB.status}</Badge>
            </div>
            <div className="text-xs text-muted-foreground font-mono">{runB.id.slice(0, 16)}...</div>
            <div className="text-xs text-foreground line-clamp-2">{runB.input}</div>
            <div className="flex gap-4 text-[10px] text-muted-foreground">
              <span>Started: {formatDate(runB.startedAt)}</span>
              <span>Duration: {formatDuration(runB.startedAt, runB.completedAt)}</span>
            </div>
            <div className="text-[10px] text-muted-foreground">
              {runB.stages.length} stage{runB.stages.length !== 1 ? "s" : ""} · {
                runB.stages.reduce((acc, s) => acc + (s.tokensUsed ?? 0), 0)
              } tokens total
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-2 gap-4 px-0">
          <div className="text-xs font-semibold text-blue-600 text-center py-1 bg-blue-500/5 rounded border border-blue-500/10">
            Run A — {runA.id.slice(0, 8)}
          </div>
          <div className="text-xs font-semibold text-violet-600 text-center py-1 bg-violet-500/5 rounded border border-violet-500/10">
            Run B — {runB.id.slice(0, 8)}
          </div>
        </div>

        <div className="space-y-4">
          {stageTeamIds.map((teamId) => {
            const stageA = runA.stages.find((s) => s.teamId === teamId);
            const stageB = runB.stages.find((s) => s.teamId === teamId);
            return (
              <StagePair
                key={teamId}
                teamId={teamId}
                stageA={stageA}
                stageB={stageB}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
