/**
 * Live step-progress panel: the ordered plan with each step's status as it runs.
 *
 * Driven by GET /api/runs/:id/orchestrator (steps[] + totalTokensUsed), kept
 * live by the WS bridge in use-orchestrator (invalidate-on-event). Shows a token
 * budget meter (used / ceiling). Read-only.
 *
 * SECURITY: step descriptors + any per-step error text are UNTRUSTED inert text.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StepTypeBadge, StepStatusBadge } from "./StepBadges";
import {
  stepSummary,
  formatTokens,
  tokenBudgetFraction,
} from "@/lib/orchestrator";
import type { OrchestratorStep } from "@/lib/orchestrator";

interface StepProgressProps {
  steps: OrchestratorStep[];
  totalTokensUsed: number;
  /** Token ceiling for the budget meter (caps.maxTotalTokens). */
  tokenBudget: number;
}

export function StepProgress({
  steps,
  totalTokensUsed,
  tokenBudget,
}: StepProgressProps) {
  const ordered = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);
  const fraction = tokenBudgetFraction(totalTokensUsed, tokenBudget);
  const percent = Math.round(fraction * 100);

  return (
    <Card data-testid="step-progress">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle>Execution</CardTitle>
          <div className="text-right" data-testid="token-budget">
            <div className="text-xs text-muted-foreground">Tokens used</div>
            <div className="text-sm font-semibold tabular-nums">
              {formatTokens(totalTokensUsed)}
              {tokenBudget > 0 && (
                <span className="text-muted-foreground">
                  {" "}
                  / {formatTokens(tokenBudget)}
                </span>
              )}
            </div>
          </div>
        </div>
        {tokenBudget > 0 && (
          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Token budget used"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none"
              style={{ width: `${percent}%` }}
            />
          </div>
        )}
      </CardHeader>

      <CardContent>
        {ordered.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground" data-testid="step-progress-empty">
            No steps yet.
          </p>
        ) : (
          <ol className="space-y-2" data-testid="step-progress-list">
            {ordered.map((step) => (
              <li
                key={step.id}
                className="flex items-start gap-3 rounded-lg border border-border p-3"
                data-testid="progress-step"
                data-step-index={step.stepIndex}
              >
                <span className="mt-0.5 w-5 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                  {step.stepIndex + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <StepTypeBadge type={step.type} />
                    <StepStatusBadge status={step.status} />
                    {step.tokensUsed > 0 && (
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                        {formatTokens(step.tokensUsed)} tok
                      </span>
                    )}
                  </div>
                  {/* Untrusted descriptor — inert text. */}
                  <p className="text-sm leading-relaxed text-foreground/80 break-words">
                    {stepSummary(step.args)}
                  </p>
                  {step.error && (
                    <p
                      className="mt-1 text-xs text-destructive break-words"
                      data-testid="progress-step-error"
                    >
                      {step.error}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
