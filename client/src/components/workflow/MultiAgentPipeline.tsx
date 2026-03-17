import { useState, useEffect, lazy, Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Save, RotateCcw, Zap, Network, GripVertical, Plus, Trash2, Bookmark, BookmarkPlus, GitBranch, List } from "lucide-react";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import AgentNode from "./AgentNode";
import {
  usePipelines, useUpdatePipeline, useModels,
  useSpecializationProfiles, useCreateSpecializationProfile, useDeleteSpecializationProfile,
} from "@/hooks/use-pipeline";
import { usePipelineDAG } from "@/hooks/use-dag";
import { SDLC_TEAMS, STRATEGY_PRESETS, EXECUTION_STRATEGY_PRESETS } from "@shared/constants";
import type {
  PipelineStageConfig, ExecutionStrategy, MoaStrategy, DebateStrategy, VotingStrategy,
  PrivacySettings, SandboxConfig, StageToolConfig, ParallelConfig, CustomStageConfig,
  SpecializationProfile, PipelineDAG, DAGStage, SwarmConfig,
} from "@shared/types";

// Lazy-load DAGCanvas to avoid adding ~200KB reactflow to the main bundle
const DAGCanvas = lazy(() =>
  import("@/components/pipeline/dag/DAGCanvas").then((m) => ({ default: m.DAGCanvas })),
);

interface MultiAgentPipelineProps {
  pipelineId?: string;
}

// ─── SortableStage wrapper ────────────────────────────────────────────────────

interface SortableStageProps {
  id: string;
  children: (dragHandleProps: React.HTMLAttributes<HTMLElement>) => React.ReactNode;
}

