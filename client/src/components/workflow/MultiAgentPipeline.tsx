import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Save, RotateCcw, Zap, Network } from "lucide-react";
import AgentNode from "./AgentNode";
import { usePipelines, useUpdatePipeline, useModels } from "@/hooks/use-pipeline";
import { SDLC_TEAMS, TEAM_ORDER, STRATEGY_PRESETS, EXECUTION_STRATEGY_PRESETS } from "@shared/constants";
import type { PipelineStageConfig, ExecutionStrategy, MoaStrategy, DebateStrategy, VotingStrategy, PrivacySettings } from "@shared/types";

interface MultiAgentPipelineProps {
  pipelineId?: string;
}

export default function MultiAgentPipeline({ pipelineId }: MultiAgentPipelineProps) {
  const { data: pipelines } = usePipelines();
  const { data: models } = useModels();
  const updatePipeline = useUpdatePipeline();

  const pipeline = pipelineId
    ? (Array.isArray(pipelines) ? pipelines.find((p: { id: string }) => p.id === pipelineId) : null)
    : (Array.isArray(pipelines) ? pipelines[0] : null);

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

  const updateSystemPrompt = (teamId: string, prompt: string) => {
    setLocalStages(prev => prev.map(s =>
      s.teamId === teamId
        ? { ...s, systemPromptOverride: prompt || undefined }
        : s,
    ));
    setDirty(true);
  };

  const updateTemperature = (teamId: string, temperature: number) => {
    setLocalStages(prev => prev.map(s => s.teamId === teamId ? { ...s, temperature } : s));
    setDirty(true);
  };

  const updateMaxTokens = (teamId: string, maxTokens: number) => {
    setLocalStages(prev => prev.map(s => s.teamId === teamId ? { ...s, maxTokens } : s));
    setDirty(true);
  };

  const updateStrategy = (teamId: string, strategy: ExecutionStrategy) => {
    setLocalStages(prev => prev.map(s => {
      if (s.teamId !== teamId) return s;
      if (strategy.type === "single") {
        const { executionStrategy: _removed, ...rest } = s as PipelineStageConfig & { executionStrategy?: ExecutionStrategy };
        return rest as PipelineStageConfig;
      }
      return { ...s, executionStrategy: strategy };
    }));
    setDirty(true);
  };

  const updatePrivacy = (teamId: string, settings: PrivacySettings) => {
    setLocalStages(prev => prev.map(s =>
      s.teamId === teamId ? { ...s, privacySettings: settings } : s,
    ));
    setDirty(true);
  };

  const applyPreset = (presetId: string) => {
    const preset = STRATEGY_PRESETS.find(p => p.id === presetId);
    if (!preset) return;
    setLocalStages(prev => prev.map(s => {
      const override = preset.stageOverrides?.[s.teamId as keyof typeof preset.stageOverrides];
      return {
        ...s,
        modelSlug: override?.modelSlug ?? s.modelSlug,
        temperature: override?.temperature ?? preset.temperature,
        maxTokens: preset.maxTokens,
      };
    }));
    setDirty(true);
  };

  const applyExecutionPreset = (presetId: string) => {
    const preset = EXECUTION_STRATEGY_PRESETS.find(p => p.id === presetId);
    if (!preset) return;
    setLocalStages(prev => prev.map(s => {
      const stageStrategy = preset.stageStrategies[s.teamId as keyof typeof preset.stageStrategies];
      if (!stageStrategy) {
        const { executionStrategy: _removed, ...rest } = s as PipelineStageConfig & { executionStrategy?: ExecutionStrategy };
        return rest as PipelineStageConfig;
      }
      return { ...s, executionStrategy: stageStrategy };
    }));
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
    ? models.filter((m: { isActive: boolean }) => m.isActive).map((m: { name: string; slug: string; provider: string }) => ({
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
            {pipeline?.name ?? "No pipeline selected"} — configure models and prompts per stage
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

      {/* Model Presets */}
      <Card className="border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-medium">Model Presets</span>
        </div>

        <div className="flex flex-wrap gap-2">
          {STRATEGY_PRESETS.map(preset => (
            <Button
              key={preset.id}
              variant="outline"
              size="sm"
              className="text-xs h-7"
              onClick={() => applyPreset(preset.id)}
            >
              {preset.label}
            </Button>
          ))}
        </div>

        {/* Stage Model Matrix */}
        <div className="mt-3">
          <div className="text-xs text-muted-foreground mb-2 font-medium">Stage Model Matrix</div>
          <div className="space-y-1.5">
            {localStages.map(stage => {
              const team = SDLC_TEAMS[stage.teamId as keyof typeof SDLC_TEAMS];
              if (!team) return null;
              const strat = stage.executionStrategy;
              return (
                <div key={stage.teamId} className="grid grid-cols-[140px_1fr_60px_60px_56px] gap-2 items-center">
                  <span className="text-xs font-medium truncate">{team.name}</span>
                  <Select
                    value={stage.modelSlug}
                    onValueChange={(val) => updateStageModel(stage.teamId, val)}
                    disabled={!stage.enabled}
                  >
                    <SelectTrigger className="h-6 text-[11px] bg-background border-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {modelList.map(m => (
                        <SelectItem key={m.value} value={m.value} className="text-xs">
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-[10px] text-muted-foreground text-right font-mono">
                    t={((stage.temperature ?? 0.7)).toFixed(1)}
                  </span>
                  <span className="text-[10px] text-muted-foreground text-right font-mono">
                    {stage.maxTokens ?? 2048}tk
                  </span>
                  {strat && strat.type !== "single" ? (
                    <Badge variant="secondary" className="text-[9px] h-4 px-1 justify-center">
                      {strategyBadge(strat)}
                    </Badge>
                  ) : (
                    <span />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      {/* Execution Strategy Presets */}
      <Card className="border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-violet-500" />
          <span className="text-sm font-medium">Execution Strategy Presets</span>
          <span className="text-xs text-muted-foreground">(multi-model orchestration)</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {EXECUTION_STRATEGY_PRESETS.map(preset => (
            <Button
              key={preset.id}
              variant="outline"
              size="sm"
              className="text-xs h-7"
              onClick={() => applyExecutionPreset(preset.id)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Quality Max uses MoA, Debate, and Voting for maximum output quality.
          Apply a preset, then save to persist.
        </p>
      </Card>

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
                systemPromptOverride={stage.systemPromptOverride}
                temperature={stage.temperature}
                maxTokens={stage.maxTokens}
                executionStrategy={stage.executionStrategy}
                privacySettings={stage.privacySettings}
                onModelChange={(_, model) => updateStageModel(stage.teamId, model)}
                onToggle={() => toggleStage(stage.teamId)}
                onSystemPromptChange={(_, prompt) => updateSystemPrompt(stage.teamId, prompt)}
                onTemperatureChange={(_, temp) => updateTemperature(stage.teamId, temp)}
                onMaxTokensChange={(_, tokens) => updateMaxTokens(stage.teamId, tokens)}
                onStrategyChange={(_, strategy) => updateStrategy(stage.teamId, strategy)}
                onPrivacyChange={(_, settings) => updatePrivacy(stage.teamId, settings)}
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
              <div className="font-medium mb-1">Multi-Model Strategies</div>
              <div className="text-muted-foreground">Each stage can use MoA, Debate, or Voting for higher quality</div>
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
            const strat = stage?.executionStrategy;
            return (
              <div key={teamId} className="flex gap-2">
                <span className="font-mono text-blue-500">→</span>
                <span>
                  <span className="font-medium text-foreground">{team.name}</span>
                  {model && <span className="ml-1">({model.label})</span>}
                  {stage?.systemPromptOverride && (
                    <Badge variant="outline" className="ml-2 text-[9px] h-4 px-1">custom prompt</Badge>
                  )}
                  {strat && strat.type !== "single" && (
                    <Badge variant="secondary" className="ml-2 text-[9px] h-4 px-1">
                      {strategyBadge(strat)}
                    </Badge>
                  )}
                  {stage?.privacySettings?.enabled && (
                    <Badge variant="outline" className="ml-2 text-[9px] h-4 px-1 border-emerald-500/50 text-emerald-600">
                      privacy:{stage.privacySettings.level}
                    </Badge>
                  )}
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

function strategyBadge(strategy: ExecutionStrategy): string {
  switch (strategy.type) {
    case "moa": return `MoA×${(strategy as MoaStrategy).proposers.length}`;
    case "debate": return `Debate ${(strategy as DebateStrategy).rounds}r`;
    case "voting": return `Vote×${(strategy as VotingStrategy).candidates.length}`;
    default: return "Single";
  }
}
