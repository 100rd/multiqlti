/**
 * Start form for a debate-research orchestrator run.
 *
 * Reuses the repo form primitives (Label, Textarea, Input, Button, Card). The
 * task + needs are free text; the optional workspace id binds the run; optional
 * caps (steps / debate rounds / research sources / token budget) map straight to
 * the POST body's `caps`. The server re-clamps every cap (defense in depth), so
 * the inputs are advisory affordances only.
 *
 * Disabled / busy while submitting. A 503 (orchestrator disabled) is surfaced by
 * the parent via the `disabled` prop, which swaps this form for a friendly note.
 */
import { useState, type FormEvent } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { projectedCostUsd, formatUsd, formatTokens } from "@/lib/orchestrator";
import type { OrchestratorCapsInput } from "@/lib/orchestrator";

export interface StartFormValues {
  task: string;
  needs?: string;
  workspaceId?: string;
  caps?: OrchestratorCapsInput;
}

interface StartFormProps {
  /** Pre-fill + lock the workspace binding when launched from a workspace. */
  defaultWorkspaceId?: string;
  isSubmitting: boolean;
  onSubmit: (values: StartFormValues) => void;
}

const DEFAULT_MAX_TOTAL_TOKENS = 400_000;

function parseOptionalInt(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function StartForm({
  defaultWorkspaceId,
  isSubmitting,
  onSubmit,
}: StartFormProps) {
  const [task, setTask] = useState("");
  const [needs, setNeeds] = useState("");
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId ?? "");
  const [maxSteps, setMaxSteps] = useState("");
  const [maxDebateRounds, setMaxDebateRounds] = useState("");
  const [maxResearchSources, setMaxResearchSources] = useState("");
  const [maxTotalTokens, setMaxTotalTokens] = useState("");

  const tokenBudget = parseOptionalInt(maxTotalTokens) ?? DEFAULT_MAX_TOTAL_TOKENS;
  const projected = projectedCostUsd(tokenBudget);
  const canSubmit = task.trim().length > 0 && !isSubmitting;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    const caps: OrchestratorCapsInput = {};
    const steps = parseOptionalInt(maxSteps);
    const rounds = parseOptionalInt(maxDebateRounds);
    const sources = parseOptionalInt(maxResearchSources);
    const tokens = parseOptionalInt(maxTotalTokens);
    if (steps !== undefined) caps.maxSteps = steps;
    if (rounds !== undefined) caps.maxDebateRounds = rounds;
    if (sources !== undefined) caps.maxResearchSources = sources;
    if (tokens !== undefined) caps.maxTotalTokens = tokens;

    const wsId = workspaceId.trim();
    onSubmit({
      task: task.trim(),
      needs: needs.trim() || undefined,
      workspaceId: wsId || undefined,
      caps: Object.keys(caps).length > 0 ? caps : undefined,
    });
  }

  return (
    <Card data-testid="orchestrator-start-form">
      <CardHeader>
        <CardTitle>Start an orchestrator run</CardTitle>
        <CardDescription>
          The orchestrator drafts a plan (research, code analysis, debate,
          grounding, synthesis) and pauses for your approval before it runs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="orchestrator-task">Task</Label>
            <Textarea
              id="orchestrator-task"
              required
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="What should the orchestrator investigate or decide?"
              rows={4}
              aria-describedby="orchestrator-task-hint"
            />
            <p id="orchestrator-task-hint" className="text-xs text-muted-foreground">
              The objective. Be specific about the decision or deliverable you want.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="orchestrator-needs">Needs (optional)</Label>
            <Textarea
              id="orchestrator-needs"
              value={needs}
              onChange={(e) => setNeeds(e.target.value)}
              placeholder="Constraints, context, sources to prefer, what good looks like…"
              rows={3}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="orchestrator-workspace">Workspace id (optional)</Label>
            <Input
              id="orchestrator-workspace"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              placeholder="Bind the run to a workspace"
              readOnly={!!defaultWorkspaceId}
              aria-readonly={!!defaultWorkspaceId}
            />
          </div>

          <fieldset className="space-y-3 rounded-lg border border-border p-4">
            <legend className="px-1 text-sm font-medium">Caps (optional)</legend>
            <p className="text-xs text-muted-foreground">
              Leave blank to use the configured defaults. The server re-clamps
              every cap, so these are advisory limits only.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <CapField
                id="cap-steps"
                label="Max steps"
                value={maxSteps}
                onChange={setMaxSteps}
                placeholder="8"
                min={1}
                max={20}
              />
              <CapField
                id="cap-rounds"
                label="Max debate rounds"
                value={maxDebateRounds}
                onChange={setMaxDebateRounds}
                placeholder="3"
                min={1}
                max={5}
              />
              <CapField
                id="cap-sources"
                label="Max research sources"
                value={maxResearchSources}
                onChange={setMaxResearchSources}
                placeholder="12"
                min={1}
                max={50}
              />
              <CapField
                id="cap-tokens"
                label="Token budget"
                value={maxTotalTokens}
                onChange={setMaxTotalTokens}
                placeholder={String(DEFAULT_MAX_TOTAL_TOKENS)}
                min={1000}
                max={2_000_000}
              />
            </div>
            <p className="text-xs text-muted-foreground" data-testid="start-projected-cost">
              Projected ceiling: ~{formatUsd(projected)} at {formatTokens(tokenBudget)} tokens
            </p>
          </fieldset>

          <div className="flex justify-end">
            <Button type="submit" disabled={!canSubmit} data-testid="start-submit">
              {isSubmitting ? "Starting…" : "Draft plan"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

interface CapFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  min: number;
  max: number;
}

function CapField({ id, label, value, onChange, placeholder, min, max }: CapFieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
