import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Play, Save, RotateCcw } from "lucide-react";
import AgentNode from "./AgentNode";
import { usePipelines, useUpdatePipeline, useModels } from "@/hooks/use-pipeline";
import { SDLC_TEAMS, TEAM_ORDER } from "@shared/constants";
import type { PipelineStageConfig } from "@shared/types";
import { useState, useEffect } from "react";

export default function MultiAgentPipeline() {
  const { data: pipelines } = usePipelines();
  const { data: models } = useModels();
  const updatePipeline = useUpdatePipeline();

  const pipeline = Array.isArray(pipelines) ? pipelines[0] : null;
  const pipelineStages: PipelineStageConfig[] = pipeline?.stages ?? [];

  const [localStages, setLocalStages] = useState<PipelineStageConfig[]>(pipelineStages);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (pipelineStages.length > 0) {
      setLocalStages(pipelineStages);
      setDirty(false);
    }
  }, [pipeline?.id, JSON.stringify(pipelineStages)]);

  const updateStageModel = (teamId: string, modelSlug: string) => {
    setLocalStages(prev => prev.map(s => s.teamId === teamId ? { ...s, modelSlug } : s));
    setDirty(true);
  };

  const toggleStage = (teamId: string) => {
    setLocalStages(prev => prev.map(s => s.teamId === teamId ? { ...s, enabled: !s.enabled } : s));
    setDirty(true);
  };

  const handleSave = () => {
    if (!pipeline) return;
    updatePipeline.mutate(
      { id: pipeline.id, stages: localStages },
      { onSuccess: () => setDirty(false) },
    );
  };

  const handleReset = () => {
    setLocalStages(pipelineStages);
    setDirty(false);
  };

  const modelList = Array.isArray(models)
    ? models.filter((m: any) => m.isActive).map((m: any) => ({
        label: m.name,
        value: m.slug,
        provider: m.provider,
      }))
    : [];

  return (
    <div className="space-y-6">
      {/* Pipeline Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">SDLC Pipeline</h3>
          <p className="text-sm text-muted-foreground mt-1">
            7-stage software development lifecycle — configure models per team
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <Button variant="ghost" size="sm" className="text-xs h-8" onClick={handleReset}>
              <RotateCcw className="h-3 w-3 mr-1" /> Reset
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="text-xs h-8"
            onClick={handleSave}
            disabled={!dirty || updatePipeline.isPending}
          >
            <Save className="h-3 w-3 mr-1" /> Save
          </Button>
        </div>
      </div>

      {/* Stage Pipeline */}
      <div className="relative">
        <div className="space-y-6">
          {localStages.map((stage, idx) => {
            const team = SDLC_TEAMS[stage.teamId as keyof typeof SDLC_TEAMS];
            if (!team) return null;
            return (
              <AgentNode
                key={stage.teamId}
                id={stage.teamId}
                role={stage.teamId}
                model={stage.modelSlug}
                description={team.description}
                enabled={stage.enabled}
                color={team.color}
                models={modelList}
                onModelChange={(_, model) => updateStageModel(stage.teamId, model)}
                onToggle={() => toggleStage(stage.teamId)}
                isLast={idx === localStages.length - 1}
              />
            );
          })}
        </div>
      </div>

      {/* Pipeline Configuration */}
      <Card className="border-border bg-muted/30 p-4">
        <div className="space-y-3">
          <div className="text-sm font-medium">Pipeline Behavior</div>
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div className="p-2 rounded border border-border bg-card">
              <div className="font-medium mb-1">Sequential Execution</div>
              <div className="text-muted-foreground">Each team processes the output of the previous one</div>
            </div>
            <div className="p-2 rounded border border-border bg-card">
              <div className="font-medium mb-1">Clarification Queue</div>
              <div className="text-muted-foreground">Agents can pause to ask questions — you answer in the side panel</div>
            </div>
            <div className="p-2 rounded border border-border bg-card">
              <div className="font-medium mb-1">Context Passing</div>
              <div className="text-muted-foreground">Full task context and prior outputs passed to each team</div>
            </div>
            <div className="p-2 rounded border border-border bg-card">
              <div className="font-medium mb-1">Model Flexibility</div>
              <div className="text-muted-foreground">Assign any registered model to any team stage</div>
            </div>
          </div>
        </div>
      </Card>

      {/* SDLC Flow Description */}
      <Card className="border-border bg-card p-4 space-y-3">
        <div className="text-sm font-medium">SDLC Pipeline Flow</div>
        <div className="space-y-2 text-xs text-muted-foreground">
          {TEAM_ORDER.map((teamId) => {
            const team = SDLC_TEAMS[teamId];
            const stage = localStages.find(s => s.teamId === teamId);
            const model = modelList.find(m => m.value === stage?.modelSlug);
            return (
              <div key={teamId} className="flex gap-2">
                <span className="font-mono text-blue-500">→</span>
                <span>
                  <span className="font-medium text-foreground">{team.name}</span>
                  {model && <span className="ml-1">({model.label})</span>}
                  {' — '}{team.description}
                </span>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
