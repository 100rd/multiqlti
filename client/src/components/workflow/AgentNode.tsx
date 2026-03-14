import { useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ChevronDown, ChevronUp, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { SDLC_TEAMS, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, MIN_TEMPERATURE, MAX_TEMPERATURE, TEMPERATURE_STEP } from "@shared/constants";
import StrategyConfig from "./StrategyConfig";
import type { ExecutionStrategy } from "@shared/types";

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
  onModelChange: (id: string, model: string) => void;
  onToggle: () => void;
  onSystemPromptChange: (id: string, prompt: string) => void;
  onTemperatureChange: (id: string, temperature: number) => void;
  onMaxTokensChange: (id: string, maxTokens: number) => void;
  onStrategyChange: (id: string, strategy: ExecutionStrategy) => void;
  isLast: boolean;
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
  onModelChange,
  onToggle,
  onSystemPromptChange,
  onTemperatureChange,
  onMaxTokensChange,
  onStrategyChange,
  isLast,
}: AgentNodeProps) {
  const team = SDLC_TEAMS[role as keyof typeof SDLC_TEAMS];
  const teamName = team?.name ?? role;

  const [promptExpanded, setPromptExpanded] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [localPrompt, setLocalPrompt] = useState(systemPromptOverride ?? "");
  const [localMaxTokens, setLocalMaxTokens] = useState(
    String(maxTokens ?? DEFAULT_MAX_TOKENS),
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const effectiveTemperature = temperature ?? DEFAULT_TEMPERATURE;
  const effectiveMaxTokens = maxTokens ?? DEFAULT_MAX_TOKENS;

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

          {/* Advanced: Temperature + Max Tokens */}
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
