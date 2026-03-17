import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Play, Loader2, GitCompare, Network } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useLocation } from "wouter";
import MultiAgentPipeline from "@/components/workflow/MultiAgentPipeline";
import AgentChat from "@/components/workflow/AgentChat";
import CodePreview from "@/components/workflow/CodePreview";
import DAGEditor from "@/components/dag/DAGEditor";
import { usePipeline, useStartRun, useRuns } from "@/hooks/use-pipeline";
import { usePipelineDAG } from "@/hooks/use-dag";
import { RunVariablesDialog } from "@/components/pipeline/RunVariablesDialog";
import { ManagerModeToggle } from "@/components/manager/ManagerModeToggle";
import { ManagerConfigPanel } from "@/components/manager/ManagerConfigPanel";
import { useSetManagerConfig, useDeleteManagerConfig } from "@/hooks/use-pipeline";
import type { ManagerConfig } from "@/hooks/use-pipeline";
import type { DAGStageNode, DAGEdgeData } from "@/components/dag/DAGCanvas";
import type { DAGCondition } from "@/components/dag/ConditionDialog";

interface PipelineDetailProps {
  params: { id: string };
}

/** Normalise the dag field returned by the API into typed arrays. */
function normaliseDag(dag: unknown): { stages: DAGStageNode[]; edges: DAGEdgeData[] } | null {
  if (!dag || typeof dag !== "object") return null;
  const d = dag as Record<string, unknown>;
  if (!Array.isArray(d.stages)) return null;
  return {
    stages: (d.stages as DAGStageNode[]),
    edges: Array.isArray(d.edges) ? (d.edges as DAGEdgeData[]) : [],
  };
}

