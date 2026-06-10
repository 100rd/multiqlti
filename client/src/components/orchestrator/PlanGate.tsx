/**
 * Plan + approval-gate panel.
 *
 * Renders the dynamic, ordered plan (typed steps) with the projected cost /
 * token budget, and the human gate (Approve / Reject). Light editing — reorder
 * (up/down) and remove — is available ONLY while the run is paused at
 * `awaiting_plan_approval`; the step args are shown read-only (a rich arg editor
 * would be heavy and the server re-validates any edited steps anyway, H3).
 *
 * Idempotent + again-safe: when the run is not awaiting approval the controls
 * are disabled and the plan renders read-only. Empty plans cannot be approved.
 *
 * SECURITY: every step descriptor (query/question/instruction) is UNTRUSTED and
 * rendered as inert React text.
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Trash2, Check, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StepTypeBadge } from "./StepBadges";
import {
  stepSummary,
  projectedCostUsd,
  formatUsd,
  formatTokens,
} from "@/lib/orchestrator";
import type { OrchestratorStepArgs } from "@/lib/orchestrator";
import {
  moveStepUp,
  moveStepDown,
  removeStep,
  planChanged,
} from "@/lib/orchestrator-plan-edit";

interface PlanGateProps {
  /** The plan as proposed (ordered step args). */
  plan: OrchestratorStepArgs[];
  /** Token budget (caps.maxTotalTokens) for the projected-cost display. */
  tokenBudget: number;
  /** TRUE only while the run is paused at the human gate. */
  awaitingApproval: boolean;
  isApproving: boolean;
  isRejecting: boolean;
  /** Approve. `editedSteps` is omitted when the plan was not changed. */
  onApprove: (editedSteps?: OrchestratorStepArgs[]) => void;
  onReject: () => void;
}

export function PlanGate({
  plan,
  tokenBudget,
  awaitingApproval,
  isApproving,
  isRejecting,
  onApprove,
  onReject,
}: PlanGateProps) {
  const [edited, setEdited] = useState<OrchestratorStepArgs[]>(plan);

  // Re-sync local edits whenever the upstream plan changes (e.g. after refetch).
  useEffect(() => {
    setEdited(plan);
  }, [plan]);

  const changed = useMemo(() => planChanged(plan, edited), [plan, edited]);
  const projected = projectedCostUsd(tokenBudget);
  const busy = isApproving || isRejecting;
  const canEdit = awaitingApproval && !busy;
  const canApprove = awaitingApproval && !busy && edited.length > 0;

  function handleApprove() {
    if (!canApprove) return;
    onApprove(changed ? edited : undefined);
  }

  return (
    <Card data-testid="plan-gate" data-awaiting={awaitingApproval}>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Proposed plan</CardTitle>
            <CardDescription>
              {awaitingApproval
                ? "Review and approve before execution. You can reorder or remove steps."
                : "This plan has been approved or the run is no longer at the gate."}
            </CardDescription>
          </div>
          <div className="text-right" data-testid="plan-projected-cost">
            <div className="text-xs text-muted-foreground">Projected ceiling</div>
            <div className="text-lg font-semibold tabular-nums">
              ~{formatUsd(projected)}
            </div>
            <div className="text-xs text-muted-foreground tabular-nums">
              {formatTokens(tokenBudget)} tokens
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {edited.length === 0 ? (
          <p
            className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground"
            data-testid="plan-empty"
          >
            The plan is empty. Reject the run and start again.
          </p>
        ) : (
          <ol className="space-y-2" data-testid="plan-steps">
            {edited.map((step, index) => (
              <li
                key={index}
                className="flex items-start gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/40"
                data-testid="plan-step"
              >
                <span className="mt-0.5 w-5 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-1">
                    <StepTypeBadge type={step.type} />
                  </div>
                  {/* Untrusted descriptor — inert text. */}
                  <p className="text-sm leading-relaxed text-foreground/90 break-words">
                    {stepSummary(step)}
                  </p>
                </div>
                {canEdit && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move step ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => setEdited((s) => moveStepUp(s, index))}
                      data-testid="plan-step-up"
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move step ${index + 1} down`}
                      disabled={index === edited.length - 1}
                      onClick={() => setEdited((s) => moveStepDown(s, index))}
                      data-testid="plan-step-down"
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove step ${index + 1}`}
                      onClick={() => setEdited((s) => removeStep(s, index))}
                      data-testid="plan-step-remove"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}

        {changed && awaitingApproval && (
          <p className="text-xs text-muted-foreground" data-testid="plan-edited-note">
            Plan edited. Your edited step list will be re-validated on the server
            before it runs.
          </p>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={onReject}
            disabled={!awaitingApproval || busy}
            data-testid="plan-reject"
          >
            <X className="h-4 w-4" />
            {isRejecting ? "Rejecting…" : "Reject"}
          </Button>
          <Button
            type="button"
            onClick={handleApprove}
            disabled={!canApprove}
            data-testid="plan-approve"
          >
            <Check className="h-4 w-4" />
            {isApproving ? "Approving…" : "Approve & run"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
