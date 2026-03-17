import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Plus, Trash2 } from "lucide-react";
import type { SwarmConfig, SwarmMerger, SwarmPerspective, SwarmSplitter } from "@shared/types";

const MIN_CLONE_COUNT = 2;
const MAX_CLONE_COUNT = 20;

interface SwarmConfigPanelProps {
  stageIndex: number;
  config: SwarmConfig | undefined;
  models: Array<{ label: string; value: string }>;
  defaultModelSlug: string;
  onChange: (config: SwarmConfig | undefined) => void;
  disabled?: boolean;
  parallelEnabled?: boolean;
}

function defaultSwarmConfig(): SwarmConfig {
  return {
    enabled: false,
    cloneCount: 3,
    splitter: "perspectives",
    merger: "concatenate",
  };
}

function PerspectiveEditor({
  perspectives,
  cloneCount,
  disabled,
  onChange,
}: {
  perspectives: SwarmPerspective[];
  cloneCount: number;
  disabled: boolean;
  onChange: (p: SwarmPerspective[]) => void;
}) {
  const addPerspective = () => {
    if (perspectives.length >= cloneCount) return;
    onChange([...perspectives, { label: `Perspective ${perspectives.length + 1}`, systemPromptSuffix: "" }]);
  };

  const removePerspective = (idx: number) => {
    onChange(perspectives.filter((_, i) => i !== idx));
  };

  const updatePerspective = (idx: number, field: keyof SwarmPerspective, value: string) => {
    const updated = perspectives.map((p, i) => (i === idx ? { ...p, [field]: value } : p));
    onChange(updated);
  };

  return (
    <div className="space-y-2">
      {perspectives.map((p, idx) => (
        <div key={idx} className="space-y-1 p-2 rounded border border-border bg-background/50">
          <div className="flex items-center gap-2">
            <input
              className="flex-1 h-6 text-xs px-2 rounded border border-border bg-background"
              placeholder="Perspective label"
              value={p.label}
              onChange={(e) => updatePerspective(idx, "label", e.target.value)}
              disabled={disabled}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
              onClick={() => removePerspective(idx)}
              disabled={disabled}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
          <Textarea
            className="text-xs min-h-[48px] resize-none"
            placeholder="System prompt suffix (appended to base prompt)"
            value={p.systemPromptSuffix}
            onChange={(e) => updatePerspective(idx, "systemPromptSuffix", e.target.value)}
            disabled={disabled}
          />
        </div>
      ))}
      {perspectives.length < cloneCount && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 text-xs w-full"
          onClick={addPerspective}
          disabled={disabled}
        >
          <Plus className="h-3 w-3 mr-1" />
          Add perspective
        </Button>
      )}
      {perspectives.length > 0 && perspectives.length !== cloneCount && (
        <p className="text-[10px] text-amber-500">
          {perspectives.length}/{cloneCount} perspectives defined. Undefined slots will use auto-generated labels.
        </p>
      )}
    </div>
  );
}

function CustomPromptEditor({
  prompts,
  cloneCount,
  disabled,
  onChange,
}: {
  prompts: string[];
  cloneCount: number;
  disabled: boolean;
  onChange: (p: string[]) => void;
}) {
  const slots = Array.from({ length: cloneCount }, (_, i) => prompts[i] ?? "");

  const updatePrompt = (idx: number, value: string) => {
    const updated = slots.map((p, i) => (i === idx ? value : p));
    onChange(updated);
  };

  return (
    <div className="space-y-2">
      {slots.map((prompt, idx) => (
        <div key={idx} className="space-y-1">
          <label className="text-[10px] text-muted-foreground">Clone {idx + 1} system prompt</label>
          <Textarea
            className="text-xs min-h-[60px] resize-none"
            placeholder={`System prompt for clone ${idx + 1}`}
            value={prompt}
            onChange={(e) => updatePrompt(idx, e.target.value)}
            disabled={disabled}
          />
        </div>
      ))}
    </div>
  );
}

export default function SwarmConfigPanel({
  stageIndex: _stageIndex,
  config,
  models,
  defaultModelSlug,
  onChange,
  disabled = false,
  parallelEnabled = false,
}: SwarmConfigPanelProps) {
  const current: SwarmConfig = config ?? defaultSwarmConfig();

  const isDisabled = disabled || parallelEnabled;

  const update = (partial: Partial<SwarmConfig>) => {
    onChange({ ...current, ...partial });
  };

  const handleEnableToggle = (checked: boolean) => {
    if (checked) {
      onChange({ ...current, enabled: true });
    } else {
      onChange({ ...current, enabled: false });
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">Enable swarm execution</label>
        <Switch
          checked={current.enabled}
          onCheckedChange={handleEnableToggle}
          disabled={isDisabled}
        />
      </div>

      {parallelEnabled && !current.enabled && (
        <p className="text-[10px] text-muted-foreground">
          Disable parallel execution first to enable swarm.
        </p>
      )}

      {current.enabled && (
        <div className="space-y-3 pl-2 border-l-2 border-border">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-muted-foreground">Clone count</label>
              <span className="text-xs font-mono text-foreground">{current.cloneCount}</span>
            </div>
            <Slider
              min={MIN_CLONE_COUNT}
              max={MAX_CLONE_COUNT}
              step={1}
              value={[current.cloneCount]}
              onValueChange={([val]) => update({ cloneCount: val })}
              disabled={isDisabled}
              className="h-4"
            />
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Runs the same stage {current.cloneCount} times in parallel. Max {MAX_CLONE_COUNT}.
            </p>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Input splitter</label>
            <Select
              value={current.splitter}
              onValueChange={(v) => update({ splitter: v as SwarmSplitter })}
              disabled={isDisabled}
            >
              <SelectTrigger className="h-7 text-xs bg-background border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="perspectives">Perspectives — each clone focuses on a different lens</SelectItem>
                <SelectItem value="chunks">Chunks — input split equally across clones</SelectItem>
                <SelectItem value="custom">Custom — define per-clone system prompts</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {current.splitter === "perspectives" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Perspectives (optional — leave empty to auto-generate)
              </label>
              <PerspectiveEditor
                perspectives={current.perspectives ?? []}
                cloneCount={current.cloneCount}
                disabled={isDisabled}
                onChange={(p) => update({ perspectives: p })}
              />
            </div>
          )}

          {current.splitter === "custom" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Per-clone system prompts
              </label>
              <CustomPromptEditor
                prompts={current.customClonePrompts ?? []}
                cloneCount={current.cloneCount}
                disabled={isDisabled}
                onChange={(p) => update({ customClonePrompts: p })}
              />
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Output merger</label>
            <Select
              value={current.merger}
              onValueChange={(v) => update({ merger: v as SwarmMerger })}
              disabled={isDisabled}
            >
              <SelectTrigger className="h-7 text-xs bg-background border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="concatenate">Concatenate — join outputs with headers</SelectItem>
                <SelectItem value="llm_merge">LLM Merge — synthesize with a model</SelectItem>
                <SelectItem value="vote">Vote — pick majority value (structured outputs)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {current.merger === "llm_merge" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Merger model (optional)
              </label>
              <Select
                value={current.mergerModelSlug ?? ""}
                onValueChange={(v) => update({ mergerModelSlug: v || undefined })}
                disabled={isDisabled}
              >
                <SelectTrigger className="h-7 text-xs bg-background border-border">
                  <SelectValue placeholder={`Same as stage (${defaultModelSlug})`} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Same as stage model</SelectItem>
                  {models.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
