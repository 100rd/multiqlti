import { useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ChevronDown, ChevronUp, Pencil, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { SDLC_TEAMS, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, MIN_TEMPERATURE, MAX_TEMPERATURE, TEMPERATURE_STEP } from "@shared/constants";
import StrategyConfig from "./StrategyConfig";
import SandboxConfig from "./SandboxConfig";
import type { ExecutionStrategy, PrivacySettings, SandboxConfig as SandboxConfigType, StageToolConfig, ParallelConfig, MergeStrategy, StageGuardrail } from "@shared/types";
import GuardrailEditor from '../pipeline/GuardrailEditor';

interface ModelOption {
  label: string;
  value: string;
  provider: string;
}

interface AgentNodeProps {
  id: string;
  role: string;
  model: string;
  description: string;
  enabled: boolean;
  color: string;
  models: ModelOption[];
  systemPromptOverride?: string;
  temperature?: number;
  maxTokens?: number;
  executionStrategy?: ExecutionStrategy;
  privacySettings?: PrivacySettings;
  onModelChange: (id: string, model: string) => void;
  onToggle: () => void;
  onSystemPromptChange: (id: string, prompt: string) => void;
  onTemperatureChange: (id: string, temperature: number) => void;
  onMaxTokensChange: (id: string, maxTokens: number) => void;
  onStrategyChange: (id: string, strategy: ExecutionStrategy) => void;
  onPrivacyChange: (id: string, settings: PrivacySettings) => void;
  sandboxConfig?: SandboxConfigType;
  onSandboxChange: (id: string, config: SandboxConfigType | undefined) => void;
  toolConfig?: StageToolConfig;
  onToolConfigChange: (id: string, config: StageToolConfig) => void;
  parallelConfig?: ParallelConfig;
  onParallelChange: (id: string, config: ParallelConfig | undefined) => void;
  approvalRequired?: boolean;
  onApprovalChange: (id: string, value: boolean) => void;
  guardrails?: StageGuardrail[];
  onGuardrailsChange?: (id: string, guardrails: StageGuardrail[]) => void;
  isLast: boolean;
}


interface ParallelConfigPanelProps {
  config: ParallelConfig | undefined;
  models: Array<{ label: string; value: string; provider: string }>;
  defaultModelSlug: string;
  enabled: boolean;
  onChange: (cfg: ParallelConfig | undefined) => void;
}

function ParallelConfigPanel({
  config,
  models,
  defaultModelSlug: _defaultModelSlug,
  enabled,
  onChange,
}: ParallelConfigPanelProps) {
  const MERGE_STRATEGIES: Array<{ value: MergeStrategy; label: string }> = [
    { value: "auto", label: "Auto (team default)" },
    { value: "concatenate", label: "Concatenate" },
    { value: "review", label: "LLM Review" },
  ];

  const current: ParallelConfig = config ?? {
    enabled: false,
    mode: "auto",
    maxAgents: 3,
    mergeStrategy: "auto",
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">Enable parallel execution</label>
        <Switch
          checked={current.enabled}
          onCheckedChange={(checked) => onChange({ ...current, enabled: checked })}
          disabled={!enabled}
        />
      </div>

      {current.enabled && (
        <div className="space-y-2 pl-2 border-l-2 border-border">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-muted-foreground">Max agents</label>
              <span className="text-xs font-mono text-foreground">{current.maxAgents}</span>
            </div>
            <Slider
              min={1}
              max={10}
              step={1}
              value={[current.maxAgents]}
              onValueChange={([val]) => onChange({ ...current, maxAgents: val })}
              disabled={!enabled}
              className="h-4"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Merge strategy</label>
            <Select
              value={current.mergeStrategy}
              onValueChange={(v) => onChange({ ...current, mergeStrategy: v as MergeStrategy })}
              disabled={!enabled}
            >
              <SelectTrigger className="h-7 text-xs bg-background border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MERGE_STRATEGIES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Splitter model (optional)</label>
            <Select
              value={current.splitterModelSlug ?? ""}
              onValueChange={(v) => onChange({ ...current, splitterModelSlug: v || undefined })}
              disabled={!enabled}
            >
              <SelectTrigger className="h-7 text-xs bg-background border-border">
                <SelectValue placeholder="Same as stage model" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Same as stage model</SelectItem>
                {models.map((m) => (
                  <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Merger model (optional)</label>
            <Select
              value={current.mergerModelSlug ?? ""}
              onValueChange={(v) => onChange({ ...current, mergerModelSlug: v || undefined })}
              disabled={!enabled}
            >
              <SelectTrigger className="h-7 text-xs bg-background border-border">
                <SelectValue placeholder="Same as stage model" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Same as stage model</SelectItem>
                {models.map((m) => (
                  <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}

const COLOR_MAP: Record<string, string> = {
  blue: "border-l-blue-500",
  purple: "border-l-purple-500",
  green: "border-l-green-500",
  amber: "border-l-amber-500",
  orange: "border-l-orange-500",
  cyan: "border-l-cyan-500",
  rose: "border-l-rose-500",
};

const DOT_COLOR_MAP: Record<string, string> = {
  blue: "bg-blue-500",
  purple: "bg-purple-500",
  green: "bg-green-500",
  amber: "bg-amber-500",
  orange: "bg-orange-500",
  cyan: "bg-cyan-500",
  rose: "bg-rose-500",
};

const DEFAULT_TEAM_TOOLS: Record<string, string[]> = {
  planning:     ['web_search', 'knowledge_search', 'memory_search'],
  architecture: ['web_search', 'knowledge_search', 'memory_search'],
  development:  ['web_search', 'knowledge_search'],
  testing:      ['knowledge_search'],
  code_review:  ['web_search', 'knowledge_search', 'memory_search'],
  deployment:   ['web_search', 'knowledge_search'],
  monitoring:   ['web_search', 'knowledge_search'],
};

const ALL_BUILTIN_TOOLS = ['web_search', 'url_reader', 'knowledge_search', 'memory_search'];

const DEFAULT_PRIVACY: PrivacySettings = {
  enabled: false,
  level: "standard",
  vaultTtlMs: 3_600_000,
  auditLog: true,
};

export default function AgentNode({
  id,
  role,
  model,
  description,
  enabled,
  color,
  models,
  systemPromptOverride,
  temperature,
  maxTokens,
  executionStrategy,
  privacySettings,
  onModelChange,
  onToggle,
  onSystemPromptChange,
  onTemperatureChange,
  onMaxTokensChange,
  onStrategyChange,
  onPrivacyChange,
  sandboxConfig,
  onSandboxChange,
  toolConfig,
  onToolConfigChange,
  approvalRequired = false,
  onApprovalChange,
  parallelConfig,
  onParallelChange,
  guardrails = [],
  onGuardrailsChange,
  isLast,
}: AgentNodeProps) {
  const team = SDLC_TEAMS[role as keyof typeof SDLC_TEAMS];
  const teamName = team?.name ?? role;

  const [promptExpanded, setPromptExpanded] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [parallelExpanded, setParallelExpanded] = useState(false);
  const [guardrailsExpanded, setGuardrailsExpanded] = useState(false);
  const [localPrompt, setLocalPrompt] = useState(systemPromptOverride ?? "");
  const [localMaxTokens, setLocalMaxTokens] = useState(
    String(maxTokens ?? DEFAULT_MAX_TOKENS),
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const effectiveTemperature = temperature ?? DEFAULT_TEMPERATURE;
  const effectiveMaxTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
  const effectivePrivacy = privacySettings ?? DEFAULT_PRIVACY;

  const handlePromptBlur = () => {
    onSystemPromptChange(id, localPrompt);
  };

  const handleMaxTokensBlur = () => {
    const parsed = parseInt(localMaxTokens, 10);
    if (!isNaN(parsed) && parsed > 0) {
      onMaxTokensChange(id, parsed);
    } else {
      setLocalMaxTokens(String(effectiveMaxTokens));
    }
  };

  const handlePromptToggle = () => {
    setPromptExpanded((prev) => {
      if (!prev) {
        setLocalPrompt(systemPromptOverride ?? "");
        setTimeout(() => textareaRef.current?.focus(), 50);
      }
      return !prev;
    });
  };

  const handlePrivacyToggle = (checked: boolean) => {
    onPrivacyChange(id, { ...effectivePrivacy, enabled: checked });
  };

  const handlePrivacyLevelChange = (level: string) => {
    onPrivacyChange(id, {
      ...effectivePrivacy,
      level: level as PrivacySettings["level"],
    });
  };

  return (
    <div className="relative">
      <Card className={cn(
        "border-border shadow-sm bg-card transition-all border-l-4",
        COLOR_MAP[color] ?? "border-l-muted",
        !enabled && "opacity-50",
      )}>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 flex-1">
              <span className={cn("w-2.5 h-2.5 rounded-full shrink-0", DOT_COLOR_MAP[color] ?? "bg-muted")} />
              <div>
                <CardTitle className="text-sm font-semibold">{teamName}</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
              </div>
            </div>
            <Switch checked={enabled} onCheckedChange={onToggle} />
          </div>
        </CardHeader>

        <CardContent className="pt-0 space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Model</label>
            <Select value={model} onValueChange={(val) => onModelChange(id, val)} disabled={!enabled}>
              <SelectTrigger className="h-8 text-xs bg-background border-border">
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {models.map(m => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                    <span className="text-muted-foreground ml-1">({m.provider})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* System Prompt Override */}
          <div>
            <button
              type="button"
              onClick={handlePromptToggle}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              disabled={!enabled}
            >
              <Pencil className="h-3 w-3" />
              <span>
                {systemPromptOverride ? "Edit prompt override" : "Add prompt override"}
              </span>
              {promptExpanded
                ? <ChevronUp className="h-3 w-3 ml-1" />
                : <ChevronDown className="h-3 w-3 ml-1" />}
            </button>

            {promptExpanded && (
              <div className="mt-2">
                <Textarea
                  ref={textareaRef}
                  className="text-xs font-mono min-h-[80px] resize-y bg-background border-border"
                  placeholder={team?.systemPromptTemplate ?? "Override the system prompt for this stage..."}
                  value={localPrompt}
                  onChange={(e) => setLocalPrompt(e.target.value)}
                  onBlur={handlePromptBlur}
                  disabled={!enabled}
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  Saves automatically when you click away. Leave empty to use the default.
                </p>
              </div>
            )}
          </div>

          {/* Advanced: Temperature + Max Tokens + Privacy */}
          <div>
            <button
              type="button"
              onClick={() => setAdvancedExpanded((prev) => !prev)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              disabled={!enabled}
            >
              <span>Advanced</span>
              {advancedExpanded
                ? <ChevronUp className="h-3 w-3 ml-1" />
                : <ChevronDown className="h-3 w-3 ml-1" />}
            </button>

            {advancedExpanded && (
              <div className="mt-3 space-y-3 p-3 rounded border border-border bg-muted/30">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-muted-foreground">
                      Temperature
                    </label>
                    <span className="text-xs font-mono text-foreground">
                      {effectiveTemperature.toFixed(1)}
                    </span>
                  </div>
                  <Slider
                    min={MIN_TEMPERATURE}
                    max={MAX_TEMPERATURE}
                    step={TEMPERATURE_STEP}
                    value={[effectiveTemperature]}
                    onValueChange={([val]) => onTemperatureChange(id, val)}
                    disabled={!enabled}
                    className="h-4"
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
                    <span>Precise (0.0)</span>
                    <span>Creative (2.0)</span>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">
                    Max Tokens
                  </label>
                  <Input
                    type="number"
                    min={1}
                    className="h-7 text-xs bg-background border-border"
                    value={localMaxTokens}
                    onChange={(e) => setLocalMaxTokens(e.target.value)}
                    onBlur={handleMaxTokensBlur}
                    disabled={!enabled}
                  />
                </div>

                {/* Privacy Proxy */}
                <div className="pt-1 border-t border-border">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <ShieldCheck className="h-3 w-3 text-muted-foreground" />
                      <label className="text-xs font-medium text-muted-foreground">
                        Privacy Proxy
                      </label>
                    </div>
                    <Switch
                      checked={effectivePrivacy.enabled}
                      onCheckedChange={handlePrivacyToggle}
                      disabled={!enabled}
                    />
                  </div>

                  {effectivePrivacy.enabled && (
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground mb-1 block">
                        Anonymization Level
                      </label>
                      <Select
                        value={effectivePrivacy.level}
                        onValueChange={handlePrivacyLevelChange}
                        disabled={!enabled}
                      >
                        <SelectTrigger className="h-7 text-xs bg-background border-border">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="standard">Standard — mask critical + high severity</SelectItem>
                          <SelectItem value="strict">Strict — mask all identifiers</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-[10px] text-muted-foreground">
                        Pseudonymizes identifiers before sending to the LLM. Real values are restored in the response.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Strategy Config */}
          <StrategyConfig
            strategy={executionStrategy}
            models={models}
            defaultModelSlug={model}
            enabled={enabled}
            onChange={(s) => onStrategyChange(id, s)}
          />


          {/* Tools Config */}
          <div>
            <button
              type="button"
              onClick={() => setToolsExpanded((prev) => !prev)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              disabled={!enabled}
            >
              <span>Tools</span>
              {toolsExpanded
                ? <ChevronUp className="h-3 w-3 ml-1" />
                : <ChevronDown className="h-3 w-3 ml-1" />}
            </button>

            {toolsExpanded && (
              <div className="mt-3 space-y-3 p-3 rounded border border-border bg-muted/30">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">Enable tool calling</label>
                  <Switch
                    checked={toolConfig?.enabled ?? false}
                    onCheckedChange={(checked) =>
                      onToolConfigChange(id, {
                        ...(toolConfig ?? { enabled: false }),
                        enabled: checked,
                        allowedTools: toolConfig?.allowedTools ?? (DEFAULT_TEAM_TOOLS[role] ?? []),
                      })
                    }
                    disabled={!enabled}
                  />
                </div>

                {(toolConfig?.enabled ?? false) && (
                  <>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Available Tools</label>
                      <div className="space-y-1">
                        {ALL_BUILTIN_TOOLS.map((toolName) => {
                          const isAllowed = (toolConfig?.allowedTools ?? DEFAULT_TEAM_TOOLS[role] ?? []).includes(toolName);
                          return (
                            <div key={toolName} className="flex items-center justify-between">
                              <span className="text-xs font-mono">{toolName}</span>
                              <Switch
                                checked={isAllowed}
                                onCheckedChange={(checked) => {
                                  const current = toolConfig?.allowedTools ?? DEFAULT_TEAM_TOOLS[role] ?? [];
                                  const updated = checked
                                    ? [...current, toolName]
                                    : current.filter((t: string) => t !== toolName);
                                  onToolConfigChange(id, { ...(toolConfig ?? { enabled: true }), allowedTools: updated });
                                }}
                                disabled={!enabled}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-medium text-muted-foreground">
                          Max tool calls
                        </label>
                        <span className="text-xs font-mono text-foreground">
                          {toolConfig?.maxToolCalls ?? 10}
                        </span>
                      </div>
                      <Slider
                        min={1}
                        max={10}
                        step={1}
                        value={[toolConfig?.maxToolCalls ?? 10]}
                        onValueChange={([val]) =>
                          onToolConfigChange(id, { ...(toolConfig ?? { enabled: true }), maxToolCalls: val })
                        }
                        disabled={!enabled}
                        className="h-4"
                      />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Sandbox Config */}
          <SandboxConfig
            config={sandboxConfig}
            enabled={enabled}
            onChange={(cfg) => onSandboxChange(id, cfg)}
          />

          {/* Parallel Split Execution */}
          <div>
            <button
              type="button"
              onClick={() => setParallelExpanded((prev) => !prev)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              disabled={!enabled}
            >
              <span>Parallel execution</span>
              {parallelExpanded
                ? <ChevronUp className="h-3 w-3 ml-1" />
                : <ChevronDown className="h-3 w-3 ml-1" />}
            </button>

            {parallelExpanded && (
              <div className="mt-3 p-3 rounded border border-border bg-muted/30">
                <ParallelConfigPanel
                  config={parallelConfig}
                  models={models}
                  defaultModelSlug={model}
                  enabled={enabled}
                  onChange={(cfg) => onParallelChange(id, cfg)}
                />
              </div>
            )}
          </div>

          {/* Guardrails */}
          <div>
            <button
              type="button"
              onClick={() => setGuardrailsExpanded((prev) => !prev)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              disabled={!enabled}
            >
              <span>Guardrails {guardrails.length > 0 ? `(${guardrails.length})` : ''}</span>
              {guardrailsExpanded
                ? <ChevronUp className="h-3 w-3 ml-1" />
                : <ChevronDown className="h-3 w-3 ml-1" />}
            </button>

            {guardrailsExpanded && (
              <div className="mt-3 p-3 rounded border border-border bg-muted/30">
                <GuardrailEditor
                  guardrails={guardrails}
                  enabled={enabled}
                  stageModelSlug={model}
                  onChange={(updated) => onGuardrailsChange?.(id, updated)}
                />
              </div>
            )}
          </div>

          {/* Approval Gate */}
          <div className="pt-1 border-t border-border">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Require approval before next stage
                </label>
              </div>
              <Switch
                checked={approvalRequired}
                onCheckedChange={(checked) => onApprovalChange(id, checked)}
                disabled={!enabled}
              />
            </div>
            {approvalRequired && (
              <p className="text-[10px] text-muted-foreground mt-1">
                Pipeline will pause after this stage until a user approves the output.
              </p>
            )}
          </div>

          {team && (
            <div className="p-2 rounded bg-muted/50 border border-border">
              <div className="text-[10px] font-mono text-muted-foreground/70">
                Tools: {team.tools.join(", ")}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Connection line to next stage */}
      {!isLast && (
        <div className="absolute left-1/2 -bottom-6 w-[2px] h-6 bg-border -translate-x-1/2" />
      )}
    </div>
  );
}
