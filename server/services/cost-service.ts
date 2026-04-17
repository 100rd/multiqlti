/**
 * Cost Service — token budget enforcement and ledger recording.
 *
 * Responsibilities:
 *  - Record every billed LLM call in the cost_ledger (append-only).
 *  - Check workspace budgets before each call (soft warn / hard block).
 *  - Aggregate cost summaries for the reporting API.
 *  - Trigger alert thresholds for budget notifications.
 *
 * Fail-closed policy:
 *  - Ledger write failure → retry once synchronously.
 *  - Sustained failure → warn mode (log error, never throw to caller).
 */

import type { IStorage } from "../storage";
import { computeCostUsd } from "@shared/pricing";
import type {
  InsertCostLedger,
  CostLedgerRow,
  BudgetRow,
  BudgetPeriod,
} from "@shared/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecordCostInput {
  workspaceId: string;
  provider: string;
  model: string;
  pipelineRunId?: string | null;
  stageId?: string | null;
  promptTokens: number;
  completionTokens: number;
}

export interface BudgetCheckResult {
  /** Whether the call is allowed to proceed. */
  allowed: boolean;
  /** Human-readable warning message (present even when allowed). */
  warning?: string;
  /** Budget that triggered the decision, or undefined if none matched. */
  budget?: BudgetRow;
  /** USD spent in the current period (before this call). */
  periodToDateUsd: number;
  /** Estimated cost of the upcoming call. */
  estimatedCostUsd: number;
}