export default function PipelineDetail({ params }: PipelineDetailProps) {
  const { id } = params;
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState("design");
  const [taskInput, setTaskInput] = useState("");
  const [showVarsDialog, setShowVarsDialog] = useState(false);
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);

  const { data: pipeline, isLoading } = usePipeline(id);
  const [showManagerConfig, setShowManagerConfig] = useState(false);
  const setManagerConfig = useSetManagerConfig();
  const deleteManagerConfig = useDeleteManagerConfig();

  const managerConfig = (pipeline as { managerConfig?: ManagerConfig | null } | undefined)?.managerConfig ?? null;
  const isManagerMode = managerConfig != null;

  const handleManagerToggle = async (enabled: boolean) => {
    if (!pipeline) return;
    if (enabled) {
      setShowManagerConfig(true);
    } else {
      await deleteManagerConfig.mutateAsync(pipeline.id);
      setShowManagerConfig(false);
    }
  };

  const handleManagerSave = async (config: ManagerConfig) => {
    if (!pipeline) return;
    await setManagerConfig.mutateAsync({ pipelineId: pipeline.id, config });
    setShowManagerConfig(false);
  };
  const { data: runs } = useRuns(id);
  const { data: dagData, isLoading: dagLoading } = usePipelineDAG(id);
  const startRun = useStartRun();

  const handleExecute = () => {
    if (!taskInput.trim() || !pipeline) return;
    setShowVarsDialog(true);
  };

  const handleRunConfirm = (variables: Record<string, string>) => {
    if (!pipeline) return;
    startRun.mutate(
      {
        pipelineId: pipeline.id,
        input: taskInput,
        ...(Object.keys(variables).length > 0 ? { variables } : {}),
      },
      {
        onSuccess: (run: { id: string }) => {
          setShowVarsDialog(false);
          navigate(`/runs/${run.id}`);
        },
      },
    );
  };

  const handleCompare = () => {
    if (selectedRunIds.length !== 2) return;
    navigate(`/pipelines/${id}/compare?runs=${selectedRunIds.join(",")}`);
  };

  const toggleRunSelection = (runId: string) => {
    setSelectedRunIds((prev) => {
      if (prev.includes(runId)) return prev.filter((r) => r !== runId);
      if (prev.length >= 2) return prev;
      return [...prev, runId];
    });
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

  const normalisedDag = normaliseDag(dagData);
  const hasDag = normalisedDag !== null;

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
          {hasDag && (
            <Badge variant="secondary" className="text-xs gap-1">
              <Network className="h-3 w-3" /> DAG mode
            </Badge>
          )}
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
          <TabsList className="grid w-full grid-cols-5 px-6 pt-4 bg-background">
            <TabsTrigger value="design" className="text-xs">Pipeline Design</TabsTrigger>
            <TabsTrigger value="dag" className="text-xs gap-1">
              <Network className="h-3 w-3" /> DAG Builder
            </TabsTrigger>
            <TabsTrigger value="chat" className="text-xs">Discussion</TabsTrigger>
            <TabsTrigger value="code" className="text-xs">Generated Code</TabsTrigger>
            <TabsTrigger value="history" className="text-xs">Run History</TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-hidden p-6">
            <TabsContent value="design" className="h-full overflow-y-auto">
              <div className="mb-4 p-4 rounded-lg border bg-card space-y-3">
                <ManagerModeToggle
                  enabled={isManagerMode}
                  onChange={handleManagerToggle}
                  disabled={setManagerConfig.isPending || deleteManagerConfig.isPending}
                />
                {(isManagerMode || showManagerConfig) && (
                  <ManagerConfigPanel
                    initialConfig={managerConfig}
                    onSave={handleManagerSave}
                    onCancel={() => setShowManagerConfig(false)}
                    isSaving={setManagerConfig.isPending}
                  />
                )}
              </div>
              <MultiAgentPipeline pipelineId={id} />
            </TabsContent>

            <TabsContent value="dag" className="h-full overflow-y-auto">
              {dagLoading ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground text-sm gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading DAG...
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <h3 className="text-sm font-medium">Conditional Branching — DAG Builder</h3>
                    <p className="text-xs text-muted-foreground mt-1">
                      Design a directed acyclic graph for conditional stage execution.
                      When a DAG is saved, pipeline runs will use it instead of the linear stage order.
                      Click the blue + button on a stage to draw an edge; click any edge to add a condition.
                    </p>
                  </div>
                  <DAGEditor
                    pipelineId={id}
                    initialStages={normalisedDag?.stages ?? []}
                    initialEdges={normalisedDag?.edges ?? []}
                  />
                </div>
              )}
            </TabsContent>

            <TabsContent value="chat" className="h-full">
              <AgentChat pipelineId={id} />
            </TabsContent>

            <TabsContent value="code" className="h-full">
              <CodePreview pipelineId={id} />
            </TabsContent>

            <TabsContent value="history" className="h-full overflow-y-auto">
              {Array.isArray(runs) && runs.length >= 2 && (
                <div className="flex items-center gap-3 mb-4 p-3 bg-card border border-border rounded-lg">
                  <span className="text-xs text-muted-foreground">
                    {selectedRunIds.length === 0
                      ? "Select 2 runs to compare"
                      : selectedRunIds.length === 1
                      ? "Select 1 more run"
                      : "2 runs selected"}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    {selectedRunIds.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setSelectedRunIds([])}
                      >
                        Clear
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={selectedRunIds.length !== 2}
                      onClick={handleCompare}
                    >
                      <GitCompare className="h-3 w-3 mr-1" /> Compare Selected
                    </Button>
                  </div>
                </div>
              )}
              <div className="space-y-4">
                {Array.isArray(runs) && runs.length > 0
                  ? runs.map((run: { id: string; input: string; currentStageIndex: number; status: string; dagMode?: boolean }) => (
                    <Card
                      key={run.id}
                      className="border-border p-4 flex items-center gap-3 hover:bg-accent/50 transition-colors"
                    >
                      <Checkbox
                        checked={selectedRunIds.includes(run.id)}
                        onCheckedChange={() => toggleRunSelection(run.id)}
                        disabled={!selectedRunIds.includes(run.id) && selectedRunIds.length >= 2}
                        className="shrink-0"
                      />
                      <div
                        className="flex-1 flex items-center justify-between cursor-pointer"
                        onClick={() => navigate(`/runs/${run.id}`)}
                      >
                        <div className="flex-1">
                          <h4 className="font-medium text-sm truncate max-w-[400px]">{run.input}</h4>
                          <p className="text-xs text-muted-foreground mt-1">
                            Run {run.id.slice(0, 8)}
                            {run.dagMode
                              ? " · DAG mode"
                              : ` · Stage ${run.currentStageIndex + 1}/7`}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          {run.dagMode && (
                            <Badge variant="outline" className="text-xs gap-1">
                              <Network className="h-3 w-3" /> DAG
                            </Badge>
                          )}
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

      <RunVariablesDialog
        open={showVarsDialog}
        onOpenChange={setShowVarsDialog}
        onConfirm={handleRunConfirm}
        isLoading={startRun.isPending}
      />
    </div>
  );
}
