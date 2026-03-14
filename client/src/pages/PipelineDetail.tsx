import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Play, Loader2 } from "lucide-react";
import { useLocation } from "wouter";
import MultiAgentPipeline from "@/components/workflow/MultiAgentPipeline";
import AgentChat from "@/components/workflow/AgentChat";
import CodePreview from "@/components/workflow/CodePreview";
import { usePipeline, useStartRun, useRuns } from "@/hooks/use-pipeline";

interface PipelineDetailProps {
  params: { id: string };
}

export default function PipelineDetail({ params }: PipelineDetailProps) {
  const { id } = params;
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState("design");
  const [taskInput, setTaskInput] = useState("");

  const { data: pipeline, isLoading } = usePipeline(id);
  const { data: runs } = useRuns(id);
  const startRun = useStartRun();

  const handleExecute = () => {
    if (!taskInput.trim() || !pipeline) return;
    startRun.mutate(
      { pipelineId: pipeline.id, input: taskInput },
      {
        onSuccess: (run: { id: string }) => {
          navigate(`/runs/${run.id}`);
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading pipeline...
      </div>
    );
  }

  if (!pipeline) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-sm text-muted-foreground">Pipeline not found.</p>
        <Button variant="outline" size="sm" onClick={() => navigate("/pipelines")}>
          <ArrowLeft className="h-3 w-3 mr-2" /> Back to Pipelines
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="h-16 border-b border-border flex items-center justify-between px-6 bg-card shrink-0">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => navigate("/pipelines")}
          >
            <ArrowLeft className="h-3 w-3 mr-1" /> Pipelines
          </Button>
          <div className="w-px h-4 bg-border" />
          <div>
            <h2 className="text-sm font-semibold">{pipeline.name}</h2>
            {pipeline.description && (
              <p className="text-xs text-muted-foreground">{pipeline.description}</p>
            )}
          </div>
        </div>
      </div>

      {/* Quick execute bar */}
      <div className="px-6 py-4 border-b border-border bg-card/50">
        <div className="flex gap-3 items-center max-w-3xl">
          <Input
            className="flex-1 h-10 text-sm"
            placeholder="Describe your task: e.g., 'Build a REST API for user management with JWT auth'"
            value={taskInput}
            onChange={(e) => setTaskInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleExecute()}
          />
          <Button
            className="h-10 px-6"
            onClick={handleExecute}
            disabled={!taskInput.trim() || startRun.isPending}
          >
            {startRun.isPending
              ? <Loader2 className="h-4 w-4 animate-spin mr-2" />
              : <Play className="h-4 w-4 mr-2" />}
            Execute Pipeline
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full h-full flex flex-col">
          <TabsList className="grid w-full grid-cols-4 px-6 pt-4 bg-background">
            <TabsTrigger value="design" className="text-xs">Pipeline Design</TabsTrigger>
            <TabsTrigger value="chat" className="text-xs">Discussion</TabsTrigger>
            <TabsTrigger value="code" className="text-xs">Generated Code</TabsTrigger>
            <TabsTrigger value="history" className="text-xs">Run History</TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-hidden p-6">
            <TabsContent value="design" className="h-full overflow-y-auto">
              <MultiAgentPipeline pipelineId={id} />
            </TabsContent>

            <TabsContent value="chat" className="h-full">
              <AgentChat pipelineId={id} />
            </TabsContent>

            <TabsContent value="code" className="h-full">
              <CodePreview pipelineId={id} />
            </TabsContent>

            <TabsContent value="history" className="h-full overflow-y-auto">
              <div className="space-y-4">
                {Array.isArray(runs) && runs.length > 0
                  ? runs.map((run: { id: string; input: string; currentStageIndex: number; status: string }) => (
                    <Card
                      key={run.id}
                      className="border-border p-4 flex items-center justify-between hover:bg-accent/50 transition-colors cursor-pointer"
                      onClick={() => navigate(`/runs/${run.id}`)}
                    >
                      <div className="flex-1">
                        <h4 className="font-medium text-sm truncate max-w-[400px]">{run.input}</h4>
                        <p className="text-xs text-muted-foreground mt-1">
                          Run {run.id.slice(0, 8)} · Stage {run.currentStageIndex + 1}/7
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <Badge className={`text-xs ${
                          run.status === "completed" ? "bg-emerald-500/20 text-emerald-700" :
                          run.status === "running" ? "bg-blue-500/20 text-blue-700" :
                          run.status === "paused" ? "bg-amber-500/20 text-amber-700" :
                          run.status === "failed" ? "bg-red-500/20 text-red-700" :
                          "bg-muted text-muted-foreground"
                        }`}>
                          {run.status}
                        </Badge>
                        <Button variant="outline" size="sm" className="h-7 text-xs">View</Button>
                      </div>
                    </Card>
                  ))
                  : (
                    <div className="text-sm text-muted-foreground text-center py-12">
                      No runs for this pipeline yet. Execute a task above to get started.
                    </div>
                  )}
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
}
