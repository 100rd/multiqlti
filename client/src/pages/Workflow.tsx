import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Settings, Play, Loader2 } from "lucide-react";
import { useLocation } from "wouter";
import MultiAgentPipeline from "@/components/workflow/MultiAgentPipeline";
import AgentChat from "@/components/workflow/AgentChat";
import CodePreview from "@/components/workflow/CodePreview";
import { usePipelines, useStartRun, useRuns, useCreatePipeline } from "@/hooks/use-pipeline";
import { DEFAULT_PIPELINE_STAGES } from "@shared/constants";
import { Badge } from "@/components/ui/badge";

export default function Workflow() {
  const [activeTab, setActiveTab] = useState("design");
  const [taskInput, setTaskInput] = useState("");
  const [, navigate] = useLocation();
  const { data: pipelines } = usePipelines();
  const { data: runs } = useRuns();
  const startRun = useStartRun();
  const createPipeline = useCreatePipeline();

  const defaultPipeline = Array.isArray(pipelines) ? pipelines[0] : null;

  const handleExecute = () => {
    if (!taskInput.trim() || !defaultPipeline) return;
    startRun.mutate(
      { pipelineId: defaultPipeline.id, input: taskInput },
      {
        onSuccess: (run: any) => {
          navigate(`/runs/${run.id}`);
        },
      },
    );
  };

  const handleNewPipeline = () => {
    createPipeline.mutate({
      name: "New Pipeline",
      description: "Custom SDLC pipeline",
      stages: DEFAULT_PIPELINE_STAGES,
    });
  };

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="h-16 border-b border-border flex items-center justify-between px-6 bg-card shrink-0">
        <div>
          <h2 className="text-sm font-semibold">Workflow Manager</h2>
          <p className="text-xs text-muted-foreground">Build multi-agent SDLC pipelines for complex tasks</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 text-xs">
            <Settings className="h-3 w-3 mr-2" /> Settings
          </Button>
          <Button size="sm" className="h-8 text-xs" onClick={handleNewPipeline}>
            <Plus className="h-3 w-3 mr-2" /> New Pipeline
          </Button>
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
            disabled={!taskInput.trim() || !defaultPipeline || startRun.isPending}
          >
            {startRun.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
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
              <MultiAgentPipeline />
            </TabsContent>

            <TabsContent value="chat" className="h-full">
              <AgentChat />
            </TabsContent>

            <TabsContent value="code" className="h-full">
              <CodePreview />
            </TabsContent>

            <TabsContent value="history" className="h-full overflow-y-auto">
              <div className="space-y-4">
                {Array.isArray(runs) && runs.length > 0 ? runs.map((run: any) => (
                  <Card key={run.id} className="border-border p-4 flex items-center justify-between hover:bg-accent/50 transition-colors cursor-pointer" onClick={() => navigate(`/runs/${run.id}`)}>
                    <div className="flex-1">
                      <h4 className="font-medium text-sm truncate max-w-[400px]">{run.input}</h4>
                      <p className="text-xs text-muted-foreground mt-1">
                        Run {run.id.slice(0, 8)} • Stage {run.currentStageIndex + 1}/7
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge className={`text-xs ${
                        run.status === 'completed' ? 'bg-emerald-500/20 text-emerald-700' :
                        run.status === 'running' ? 'bg-blue-500/20 text-blue-700' :
                        run.status === 'paused' ? 'bg-amber-500/20 text-amber-700' :
                        run.status === 'failed' ? 'bg-red-500/20 text-red-700' :
                        'bg-muted text-muted-foreground'
                      }`}>
                        {run.status}
                      </Badge>
                      <Button variant="outline" size="sm" className="h-7 text-xs">View</Button>
                    </div>
                  </Card>
                )) : (
                  <div className="text-sm text-muted-foreground text-center py-12">
                    No pipeline runs yet. Execute a task above to get started.
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
