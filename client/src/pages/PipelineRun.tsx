import { useParams } from "wouter";
import { usePipelineRun, useCancelRun } from "@/hooks/use-pipeline";
import { usePipelineEvents } from "@/hooks/use-websocket";
import StageProgress from "@/components/pipeline/StageProgress";
import QuestionPanel from "@/components/pipeline/QuestionPanel";
import StageOutput from "@/components/pipeline/StageOutput";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { StopCircle, ArrowLeft, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { SDLC_TEAMS } from "@shared/constants";
import type { PipelineStageConfig } from "@shared/types";
import { cn } from "@/lib/utils";

const statusColors: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-blue-500/20 text-blue-700",
  paused: "bg-amber-500/20 text-amber-700",
  completed: "bg-emerald-500/20 text-emerald-700",
  failed: "bg-red-500/20 text-red-700",
  cancelled: "bg-muted text-muted-foreground",
};

export default function PipelineRun() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId ?? "";
  const { data: run, isLoading } = usePipelineRun(runId);
  const cancelMutation = useCancelRun();
  const pipelineEvents = usePipelineEvents(runId);

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
              <Badge className={cn("text-[10px] h-4 px-1.5", statusColors[status])}>
                {status}
              </Badge>
              <span className="text-[10px] text-muted-foreground">
                Run {runId.slice(0, 8)}
              </span>
            </div>
          </div>
        </div>
        {(status === "running" || status === "paused") && (
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
            <TabsList className="mx-6 mt-4 grid w-auto grid-cols-3 max-w-md">
              <TabsTrigger value="output" className="text-xs">
                Output
              </TabsTrigger>
              <TabsTrigger value="chat" className="text-xs">
                Chat
              </TabsTrigger>
              <TabsTrigger value="raw" className="text-xs">
                Raw Data
              </TabsTrigger>
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
                  {completedStages.map((stage) => {
                    const team =
                      SDLC_TEAMS[
                        stage.teamId as keyof typeof SDLC_TEAMS
                      ];
                    return (
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
            </div>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
