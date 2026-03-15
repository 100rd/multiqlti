/**
 * GuardrailEditor — stage advanced settings panel for managing guardrails.
 *
 * Shown inside the AgentNode advanced settings area, below ParallelConfig.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ChevronDown, ChevronUp, Plus, Trash2, TestTube } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StageGuardrail, GuardrailType, GuardrailOnFail, GuardrailConfig } from "@shared/types";

interface GuardrailEditorProps {
  guardrails: StageGuardrail[];
  enabled: boolean;
  stageModelSlug: string;
  onChange: (guardrails: StageGuardrail[]) => void;
}

const GUARDRAIL_TYPES: Array<{ value: GuardrailType; label: string }> = [
  { value: "json_schema", label: "JSON Schema" },
  { value: "regex", label: "Regex" },
  { value: "custom", label: "Custom JS" },
  { value: "llm_check", label: "LLM Check" },
];

const ON_FAIL_OPTIONS: Array<{ value: GuardrailOnFail; label: string }> = [
  { value: "retry", label: "Retry" },
  { value: "skip", label: "Skip" },
  { value: "fail", label: "Fail" },
  { value: "fallback", label: "Fallback" },
];

function generateId(): string {
  return `guardrail-${Math.random().toString(36).slice(2, 9)}`;
}

function buildDefaultGuardrail(): StageGuardrail {
  return {
    id: generateId(),
    type: "json_schema",
    config: {},
    onFail: "retry",
    maxRetries: 1,
    enabled: true,
  };
}

// ─── Single Guardrail Card ────────────────────────────────────────────────────

interface GuardrailCardProps {
  guardrail: StageGuardrail;
  index: number;
  enabled: boolean;
  stageModelSlug: string;
  onChange: (updated: StageGuardrail) => void;
  onRemove: () => void;
}

function GuardrailCard({
  guardrail,
  index,
  enabled,
  stageModelSlug,
  onChange,
  onRemove,
}: GuardrailCardProps) {
  const [expanded, setExpanded] = useState(index === 0);
  const [testOutput, setTestOutput] = useState("");
  const [testResult, setTestResult] = useState<{ passed: boolean; reason?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const updateConfig = (patch: Partial<GuardrailConfig>) => {
    onChange({ ...guardrail, config: { ...guardrail.config, ...patch } });
  };

  const handleTest = async () => {
    if (!testOutput.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/guardrails/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guardrail, sampleOutput: testOutput }),
      });
      const data = await res.json() as { passed: boolean; reason?: string };
      setTestResult(data);
    } catch {
      setTestResult({ passed: false, reason: "Request failed" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="rounded border border-border bg-background">
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <Switch
          checked={guardrail.enabled}
          onCheckedChange={(checked) => onChange({ ...guardrail, enabled: checked })}
          disabled={!enabled}
          onClick={(e) => e.stopPropagation()}
          className="scale-75"
        />
        <span className="text-xs font-medium flex-1 text-muted-foreground">
          {guardrail.type} · on fail: {guardrail.onFail}
        </span>
        {expanded ? (
          <ChevronUp className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        )}
      </div>

      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-border pt-2">
          {/* Type */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Type</label>
            <Select
              value={guardrail.type}
              onValueChange={(v) => onChange({ ...guardrail, type: v as GuardrailType, config: {} })}
              disabled={!enabled}
            >
              <SelectTrigger className="h-7 text-xs bg-background border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GUARDRAIL_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Type-specific config */}
          {guardrail.type === "json_schema" && (
            <div>
              <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
                Schema (JSON)
              </label>
              <Textarea
                className="text-xs font-mono min-h-[60px] resize-y bg-muted/30 border-border"
                placeholder='{ "required": ["techStack", "components"] }'
                value={guardrail.config.schema ? JSON.stringify(guardrail.config.schema, null, 2) : ""}
                onChange={(e) => {
                  try {
                    const parsed = JSON.parse(e.target.value) as Record<string, unknown>;
                    updateConfig({ schema: parsed });
                  } catch {
                    // Keep invalid JSON in textarea without updating config
                  }
                }}
                disabled={!enabled}
              />
            </div>
          )}

          {guardrail.type === "regex" && (
            <div>
              <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Pattern</label>
              <Input
                className="h-7 text-xs font-mono bg-background border-border"
                placeholder="e.g. \btechStack\b"
                value={guardrail.config.pattern ?? ""}
                onChange={(e) => updateConfig({ pattern: e.target.value })}
                disabled={!enabled}
              />
            </div>
          )}

          {guardrail.type === "custom" && (
            <div>
              <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
                JS expression (max 500 chars) — receives <code>output</code> string
              </label>
              <Textarea
                className="text-xs font-mono min-h-[60px] resize-y bg-muted/30 border-border"
                placeholder="output.includes('techStack')"
                value={guardrail.config.validatorCode ?? ""}
                onChange={(e) => updateConfig({ validatorCode: e.target.value })}
                disabled={!enabled}
                maxLength={500}
              />
            </div>
          )}

          {guardrail.type === "llm_check" && (
            <div className="space-y-2">
              <div>
                <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
                  Validation prompt
                </label>
                <Textarea
                  className="text-xs font-mono min-h-[60px] resize-y bg-muted/30 border-border"
                  placeholder="Does this output contain a valid tech stack recommendation?"
                  value={guardrail.config.llmPrompt ?? ""}
                  onChange={(e) => updateConfig({ llmPrompt: e.target.value })}
                  disabled={!enabled}
                />
              </div>
              <div>
                <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
                  Model (optional)
                </label>
                <Input
                  className="h-7 text-xs font-mono bg-background border-border"
                  placeholder={stageModelSlug}
                  value={guardrail.config.llmModelSlug ?? ""}
                  onChange={(e) => updateConfig({ llmModelSlug: e.target.value || undefined })}
                  disabled={!enabled}
                />
              </div>
            </div>
          )}

          {/* On fail + max retries */}
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-[10px] font-medium text-muted-foreground mb-1 block">On fail</label>
              <Select
                value={guardrail.onFail}
                onValueChange={(v) => onChange({ ...guardrail, onFail: v as GuardrailOnFail })}
                disabled={!enabled}
              >
                <SelectTrigger className="h-7 text-xs bg-background border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ON_FAIL_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {guardrail.onFail === "retry" && (
              <div className="w-24">
                <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
                  Max retries
                </label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  className="h-7 text-xs bg-background border-border"
                  value={guardrail.maxRetries}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v) && v >= 1) onChange({ ...guardrail, maxRetries: v });
                  }}
                  disabled={!enabled}
                />
              </div>
            )}
          </div>

          {guardrail.onFail === "fallback" && (
            <div>
              <label className="text-[10px] font-medium text-muted-foreground mb-1 block">
                Fallback value
              </label>
              <Textarea
                className="text-xs font-mono min-h-[40px] resize-y bg-muted/30 border-border"
                placeholder="Value to use when guardrail fails"
                value={guardrail.fallbackValue ?? ""}
                onChange={(e) => onChange({ ...guardrail, fallbackValue: e.target.value || undefined })}
                disabled={!enabled}
              />
            </div>
          )}

          {/* Test panel */}
          <div className="space-y-1 pt-1 border-t border-border">
            <label className="text-[10px] font-medium text-muted-foreground block">
              Test against sample output
            </label>
            <Textarea
              className="text-xs font-mono min-h-[40px] resize-y bg-muted/30 border-border"
              placeholder="Paste sample LLM output to test..."
              value={testOutput}
              onChange={(e) => setTestOutput(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-[10px]"
                onClick={handleTest}
                disabled={testing || !testOutput.trim()}
              >
                <TestTube className="h-3 w-3 mr-1" />
                {testing ? "Testing..." : "Test"}
              </Button>

              {testResult !== null && (
                <span
                  className={cn(
                    "text-[10px] font-medium",
                    testResult.passed ? "text-emerald-500" : "text-red-500",
                  )}
                >
                  {testResult.passed ? "PASS" : `FAIL${testResult.reason ? `: ${testResult.reason}` : ""}`}
                </span>
              )}
            </div>
          </div>

          {/* Remove */}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px] text-destructive hover:text-destructive w-full"
            onClick={onRemove}
            disabled={!enabled}
          >
            <Trash2 className="h-3 w-3 mr-1" />
            Remove guardrail
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── GuardrailEditor (exported) ───────────────────────────────────────────────

export default function GuardrailEditor({
  guardrails,
  enabled,
  stageModelSlug,
  onChange,
}: GuardrailEditorProps) {
  const addGuardrail = () => {
    onChange([...guardrails, buildDefaultGuardrail()]);
  };

  const updateGuardrail = (index: number, updated: StageGuardrail) => {
    onChange(guardrails.map((g, i) => (i === index ? updated : g)));
  };

  const removeGuardrail = (index: number) => {
    onChange(guardrails.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Guardrails</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[10px]"
          onClick={addGuardrail}
          disabled={!enabled}
        >
          <Plus className="h-3 w-3 mr-1" />
          Add Guardrail
        </Button>
      </div>

      {guardrails.length === 0 && (
        <p className="text-[10px] text-muted-foreground/70 italic">
          No guardrails configured. Add one to validate stage output before it passes to the next stage.
        </p>
      )}

      {guardrails.map((guardrail, index) => (
        <GuardrailCard
          key={guardrail.id}
          guardrail={guardrail}
          index={index}
          enabled={enabled}
          stageModelSlug={stageModelSlug}
          onChange={(updated) => updateGuardrail(index, updated)}
          onRemove={() => removeGuardrail(index)}
        />
      ))}
    </div>
  );
}
