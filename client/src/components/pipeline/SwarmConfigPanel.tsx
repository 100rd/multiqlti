/**
 * SwarmConfigPanel — Stage-level configuration UI for swarm settings.
 *
 * Rendered inside AgentNode's advanced settings area, below ParallelConfig.
 * Swarm and parallel execution are mutually exclusive.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Plus, Trash2, Loader2, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Local type definitions (mirrors shared/types.ts additions from Phase 6.7) ───

export type SwarmSplitter = "chunks" | "perspectives" | "custom";
export type SwarmMerger = "concatenate" | "llm_merge" | "vote";

export interface SwarmPerspective {
  label: string;
  systemPromptSuffix: string;
}

export interface SwarmConfig {
  enabled: boolean;
  cloneCount: number;
  splitter: SwarmSplitter;
  merger: SwarmMerger;
  mergerModelSlug?: string;
  perspectives?: SwarmPerspective[];
  customClonePrompts?: string[];
}

// ─── Props ───────────────────────────────────────────────────────────────────

export interface SwarmConfigPanelProps {
  pipelineId: string;
  stageIndex: number;
  config: SwarmConfig | undefined;
  onChange: (config: SwarmConfig | undefined) => void;
  disabled?: boolean;
  models?: Array<{ label: string; value: string; provider: string }>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SPLITTER_OPTIONS: Array<{ value: SwarmSplitter; label: string; description: string }> = [
  { value: "chunks", label: "Chunks", description: "Split input into N equal parts" },
  { value: "perspectives", label: "Perspectives", description: "Each clone reviews from a different angle" },
  { value: "custom", label: "Custom", description: "Define a unique system prompt per clone" },
];

const MERGER_OPTIONS: Array<{ value: SwarmMerger; label: string }> = [
  { value: "concatenate", label: "Concatenate" },
  { value: "llm_merge", label: "LLM Merge" },
  { value: "vote", label: "Vote (majority)" },
];

function buildDefaultConfig(): SwarmConfig {
  return {
    enabled: false,
    cloneCount: 3,
    splitter: "chunks",
    merger: "concatenate",
  };
}

// ─── Perspective Editor ───────────────────────────────────────────────────────

interface PerspectiveEditorProps {
  perspective: SwarmPerspective;
  index: number;
  disabled: boolean;
  onChange: (updated: SwarmPerspective) => void;
  onRemove: () => void;
}

function PerspectiveEditor({
  perspective,
  index,
  disabled,
  onChange,
  onRemove,
}: PerspectiveEditorProps) {
  return (
    <div className="rounded border border-border bg-background p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono text-muted-foreground w-5 shrink-0">
          {index + 1}
        </span>
        <Input
          className="h-7 text-xs bg-background border-border flex-1"
          placeholder="e.g. Security Review"
          value={perspective.label}
          onChange={(e) => onChange({ ...perspective, label: e.target.value })}
          disabled={disabled}
          aria-label={`Perspective ${index + 1} label`}
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-destructive hover:text-destructive shrink-0"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove perspective ${index + 1}`}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
      <Textarea
        className="text-xs font-mono min-h-[56px] resize-y bg-muted/30 border-border"
        placeholder="System prompt suffix — appended after the stage's base system prompt"
        value={perspective.systemPromptSuffix}
        onChange={(e) => onChange({ ...perspective, systemPromptSuffix: e.target.value })}
        disabled={disabled}
        aria-label={`Perspective ${index + 1} system prompt suffix`}
      />
    </div>
  );
}

// ─── SwarmConfigPanel (exported) ─────────────────────────────────────────────

export default function SwarmConfigPanel({
  pipelineId,
  stageIndex,
  config,
  onChange,
  disabled = false,
  models = [],
}: SwarmConfigPanelProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const current: SwarmConfig = config ?? buildDefaultConfig();
  const isEnabled = current.enabled;
  const isDisabled = disabled || !isEnabled;

  const update = (patch: Partial<SwarmConfig>) => {
    onChange({ ...current, ...patch });
  };

  const handleToggle = (checked: boolean) => {
    if (checked) {
      onChange({ ...current, enabled: true });
    } else {
      onChange({ ...current, enabled: false });
    }
  };

  // ─── Clone count change — keep custom prompts in sync ──────────────────────
  const handleCloneCountChange = (count: number) => {
    const patches: Partial<SwarmConfig> = { cloneCount: count };

    if (current.splitter === "custom") {
      const existing = current.customClonePrompts ?? [];
      if (existing.length < count) {
        patches.customClonePrompts = [
          ...existing,
          ...Array(count - existing.length).fill(""),
        ];
      } else if (existing.length > count) {
        patches.customClonePrompts = existing.slice(0, count);
      }
    }

    if (current.splitter === "perspectives") {
      const existing = current.perspectives ?? [];
      if (existing.length > count) {
        patches.perspectives = existing.slice(0, count);
      }
    }

    update(patches);
  };

  // ─── Splitter change — initialise related fields ───────────────────────────
  const handleSplitterChange = (splitter: SwarmSplitter) => {
    const patches: Partial<SwarmConfig> = { splitter };
    if (splitter === "custom") {
      patches.customClonePrompts = Array(current.cloneCount).fill("");
    }
    if (splitter === "perspectives" && !current.perspectives?.length) {
      patches.perspectives = [];
    }
    update(patches);
  };

  // ─── Perspectives ──────────────────────────────────────────────────────────
  const perspectives = current.perspectives ?? [];

  const addPerspective = () => {
    update({
      perspectives: [
        ...perspectives,
        { label: "", systemPromptSuffix: "" },
      ],
    });
  };

  const updatePerspective = (index: number, updated: SwarmPerspective) => {
    update({
      perspectives: perspectives.map((p, i) => (i === index ? updated : p)),
    });
  };

  const removePerspective = (index: number) => {
    update({
      perspectives: perspectives.filter((_, i) => i !== index),
    });
  };

  const handleAutoGenerate = async () => {
    setIsGenerating(true);
    setGenerateError(null);
    try {
      const token = localStorage.getItem("auth_token");
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(
        `/api/pipelines/${pipelineId}/stages/${stageIndex}/swarm/generate-perspectives`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ cloneCount: current.cloneCount }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText })) as { message?: string };
        throw new Error(err.message ?? res.statusText);
      }
      const data = await res.json() as { perspectives: SwarmPerspective[] };
      update({ perspectives: data.perspectives });
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Failed to generate perspectives");
    } finally {
      setIsGenerating(false);
    }
  };

  // ─── Custom prompts ────────────────────────────────────────────────────────
  const customPrompts = current.customClonePrompts ?? [];
  const customMismatch =
    current.splitter === "custom" && customPrompts.length !== current.cloneCount;

  const updateCustomPrompt = (index: number, value: string) => {
    const updated = [...customPrompts];
    updated[index] = value;
    update({ customClonePrompts: updated });
  };

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-3" aria-label="Swarm configuration">
      {/* Enable toggle */}
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">
          Enable swarm execution
        </label>
        <Switch
          checked={isEnabled}
          onCheckedChange={handleToggle}
          disabled={disabled}
          aria-label="Enable swarm execution"
        />
      </div>

      {isEnabled && (
        <div className="space-y-3 pl-2 border-l-2 border-border">
          {/* Clone count */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-muted-foreground">
                Clone count
              </label>
              <span className="text-xs font-mono text-foreground">
                {current.cloneCount}
              </span>
            </div>
            <Slider
              min={2}
              max={20}
              step={1}
              value={[current.cloneCount]}
              onValueChange={([val]) => handleCloneCountChange(val)}
              disabled={isDisabled}
              className="h-4"
              aria-label="Clone count"
            />
            <div className="flex justify-between mt-0.5">
              <span className="text-[10px] text-muted-foreground">2</span>
              <span className="text-[10px] text-muted-foreground">20</span>
            </div>
          </div>

          {/* Splitter */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Split strategy
            </label>
            <Select
              value={current.splitter}
              onValueChange={(v) => handleSplitterChange(v as SwarmSplitter)}
              disabled={isDisabled}
            >
              <SelectTrigger
                className="h-7 text-xs bg-background border-border"
                aria-label="Split strategy"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SPLITTER_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    <span>{o.label}</span>
                    <span className="ml-1 text-muted-foreground text-[10px]">
                      — {o.description}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Perspectives editor */}
          {current.splitter === "perspectives" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  Perspectives ({perspectives.length}/{current.cloneCount})
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-[10px] gap-1"
                    onClick={handleAutoGenerate}
                    disabled={isDisabled || isGenerating}
                    aria-label="Auto-generate perspectives"
                  >
                    {isGenerating ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Wand2 className="h-3 w-3" />
                    )}
                    {isGenerating ? "Generating..." : "Auto-generate"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[10px]"
                    onClick={addPerspective}
                    disabled={isDisabled}
                    aria-label="Add perspective"
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add
                  </Button>
                </div>
              </div>

              {generateError && (
                <p className="text-[10px] text-destructive">{generateError}</p>
              )}

              {perspectives.length === 0 && (
                <p className="text-[10px] text-muted-foreground/70 italic">
                  No perspectives yet. Add one manually or auto-generate{" "}
                  {current.cloneCount} from the stage description.
                </p>
              )}

              {perspectives.map((p, i) => (
                <PerspectiveEditor
                  key={i}
                  perspective={p}
                  index={i}
                  disabled={isDisabled}
                  onChange={(updated) => updatePerspective(i, updated)}
                  onRemove={() => removePerspective(i)}
                />
              ))}
            </div>
          )}

          {/* Custom prompts editor */}
          {current.splitter === "custom" && (
            <div className="space-y-2">
              <span className="text-xs font-medium text-muted-foreground block">
                System prompt per clone
              </span>

              {customMismatch && (
                <p className="text-[10px] text-destructive">
                  Prompt count ({customPrompts.length}) does not match clone count (
                  {current.cloneCount}). Adjust the clone count or add/remove prompts.
                </p>
              )}

              {Array.from({ length: current.cloneCount }, (_, i) => (
                <div key={i} className="space-y-1">
                  <label className="text-[10px] font-medium text-muted-foreground">
                    Clone {i + 1}
                  </label>
                  <Textarea
                    className={cn(
                      "text-xs font-mono min-h-[56px] resize-y bg-muted/30 border-border",
                      customMismatch && "border-destructive",
                    )}
                    placeholder={`System prompt override for clone ${i + 1}`}
                    value={customPrompts[i] ?? ""}
                    onChange={(e) => updateCustomPrompt(i, e.target.value)}
                    disabled={isDisabled}
                    aria-label={`Clone ${i + 1} system prompt`}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Merger */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Merge strategy
            </label>
            <Select
              value={current.merger}
              onValueChange={(v) => update({ merger: v as SwarmMerger })}
              disabled={isDisabled}
            >
              <SelectTrigger
                className="h-7 text-xs bg-background border-border"
                aria-label="Merge strategy"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MERGER_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Merger model slug — only for llm_merge */}
          {current.merger === "llm_merge" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Merger model
              </label>
              {models.length > 0 ? (
                <Select
                  value={current.mergerModelSlug ?? ""}
                  onValueChange={(v) =>
                    update({ mergerModelSlug: v || undefined })
                  }
                  disabled={isDisabled}
                >
                  <SelectTrigger
                    className="h-7 text-xs bg-background border-border"
                    aria-label="Merger model"
                  >
                    <SelectValue placeholder="Stage default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Stage default</SelectItem>
                    {models.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  className="h-7 text-xs font-mono bg-background border-border"
                  placeholder="e.g. gpt-4o (defaults to stage model)"
                  value={current.mergerModelSlug ?? ""}
                  onChange={(e) =>
                    update({ mergerModelSlug: e.target.value || undefined })
                  }
                  disabled={isDisabled}
                  aria-label="Merger model slug"
                />
              )}
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Model used to synthesise the N clone outputs into one result.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
