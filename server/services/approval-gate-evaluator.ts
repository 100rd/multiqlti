import type { ApprovalGateConfig, AutoApproveCondition } from "@shared/types";
import type { StageExecution, LlmRequest } from "@shared/schema";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GateEvaluationInput {
  gateConfig: ApprovalGateConfig;
  stageExecution: StageExecution;
  /** LLM requests for this specific stage execution */
  stageLlmRequests: LlmRequest[];
}

export interface GateEvaluationResult {
  shouldAutoApprove: boolean;
  reason: string;
}

// ─── Field Value Extraction ─────────────────────────────────────────────────

function extractFieldValue(
  field: AutoApproveCondition["field"],
  stageExecution: StageExecution,
  llmRequests: LlmRequest[],
): number | string {
  switch (field) {
    case "cost":
      return llmRequests.reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0);
    case "tokens":
      return llmRequests.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);
    case "duration":
      return computeDurationMs(stageExecution);
    case "status":
      return stageExecution.status;
  }
}

function computeDurationMs(stageExecution: StageExecution): number {
  if (!stageExecution.startedAt || !stageExecution.completedAt) return 0;
  const start = new Date(stageExecution.startedAt).getTime();
  const end = new Date(stageExecution.completedAt).getTime();
  return Math.max(0, end - start);
}

// ─── Condition Evaluation (Declarative Only -- VETO-2) ──────────────────────

function compareValues(
  actual: number | string,
  operator: AutoApproveCondition["operator"],
  expected: number | string,
): boolean {
  // For numeric comparisons, coerce both sides to numbers
  if (typeof actual === "number" || typeof expected === "number") {
    const a = Number(actual);
    const b = Number(expected);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    return applyNumericOperator(a, operator, b);
  }
  // String comparison: only "eq" is meaningful
  if (operator === "eq") return actual === expected;
  return false;
}

function applyNumericOperator(
  a: number,
  operator: AutoApproveCondition["operator"],
  b: number,
): boolean {
  switch (operator) {
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
    case "eq":
      return a === b;
  }
}

function evaluateSingleCondition(
  condition: AutoApproveCondition,
  stageExecution: StageExecution,
  llmRequests: LlmRequest[],
): { passed: boolean; detail: string } {
  const actual = extractFieldValue(condition.field, stageExecution, llmRequests);
  const passed = compareValues(actual, condition.operator, condition.value);
  const detail = `${condition.field} ${condition.operator} ${condition.value} (actual: ${actual})`;
  return { passed, detail };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Evaluates auto-approve conditions for a gate using AND logic.
 * All conditions must pass for auto-approval.
 * Uses declarative field/operator/value evaluation only (no eval/Function).
 */
export function evaluateAutoApproveConditions(
  input: GateEvaluationInput,
): GateEvaluationResult {
  const { gateConfig, stageExecution, stageLlmRequests } = input;

  if (gateConfig.type !== "auto" || !gateConfig.conditions?.length) {
    return { shouldAutoApprove: false, reason: "No auto-approve conditions configured" };
  }

  const results = gateConfig.conditions.map((c) =>
    evaluateSingleCondition(c, stageExecution, stageLlmRequests),
  );

  const allPassed = results.every((r) => r.passed);
  const details = results.map((r) => `${r.passed ? "PASS" : "FAIL"}: ${r.detail}`);

  if (allPassed) {
    return {
      shouldAutoApprove: true,
      reason: `All conditions met: ${details.join("; ")}`,
    };
  }

  const failedDetails = results
    .filter((r) => !r.passed)
    .map((r) => r.detail);

  return {
    shouldAutoApprove: false,
    reason: `Conditions not met: ${failedDetails.join("; ")}`,
  };
}