function SortableStage({ id, children }: SortableStageProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div ref={setNodeRef} style={style}>
      {children({ ...attributes, ...listeners, className: "cursor-grab active:cursor-grabbing" })}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isCustomStage(teamId: string): boolean {
  return !(teamId in SDLC_TEAMS);
}

function getStageDisplay(teamId: string, customMeta?: CustomStageConfig): { name: string; description: string; color: string; icon: string } {
  if (!isCustomStage(teamId)) {
    const team = SDLC_TEAMS[teamId as keyof typeof SDLC_TEAMS];
    return { name: team.name, description: team.description, color: team.color, icon: team.icon };
  }
  return {
    name: customMeta?.name ?? teamId,
    description: customMeta?.description ?? "Custom stage",
    color: "violet",
    icon: customMeta?.icon ?? "⚙️",
  };
}

// Convert linear stages to a starter DAG with sequential edges
function linearStagesToDAG(stages: PipelineStageConfig[]): PipelineDAG {
  const WAVE_WIDTH = 220;
  const dagStages: DAGStage[] = stages.map((s, i) => ({
    id: s.teamId,
    teamId: s.teamId,
    modelSlug: s.modelSlug,
    systemPromptOverride: s.systemPromptOverride,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    enabled: s.enabled,
    approvalRequired: s.approvalRequired,
    executionStrategy: s.executionStrategy,
    privacySettings: s.privacySettings,
    sandbox: s.sandbox,
    tools: s.tools,
    parallel: s.parallel,
    guardrails: (s as PipelineStageConfig & { guardrails?: DAGStage["guardrails"] }).guardrails,
    autoModelRouting: (s as PipelineStageConfig & { autoModelRouting?: DAGStage["autoModelRouting"] }).autoModelRouting,
    skillId: (s as PipelineStageConfig & { skillId?: string }).skillId,
    position: { x: i * WAVE_WIDTH, y: 0 },
    label: undefined,
  }));

  const dagEdges = stages.slice(0, -1).map((s, i) => ({
    id: `edge-${s.teamId}-${stages[i + 1].teamId}`,
    from: s.teamId,
    to: stages[i + 1].teamId,
  }));

  return { stages: dagStages, edges: dagEdges };
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function MultiAgentPipeline({ pipelineId }: MultiAgentPipelineProps) {
  const { data: pipelines } = usePipelines();
  const { data: models } = useModels();
  const updatePipeline = useUpdatePipeline();
  const { data: specializationProfilesRaw } = useSpecializationProfiles();
  const createProfile = useCreateSpecializationProfile();
  const deleteProfile = useDeleteSpecializationProfile();

  const pipeline = pipelineId
    ? (Array.isArray(pipelines) ? pipelines.find((p: { id: string }) => p.id === pipelineId) : null)
    : null;

  const pipelineStages: PipelineStageConfig[] = pipeline?.stages ?? [];

  // ─── Mode toggle state ──────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<"list" | "dag">("list");

  // ─── DAG data ───────────────────────────────────────────────────────────────
  const { data: remoteDAG } = usePipelineDAG(pipelineId ?? "");
  const pipelineDAG = (remoteDAG ?? (pipeline as { dag?: PipelineDAG | null } | null)?.dag ?? null) as PipelineDAG | null;
  const [convertedDAG, setConvertedDAG] = useState<PipelineDAG | null>(null);
  const activeDAG = pipelineDAG ?? convertedDAG;

  const handleConvertToDAG = () => {
    if (pipelineStages.length === 0) return;
    setConvertedDAG(linearStagesToDAG(pipelineStages));
  };

  // ─── List-mode state ────────────────────────────────────────────────────────
  const [localStages, setLocalStages] = useState<PipelineStageConfig[]>(pipelineStages);
  const [dirty, setDirty] = useState(false);
  const [factCheckEnabled, setFactCheckEnabled] = useState(false);

  // Dialog state
  const [showSavePresetDialog, setShowSavePresetDialog] = useState(false);
  const [savePresetName, setSavePresetName] = useState("");
  const [showAddCustomDialog, setShowAddCustomDialog] = useState(false);
  const [customStageDraft, setCustomStageDraft] = useState<Partial<CustomStageConfig>>({});

  useEffect(() => {
    if (pipelineStages.length > 0) {
      setLocalStages(pipelineStages);
      setDirty(false);
    }
  }, [pipeline?.id, JSON.stringify(pipelineStages)]);

  const specializationProfiles: SpecializationProfile[] = Array.isArray(specializationProfilesRaw)
    ? (specializationProfilesRaw as SpecializationProfile[])
    : [];

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // ─── Stage update helpers ───────────────────────────────────────────────────

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

  const updateSandbox = (teamId: string, config: SandboxConfig | undefined) => {
    setLocalStages(prev => prev.map(s =>
      s.teamId === teamId ? { ...s, sandbox: config } : s,
    ));
    setDirty(true);
  };

  const updateParallelConfig = (teamId: string, config: ParallelConfig | undefined) => {
    setLocalStages(prev => prev.map(s =>
      s.teamId === teamId ? { ...s, parallel: config } : s,
    ));
    setDirty(true);
  };

  const updateSwarmConfig = (teamId: string, config: SwarmConfig | undefined) => {
    setLocalStages(prev => prev.map(s =>
      s.teamId === teamId ? { ...s, swarm: config } : s,
    ));
    setDirty(true);
  };

  const updateToolConfig = (teamId: string, config: StageToolConfig) => {
    setLocalStages(prev => prev.map(s =>
      s.teamId === teamId ? { ...s, tools: config } : s,
    ));
    setDirty(true);
  };

  const updateApprovalRequired = (teamId: string, value: boolean) => {
    setLocalStages(prev => prev.map(s =>
      s.teamId === teamId ? { ...s, approvalRequired: value } : s,
    ));
    setDirty(true);
  };

  // ─── Preset handlers ────────────────────────────────────────────────────────

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

  const applySpecializationProfile = (profileId: string) => {
    const profile = specializationProfiles.find(p => p.id === profileId);
    if (!profile || Object.keys(profile.assignments).length === 0) return;
    setLocalStages(prev => prev.map(s => {
      const modelSlug = profile.assignments[s.teamId];
      return modelSlug ? { ...s, modelSlug } : s;
    }));
    setDirty(true);
  };

  const handleSaveAsPreset = () => {
    if (!savePresetName.trim()) return;
    const assignments: Record<string, string> = {};
    localStages.forEach(s => { assignments[s.teamId] = s.modelSlug; });
    createProfile.mutate(
      { name: savePresetName.trim(), assignments },
      {
        onSuccess: () => {
          setShowSavePresetDialog(false);
          setSavePresetName("");
        },
      },
    );
  };

  // ─── Drag-to-reorder ────────────────────────────────────────────────────────

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setLocalStages(prev => {
      const oldIndex = prev.findIndex(s => s.teamId === String(active.id));
      const newIndex = prev.findIndex(s => s.teamId === String(over.id));
      if (oldIndex < 0 || newIndex < 0) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
    setDirty(true);
  };

  // ─── Custom stage handlers ───────────────────────────────────────────────────

  const handleAddCustomStage = () => {
    const id = `custom_${Date.now()}`;
    const meta: CustomStageConfig = {
      id,
      name: customStageDraft.name ?? "Custom Stage",
      description: customStageDraft.description ?? "",
      systemPrompt: customStageDraft.systemPrompt ?? "You are a helpful AI assistant.",
      icon: customStageDraft.icon ?? "⚙️",
    };
    const defaultSlug = (modelList[0]?.value as string) ?? "mock";
    const newStage: PipelineStageConfig & { _customMeta: CustomStageConfig } = {
      teamId: id,
      modelSlug: defaultSlug,
      enabled: true,
      systemPromptOverride: meta.systemPrompt,
      _customMeta: meta,
    };
    setLocalStages(prev => [...prev, newStage as unknown as PipelineStageConfig]);
    setDirty(true);
    setShowAddCustomDialog(false);
    setCustomStageDraft({});
  };

  const removeStage = (teamId: string) => {
    setLocalStages(prev => prev.filter(s => s.teamId !== teamId));
    setDirty(true);
  };

  // ─── Save / Reset ────────────────────────────────────────────────────────────

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
      {/* Pipeline Header + Mode Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">SDLC Pipeline</h3>
          <p className="text-sm text-muted-foreground mt-1">
            {pipeline?.name ?? "No pipeline selected"} — configure models and prompts per stage
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Segmented control: List | DAG */}
          <div
            className="inline-flex rounded-md border border-border bg-muted p-0.5 text-xs"
            role="group"
            aria-label="Pipeline view mode"
          >
            <button
              type="button"
              className={[
                "inline-flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors font-medium",
                viewMode === "list"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              ].join(" ")}
              onClick={() => setViewMode("list")}
              aria-pressed={viewMode === "list"}
            >
              <List className="h-3 w-3" />
              List
            </button>
            <button
              type="button"
              className={[
                "inline-flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors font-medium",
                viewMode === "dag"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              ].join(" ")}
              onClick={() => setViewMode("dag")}
              aria-pressed={viewMode === "dag"}
            >
              <GitBranch className="h-3 w-3" />
              DAG
            </button>
          </div>

          {viewMode === "list" && (
            <>
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
            </>
          )}
        </div>
      </div>

      {/* ─── DAG mode ──────────────────────────────────────────────────────── */}
      {viewMode === "dag" && (
        <>
          {activeDAG ? (
            <div className="rounded-lg border border-border overflow-hidden" style={{ height: "600px" }}>
              <Suspense fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Loading canvas...
                </div>
              }>
                {pipelineId && (
                  <DAGCanvas pipelineId={pipelineId} dag={activeDAG} />
                )}
              </Suspense>
            </div>
          ) : (
            <Card className="border-border bg-card p-8 flex flex-col items-center gap-4 text-center">
              <GitBranch className="h-10 w-10 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">No DAG configured</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Convert your linear stages into a DAG to enable conditional branching and parallel execution.
                </p>
              </div>
              <Button
                size="sm"
                className="text-xs"
                onClick={handleConvertToDAG}
                disabled={pipelineStages.length === 0}
                aria-label="Convert linear pipeline stages to a DAG"
              >
                <GitBranch className="h-3.5 w-3.5 mr-1.5" />
                Convert to DAG
              </Button>
            </Card>
          )}
        </>
      )}

      {/* ─── List mode ─────────────────────────────────────────────────────── */}
      {viewMode === "list" && (
        <>
          {/* Specialization Presets */}
          <Card className="border-border bg-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bookmark className="h-4 w-4 text-blue-500" />
                <span className="text-sm font-medium">Model Specialization Presets</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-7 gap-1"
                onClick={() => setShowSavePresetDialog(true)}
              >
                <BookmarkPlus className="h-3 w-3" /> Save current
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {specializationProfiles.map(profile => (
                <div key={profile.id} className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs h-7"
                    onClick={() => applySpecializationProfile(profile.id)}
                  >
                    {profile.name}
                  </Button>
                  {!profile.isBuiltIn && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => deleteProfile.mutate(profile.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              ))}
              {specializationProfiles.length === 0 && (
                <span className="text-xs text-muted-foreground">No presets yet. Save your current model assignments.</span>
              )}
            </div>
          </Card>

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
                  className="text-xs h-7 flex items-center gap-1"
                  onClick={() => applyExecutionPreset(preset.id)}
                  title={preset.description}
                >
                  {preset.label}
                  {preset.costMultiplier > 1 && (
                    <span className="text-[9px] text-amber-500 font-mono">
                      ~{preset.costMultiplier}x
                    </span>
                  )}
                </Button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Quality Max uses MoA, Debate, and Voting for maximum output quality.
              Apply a preset, then save to persist.
            </p>
          </Card>

          {/* Stage Pipeline — drag to reorder */}
          <div className="relative">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={localStages.map(s => s.teamId)} strategy={verticalListSortingStrategy}>
                <div className="space-y-6">
                  {localStages.map((stage, idx) => {
                    const custom = isCustomStage(stage.teamId);
                    const customMeta = (stage as PipelineStageConfig & { _customMeta?: CustomStageConfig })._customMeta;
                    const display = getStageDisplay(stage.teamId, customMeta);
                    const team = custom ? null : SDLC_TEAMS[stage.teamId as keyof typeof SDLC_TEAMS];

                    return (
                      <SortableStage key={stage.teamId} id={stage.teamId}>
                        {(dragHandleProps) => (
                          <div className="flex items-start gap-2">
                            <button
                              type="button"
                              {...dragHandleProps}
                              className="mt-4 p-1 text-muted-foreground hover:text-foreground rounded shrink-0"
                              title="Drag to reorder"
                            >
                              <GripVertical className="h-4 w-4" />
                            </button>
                            <div className="flex-1 relative">
                              {custom && (
                                <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
                                  <Badge variant="outline" className="text-[9px] h-4 px-1 border-violet-500/50 text-violet-600">
                                    custom
                                  </Badge>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive"
                                    onClick={() => removeStage(stage.teamId)}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              )}
                              <AgentNode
                                key={stage.teamId}
                                id={stage.teamId}
                                role={stage.teamId}
                                model={stage.modelSlug}
                                description={team?.description ?? display.description}
                                enabled={stage.enabled}
                                color={team?.color ?? display.color}
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
                                sandboxConfig={stage.sandbox}
                                onSandboxChange={(_, cfg) => updateSandbox(stage.teamId, cfg)}
                                toolConfig={stage.tools}
                                onToolConfigChange={(_, cfg) => updateToolConfig(stage.teamId, cfg)}
                                parallelConfig={stage.parallel as ParallelConfig | undefined}
                                onParallelChange={(_, cfg) => updateParallelConfig(stage.teamId, cfg)}
                                swarmConfig={stage.swarm as SwarmConfig | undefined}
                                onSwarmChange={(_, cfg) => updateSwarmConfig(stage.teamId, cfg)}
                                approvalRequired={stage.approvalRequired ?? false}
                                onApprovalChange={(_, val) => updateApprovalRequired(stage.teamId, val)}
                                isLast={idx === localStages.length - 1}
                              />
                            </div>
                          </div>
                        )}
                      </SortableStage>
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>

            {/* Add Custom Stage button */}
            <button
              type="button"
              className="mt-4 w-full border-2 border-dashed border-border rounded-lg p-3 text-xs text-muted-foreground hover:border-violet-500/50 hover:text-violet-600 transition-colors flex items-center justify-center gap-2"
              onClick={() => { setCustomStageDraft({}); setShowAddCustomDialog(true); }}
            >
              <Plus className="h-3.5 w-3.5" /> Add custom stage
            </button>
          </div>

          {/* Optional Fact Check Stage */}
          <Card className="border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Fact Check Stage</span>
                <span className="text-xs text-muted-foreground">(optional — Grok verifies outputs via web search)</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {factCheckEnabled ? "Enabled — will run after the last active stage" : "Disabled"}
                </span>
                <button
                  type="button"
                  className={[
                    "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                    factCheckEnabled ? "bg-violet-500" : "bg-muted",
                  ].join(" ")}
                  aria-label={factCheckEnabled ? "Disable fact check stage" : "Enable fact check stage"}
                  onClick={() => {
                    const next = !factCheckEnabled;
                    setFactCheckEnabled(next);
                    if (next) {
                      const factStage = SDLC_TEAMS["fact_check" as keyof typeof SDLC_TEAMS];
                      const defaultSlug = (modelList[0]?.value as string) ?? "grok-3";
                      setLocalStages(prev => {
                        if (prev.find(s => s.teamId === "fact_check")) {
                          return prev.map(s => s.teamId === "fact_check" ? { ...s, enabled: true } : s);
                        }
                        return [...prev, { teamId: "fact_check" as const, modelSlug: defaultSlug, enabled: true, description: factStage?.description ?? "" } as unknown as PipelineStageConfig];
                      });
                    } else {
                      setLocalStages(prev => prev.filter(s => s.teamId !== "fact_check"));
                    }
                    setDirty(true);
                  }}
                >
                  <span
                    className={[
                      "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition",
                      factCheckEnabled ? "translate-x-4" : "translate-x-0",
                    ].join(" ")}
                  />
                </button>
              </div>
            </div>
          </Card>

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
                  <div className="font-medium mb-1">Sandbox Execution</div>
                  <div className="text-muted-foreground">Each stage can optionally run generated code in an isolated Docker container</div>
                </div>
              </div>
            </div>
          </Card>

          {/* Pipeline Flow Description */}
          <Card className="border-border bg-card p-4 space-y-3">
            <div className="text-sm font-medium">Pipeline Flow</div>
            <div className="space-y-2 text-xs text-muted-foreground">
              {localStages.map((stage) => {
                const custom = isCustomStage(stage.teamId);
                const customMeta = (stage as PipelineStageConfig & { _customMeta?: CustomStageConfig })._customMeta;
                const display = getStageDisplay(stage.teamId, customMeta);
                const model = modelList.find(m => m.value === stage?.modelSlug);
                const strat = stage?.executionStrategy;
                return (
                  <div key={stage.teamId} className="flex gap-2">
                    <span className="font-mono text-blue-500">→</span>
                    <span>
                      <span className="font-medium text-foreground">{display.name}</span>
                      {model && <span className="ml-1">({model.label})</span>}
                      {custom && (
                        <Badge variant="outline" className="ml-2 text-[9px] h-4 px-1 border-violet-500/50 text-violet-600">
                          custom
                        </Badge>
                      )}
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
                      {' — '}{display.description}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>
        </>
      )}

      {/* Save Preset Dialog */}
      <Dialog open={showSavePresetDialog} onOpenChange={setShowSavePresetDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Save Model Assignments as Preset</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">Preset name</Label>
              <Input
                className="mt-1 h-8 text-xs"
                placeholder="e.g. My Claude Setup"
                value={savePresetName}
                onChange={(e) => setSavePresetName(e.target.value)}
                maxLength={100}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => setShowSavePresetDialog(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="text-xs"
              disabled={!savePresetName.trim() || createProfile.isPending}
              onClick={handleSaveAsPreset}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Custom Stage Dialog */}
      <Dialog open={showAddCustomDialog} onOpenChange={setShowAddCustomDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Add Custom Stage</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">Stage name</Label>
              <Input
                className="mt-1 h-8 text-xs"
                placeholder="e.g. Security Analysis"
                value={customStageDraft.name ?? ""}
                onChange={(e) => setCustomStageDraft(d => ({ ...d, name: e.target.value }))}
                maxLength={80}
              />
            </div>
            <div>
              <Label className="text-xs">Icon (emoji)</Label>
              <Input
                className="mt-1 h-8 text-xs w-24"
                placeholder="⚙️"
                value={customStageDraft.icon ?? ""}
                onChange={(e) => setCustomStageDraft(d => ({ ...d, icon: e.target.value }))}
                maxLength={4}
              />
            </div>
            <div>
              <Label className="text-xs">Description</Label>
              <Input
                className="mt-1 h-8 text-xs"
                placeholder="What this stage does"
                value={customStageDraft.description ?? ""}
                onChange={(e) => setCustomStageDraft(d => ({ ...d, description: e.target.value }))}
                maxLength={200}
              />
            </div>
            <div>
              <Label className="text-xs">System prompt</Label>
              <Textarea
                className="mt-1 text-xs min-h-[80px]"
                placeholder="You are a helpful AI assistant that..."
                value={customStageDraft.systemPrompt ?? ""}
                onChange={(e) => setCustomStageDraft(d => ({ ...d, systemPrompt: e.target.value }))}
                maxLength={4000}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => setShowAddCustomDialog(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="text-xs"
              disabled={!customStageDraft.name?.trim()}
              onClick={handleAddCustomStage}
            >
              Add Stage
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
