/**
 * Token Budget Enforcement — Phase 6.12.3
 *
 * Provides two enforcement mechanisms:
 *
 * 1. Per-subtask truncation
 *    If a subtask's input exceeds `maxTokensPerSubtask`, the input is truncated
 *    to fit within the budget and a brief summary marker is appended so the
 *    model knows content was cut.
 *
 * 2. Cumulative cost abort
 *    As subtasks complete the executor tracks cumulative spend.  If the running
 *    total exceeds the configured block limit, remaining (not-yet-started)
 *    subtasks are cancelled and a structured `parallel:cost:exceeded` WS event
 *    is broadcast.
 */

import { estimateTokenCount } from "./complexity-estimator";

// ─── Per-subtask truncation ───────────────────────────────────────────────────

const TRUNCATION_NOTICE =
  "\n\n[NOTE: Input was truncated to fit within the token budget. " +
  "Respond based on the content above; additional context was omitted.]";

/**
 * Truncate `input` to `maxTokens` tokens (using the ≈4 chars/token heuristic).
 * Appends a truncation notice so the model is aware.
 *
 * Returns the original string unchanged when it already fits within budget.
 * Returns an empty string + notice when `maxTokens` is 0 (edge case: budget
 * exhausted before the first character).
 */
export function truncateToTokenBudget(input: string, maxTokens: number): string {
  if (maxTokens <= 0) {
    return TRUNCATION_NOTICE.trimStart();
  }

  const currentTokens = estimateTokenCount(input);
  if (currentTokens <= maxTokens) {
    return input;
  }

  // Allow room for the truncation notice itself
  const noticeTokens = estimateTokenCount(TRUNCATION_NOTICE);
  const targetTokens = Math.max(0, maxTokens - noticeTokens);
  const charLimit = targetTokens * 4;

  return input.slice(0, charLimit) + TRUNCATION_NOTICE;
}

// ─── Cumulative cost tracker ──────────────────────────────────────────────────

export interface CostExceededPayload {
  runId: string;
  stageId: string;
  cumulativeCostUsd: number;
  limitUsd: number;
  completedSubtasks: number;
  abortedSubtasks: number;
}

/**
 * Mutable tracker that accumulates cost across subtask results.
 * Thread-safe for single-event-loop Node.js — no mutex needed.
 */
export class CumulativeCostTracker {
  private totalCostUsd = 0;
  private completedCount = 0;
  private aborted = false;

  constructor(private readonly blockLimitUsd: number | undefined) {}

  /**
   * Record the cost of a completed subtask.
   * @returns `true` when the limit is exceeded and remaining work should abort.
   */
  record(costUsd: number): boolean {
    this.totalCostUsd += costUsd;
    this.completedCount += 1;

    if (
      this.blockLimitUsd !== undefined &&
      this.totalCostUsd >= this.blockLimitUsd &&
      !this.aborted
    ) {
      this.aborted = true;
      return true;
    }
    return false;
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  get totalUsd(): number {
    return this.totalCostUsd;
  }

  get completed(): number {
    return this.completedCount;
  }
}