export interface CostSummaryPoint {
  date: string;      // ISO date "YYYY-MM-DD"
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ProviderBreakdown {
  provider: string;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  callCount: number;
}

export interface PipelineRollup {
  pipelineRunId: string;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  callCount: number;
}

export interface BudgetStatus {
  budget: BudgetRow;
  periodToDateUsd: number;
  usagePct: number;
  /** Alert thresholds that have been crossed. */
  crossedThresholds: number[];
}

export interface CostSummaryResponse {
  period: BudgetPeriod;
  periodStart: Date;
  periodEnd: Date;
  totalCostUsd: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  dailySeries: CostSummaryPoint[];
  byProvider: ProviderBreakdown[];
  topPipelines: PipelineRollup[];
  budgetStatuses: BudgetStatus[];
}

// ─── Period helpers ───────────────────────────────────────────────────────────

/** Compute [start, end) for a budget period anchored to `now`. */
export function getPeriodBounds(period: BudgetPeriod, now = new Date()): { start: Date; end: Date } {
  const start = new Date(now);
  const end = new Date(now);

  switch (period) {
    case "day":
      start.setUTCHours(0, 0, 0, 0);
      end.setUTCHours(23, 59, 59, 999);
      break;
    case "week": {
      // Anchor to Monday of current week
      const dayOfWeek = start.getUTCDay(); // 0=Sun
      const diff = (dayOfWeek === 0 ? -6 : 1 - dayOfWeek);
      start.setUTCDate(start.getUTCDate() + diff);
      start.setUTCHours(0, 0, 0, 0);
      end.setTime(start.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
      break;
    }
    case "month":
      start.setUTCDate(1);
      start.setUTCHours(0, 0, 0, 0);
      end.setUTCMonth(end.getUTCMonth() + 1, 0); // last day of month
      end.setUTCHours(23, 59, 59, 999);
      break;
  }

  return { start, end };
}

// ─── Cost Service ─────────────────────────────────────────────────────────────

export class CostService {
  constructor(private readonly storage: IStorage) {}

  /**
   * Pre-call budget check.
   *
   * Computes period-to-date spend for all budgets that apply to this call,
   * adds the estimated cost of the incoming call, and returns the strictest
   * matching budget decision:
   *  - hard budget exceeded → allowed=false (block)
   *  - soft budget exceeded → allowed=true + warning
   *  - threshold crossed    → allowed=true + warning
   *
   * Always returns `allowed=true` if no budgets are configured.
   */
  async checkBudget(params: {
    workspaceId: string;
    provider: string;
    model: string;
    estimatedPromptTokens: number;
    estimatedCompletionTokens: number;
  }): Promise<BudgetCheckResult> {
    const estimatedCostUsd = computeCostUsd(
      params.model,
      params.estimatedPromptTokens,
      params.estimatedCompletionTokens,
    );

    const allBudgets = await this.storage.getBudgetsByWorkspace(params.workspaceId);

    // Filter to budgets that apply to this provider (null = all)
    const applicable = allBudgets.filter(
      (b) => b.provider === null || b.provider === params.provider,
    );

    if (applicable.length === 0) {
      return { allowed: true, periodToDateUsd: 0, estimatedCostUsd };
    }

    let hardBlock: BudgetCheckResult | undefined;
    let softWarn: BudgetCheckResult | undefined;

    for (const budget of applicable) {
      const { start, end } = getPeriodBounds(budget.period as BudgetPeriod);
      const periodToDateUsd = await this.storage.getCostLedgerSum({
        workspaceId: params.workspaceId,
        provider: budget.provider ?? undefined,
        from: start,
        to: end,
      });

      const projected = periodToDateUsd + estimatedCostUsd;

      if (projected > budget.limitUsd) {
        const result: BudgetCheckResult = {
          allowed: !budget.hard,
          warning: budget.hard
            ? `Hard budget exceeded: ${budget.provider ?? "all providers"} ` +
              `${budget.period} limit $${budget.limitUsd.toFixed(4)} ` +
              `(projected $${projected.toFixed(4)})`
            : `Soft budget exceeded: ${budget.provider ?? "all providers"} ` +
              `${budget.period} limit $${budget.limitUsd.toFixed(4)} ` +
              `(projected $${projected.toFixed(4)})`,
          budget,
          periodToDateUsd,
          estimatedCostUsd,
        };

        if (budget.hard && !hardBlock) {
          hardBlock = result;
        } else if (!budget.hard && !softWarn) {
          softWarn = result;
        }
      } else {
        // Check notification thresholds
        const thresholds = (budget.notifyAtPct as number[]).sort((a, b) => b - a);
        for (const pct of thresholds) {
          const threshold = budget.limitUsd * (pct / 100);
          if (projected >= threshold && periodToDateUsd < threshold) {
            const result: BudgetCheckResult = {
              allowed: true,
              warning:
                `Budget alert: ${budget.provider ?? "all providers"} ${budget.period} ` +
                `budget is ${pct}% utilized ($${projected.toFixed(4)} of $${budget.limitUsd.toFixed(4)})`,
              budget,
              periodToDateUsd,
              estimatedCostUsd,
            };
            if (!softWarn) softWarn = result;
            break;
          }
        }
      }
    }

    // Hard block takes precedence over soft warn
    if (hardBlock) return hardBlock;
    if (softWarn) return softWarn;

    // No limit reached
    const { start, end } = getPeriodBounds(applicable[0].period as BudgetPeriod);
    const periodToDateUsd = await this.storage.getCostLedgerSum({
      workspaceId: params.workspaceId,
      from: start,
      to: end,
    });
    return { allowed: true, periodToDateUsd, estimatedCostUsd };
  }

  /**
   * Append an entry to the cost ledger.
   * Retries once on failure; on sustained failure logs and returns null.
   */
  async recordCost(input: RecordCostInput): Promise<CostLedgerRow | null> {
    const costUsd = computeCostUsd(input.model, input.promptTokens, input.completionTokens);

    const entry: InsertCostLedger = {
      workspaceId: input.workspaceId,
      provider: input.provider,
      model: input.model,
      pipelineRunId: input.pipelineRunId ?? null,
      stageId: input.stageId ?? null,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      costUsd,
    };

    try {
      return await this.storage.appendCostLedger(entry);
    } catch (firstErr) {
      console.warn("[cost-service] Ledger write failed, retrying:", firstErr);
      try {
        return await this.storage.appendCostLedger(entry);
      } catch (secondErr) {
        console.error("[cost-service] Sustained ledger write failure — warn mode:", secondErr);
        return null;
      }
    }
  }

  /**
   * Aggregate cost summary for a workspace over a given period.
   * Used by the reporting API and the UI.
   */
  async getSummary(
    workspaceId: string,
    period: BudgetPeriod,
    now = new Date(),
  ): Promise<CostSummaryResponse> {
    const { start, end } = getPeriodBounds(period, now);

    const rows = await this.storage.getCostLedgerRows({
      workspaceId,
      from: start,
      to: end,
    });

    // Aggregate totals
    let totalCostUsd = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    const dayMap = new Map<string, CostSummaryPoint>();
    const providerMap = new Map<string, ProviderBreakdown>();
    const pipelineMap = new Map<string, PipelineRollup>();

    for (const row of rows) {
      totalCostUsd += row.costUsd;
      totalPromptTokens += row.promptTokens;
      totalCompletionTokens += row.completionTokens;

      // Daily series
      const day = row.ts.toISOString().slice(0, 10);
      const dp = dayMap.get(day) ?? { date: day, costUsd: 0, promptTokens: 0, completionTokens: 0 };
      dp.costUsd += row.costUsd;
      dp.promptTokens += row.promptTokens;
      dp.completionTokens += row.completionTokens;
      dayMap.set(day, dp);

      // By provider
      const pb = providerMap.get(row.provider) ?? {
        provider: row.provider,
        costUsd: 0,
        promptTokens: 0,
        completionTokens: 0,
        callCount: 0,
      };
      pb.costUsd += row.costUsd;
      pb.promptTokens += row.promptTokens;
      pb.completionTokens += row.completionTokens;
      pb.callCount += 1;
      providerMap.set(row.provider, pb);

      // By pipeline
      if (row.pipelineRunId) {
        const pr = pipelineMap.get(row.pipelineRunId) ?? {
          pipelineRunId: row.pipelineRunId,
          costUsd: 0,
          promptTokens: 0,
          completionTokens: 0,
          callCount: 0,
        };
        pr.costUsd += row.costUsd;
        pr.promptTokens += row.promptTokens;
        pr.completionTokens += row.completionTokens;
        pr.callCount += 1;
        pipelineMap.set(row.pipelineRunId, pr);
      }
    }

    const dailySeries = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    const byProvider = Array.from(providerMap.values()).sort((a, b) => b.costUsd - a.costUsd);
    const topPipelines = Array.from(pipelineMap.values())
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 10);

    // Budget statuses
    const allBudgets = await this.storage.getBudgetsByWorkspace(workspaceId);
    const budgetStatuses: BudgetStatus[] = await Promise.all(
      allBudgets.map(async (budget) => {
        const { start: bs, end: be } = getPeriodBounds(budget.period as BudgetPeriod, now);
        const periodToDateUsd = await this.storage.getCostLedgerSum({
          workspaceId,
          provider: budget.provider ?? undefined,
          from: bs,
          to: be,
        });
        const usagePct = budget.limitUsd > 0 ? (periodToDateUsd / budget.limitUsd) * 100 : 0;
        const crossedThresholds = (budget.notifyAtPct as number[]).filter(
          (pct) => usagePct >= pct,
        );
        return { budget, periodToDateUsd, usagePct, crossedThresholds };
      }),
    );

    return {
      period,
      periodStart: start,
      periodEnd: end,
      totalCostUsd,
      totalPromptTokens,
      totalCompletionTokens,
      dailySeries,
      byProvider,
      topPipelines,
      budgetStatuses,
    };
  }

  /**
   * Build a CSV string from cost ledger rows for a given workspace + period.
   */
  async exportCsv(workspaceId: string, period: BudgetPeriod, now = new Date()): Promise<string> {
    const { start, end } = getPeriodBounds(period, now);
    const rows = await this.storage.getCostLedgerRows({ workspaceId, from: start, to: end });

    const header = "ts,provider,model,pipeline_run_id,stage_id,prompt_tokens,completion_tokens,cost_usd";
    const lines = rows.map((r) =>
      [
        r.ts.toISOString(),
        r.provider,
        r.model,
        r.pipelineRunId ?? "",
        r.stageId ?? "",
        r.promptTokens,
        r.completionTokens,
        r.costUsd.toFixed(8),
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );

    return [header, ...lines].join("\n");
  }
}
