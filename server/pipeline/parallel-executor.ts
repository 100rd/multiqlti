import type { Gateway } from "../gateway/index";
import type { TeamRegistry } from "../teams/registry";
import type { WsManager } from "../ws/manager";
import type {
  PipelineStageConfig,
  SubTask,
  SubTaskResult,
  ParallelExecutionMeta,
  StageContext,
  TeamResult,
} from "@shared/types";
import { Splitter } from "./splitter";
import { Merger } from "./merger";
import { truncateToTokenBudget } from "./token-budget";
import { estimateCostUsd } from "@shared/constants";
import { pickCheapestModelSlug } from "./model-tier-router";

export interface ParallelStageResult {
  output: Record<string, unknown>;
  tokensUsed: number;
  raw: string;
  meta: ParallelExecutionMeta;
}

function buildSubtaskInput(subtask: SubTask, maxTokens?: number): Record<string, unknown> {
  const contextNote = subtask.context.length > 0
    ? `\n\nContext:\n${subtask.context.join("\n")}`
    : "";
  const raw = `${subtask.description}${contextNote}`;
  const taskDescription = maxTokens !== undefined
    ? truncateToTokenBudget(raw, maxTokens)
    : raw;
  return { taskDescription };
}

function stageInputToString(input: Record<string, unknown>): string {
  if (typeof input.taskDescription === "string") return input.taskDescription;
  return JSON.stringify(input);
}

export class ParallelExecutor {
  private gateway: Gateway;
  private teamRegistry: TeamRegistry;
  private wsManager: WsManager;

  constructor(gateway: Gateway, teamRegistry: TeamRegistry, wsManager: WsManager) {
    this.gateway = gateway;
    this.teamRegistry = teamRegistry;
    this.wsManager = wsManager;
  }

  async executeParallel(
    stage: PipelineStageConfig,
    stageInput: Record<string, unknown>,
    context: StageContext,
    stageId: string,
  ): Promise<ParallelStageResult | null> {
    const parallelConfig = stage.parallel;
    if (!parallelConfig?.enabled) return null;

    const inputStr = stageInputToString(stageInput);
    const primaryModel = stage.modelSlug ?? "mock";
    const splitter = new Splitter(this.gateway, parallelConfig);
    const plan = await splitter.split(inputStr, stage.teamId, primaryModel);

    if (!plan.shouldSplit || plan.subtasks.length === 0) return null;

    // Surface cost-check warning via WS if applicable
    if (plan.preCheck?.costAction === "warn" && plan.preCheck.costMessage) {
      this.broadcastCostWarning(context.runId, stageId, {
        estimatedUsd: plan.preCheck.estimatedCostUsd,
        message: plan.preCheck.costMessage,
      });
    }

    this.broadcastSplit(context.runId, stageId, plan.subtasks, plan.preCheck);

    // ── Run subtasks with token-budget enforcement & cumulative cost abort ───
    const blockLimitUsd = parallelConfig.costThreshold?.blockUsd;
    const subtaskResults = await this.runSubtasksWithBudget(
      plan.subtasks,
      stage,
      context,
      stageId,
      parallelConfig.maxTokensPerSubtask,
      blockLimitUsd,
    );

    const succeeded = subtaskResults.filter((r): r is SubTaskResult => r !== null);
    const failedCount = subtaskResults.length - succeeded.length;

    if (succeeded.length === 0) {
      throw new Error(`All ${plan.subtasks.length} parallel subtasks failed`);
    }

    // ── Merge: use primary model (not cheap model) ───────────────────────────
    const mergerModelSlug = parallelConfig.mergerModelSlug ?? primaryModel;
    const merger = new Merger();
    const mergedOutput = await merger.merge(
      succeeded,
      parallelConfig.mergeStrategy,
      stage.teamId,
      mergerModelSlug,
      this.gateway,
    );

    const totalTokens = succeeded.reduce((sum, r) => sum + r.tokensUsed, 0);

    this.broadcastMerged(context.runId, stageId, {
      strategy: parallelConfig.mergeStrategy,
      subtaskCount: succeeded.length,
      totalTokens,
    });

    const meta: ParallelExecutionMeta = {
      parallelExecution: true,
      subtaskCount: plan.subtasks.length,
      succeededCount: succeeded.length,
      failedCount,
      totalTokens,
      sharding: plan.preCheck
        ? {
            mode: plan.preCheck.shardingMode,
            shardCount: plan.preCheck.shardCount,
            complexityScore: plan.preCheck.complexityScore,
          }
        : undefined,
    };

    const team = this.teamRegistry.getTeam(stage.teamId);
    const parsedOutput = team.parseOutput(mergedOutput);

    return {
      output: { ...parsedOutput, raw: mergedOutput, parallelMeta: meta },
      tokensUsed: totalTokens,
      raw: mergedOutput,
      meta,
    };
  }

  /**
   * Run all subtasks in parallel with per-subtask token-budget truncation and
   * cumulative cost enforcement.  When the cumulative cost limit is exceeded,
   * remaining subtasks that haven't started yet receive an abort signal via a
   * shared flag — tasks already in-flight complete normally (Promise.allSettled
   * semantics), but pending slots return null.
   *
   * NOTE: Because all subtasks are launched concurrently with Promise.allSettled,
   * we cannot cancel already-launched promises.  We therefore abort at the
   * per-result level: once the tracker fires, we mark subsequent results as null
   * when collecting. A future iteration could use a streaming/sequential approach
   * to abort earlier.
   */
  private async runSubtasksWithBudget(
    subtasks: SubTask[],
    stage: PipelineStageConfig,
    context: StageContext,
    stageId: string,
    maxTokensPerSubtask: number | undefined,
    blockLimitUsd: number | undefined,
  ): Promise<Array<SubTaskResult | null>> {
    const subtaskPromises = subtasks.map((subtask) =>
      this.runSingleSubtask(subtask, stage, context, stageId, maxTokensPerSubtask),
    );

    const settledResults = await Promise.allSettled(subtaskPromises);

    let cumulativeCostUsd = 0;
    let aborted = false;
    let abortedCount = 0;
    let completedCount = 0;

    return settledResults.map((result) => {
      if (aborted) {
        abortedCount++;
        return null;
      }

      if (result.status === "rejected") {
        return null;
      }

      const subtaskResult = result.value;
      completedCount++;

      // Accumulate cost estimate for this subtask
      if (blockLimitUsd !== undefined) {
        const subtaskCost = estimateCostUsd(
          subtaskResult.modelSlug,
          subtaskResult.tokensUsed,
          subtaskResult.tokensUsed, // approximate output ≈ input
        );
        cumulativeCostUsd += subtaskCost;

        if (cumulativeCostUsd >= blockLimitUsd && !aborted) {
          aborted = true;
          this.broadcastCostExceeded(context.runId, stageId, {
            cumulativeCostUsd,
            limitUsd: blockLimitUsd,
            completedSubtasks: completedCount,
            abortedSubtasks: subtasks.length - completedCount,
          });
        }
      }

      return subtaskResult;
    });
  }

  private async runSingleSubtask(
    subtask: SubTask,
    stage: PipelineStageConfig,
    context: StageContext,
    stageId: string,
    maxTokensPerSubtask: number | undefined,
  ): Promise<SubTaskResult> {
    // ── Model-tier routing: use cheap model for chunks ────────────────────────
    const primaryModel = stage.modelSlug ?? "mock";
    const cheapModel = pickCheapestModelSlug(primaryModel, primaryModel);
    const modelSlug = subtask.suggestedModel ?? cheapModel;

    this.broadcastSubtaskStarted(context.runId, stageId, subtask.id, modelSlug);

    const start = Date.now();

    const team = this.teamRegistry.getTeam(stage.teamId);
    const subtaskInput = buildSubtaskInput(subtask, maxTokensPerSubtask);
    const subtaskContext: StageContext = {
      ...context,
      modelSlug,
    };

    let result: TeamResult;
    try {
      result = await team.execute(subtaskInput, subtaskContext);
    } catch (err) {
      const durationMs = Date.now() - start;
      this.broadcastSubtaskCompleted(context.runId, stageId, subtask.id, 0, durationMs);
      throw err;
    }

    const durationMs = Date.now() - start;
    const outputStr = typeof result.output.raw === "string"
      ? result.output.raw
      : JSON.stringify(result.output);

    this.broadcastSubtaskCompleted(
      context.runId,
      stageId,
      subtask.id,
      result.tokensUsed,
      durationMs,
    );

    return {
      subtask,
      output: outputStr,
      tokensUsed: result.tokensUsed,
      modelSlug,
      durationMs,
    };
  }

  private broadcastSplit(
    runId: string,
    stageId: string,
    subtasks: SubTask[],
    preCheck?: { shardCount: number; complexityScore: number; costAction: string; estimatedCostUsd: number } | undefined,
  ): void {
    this.wsManager.broadcastToRun(runId, {
      type: "parallel:split",
      runId,
      payload: {
        stageId,
        planId: `${stageId}-plan`,
        subtasks,
        sharding: preCheck
          ? {
              shardCount: preCheck.shardCount,
              complexityScore: preCheck.complexityScore,
              costAction: preCheck.costAction,
              estimatedCostUsd: preCheck.estimatedCostUsd,
            }
          : undefined,
      },
      timestamp: new Date().toISOString(),
    });
  }

  private broadcastSubtaskStarted(
    runId: string,
    stageId: string,
    subtaskId: string,
    modelSlug: string,
  ): void {
    this.wsManager.broadcastToRun(runId, {
      type: "parallel:subtask:started",
      runId,
      payload: { stageId, subtaskId, modelSlug },
      timestamp: new Date().toISOString(),
    });
  }

  private broadcastSubtaskCompleted(
    runId: string,
    stageId: string,
    subtaskId: string,
    tokensUsed: number,
    durationMs: number,
  ): void {
    this.wsManager.broadcastToRun(runId, {
      type: "parallel:subtask:completed",
      runId,
      payload: { stageId, subtaskId, tokensUsed, durationMs },
      timestamp: new Date().toISOString(),
    });
  }

  private broadcastMerged(
    runId: string,
    stageId: string,
    info: { strategy: string; subtaskCount: number; totalTokens: number },
  ): void {
    this.wsManager.broadcastToRun(runId, {
      type: "parallel:merged",
      runId,
      payload: {
        stageId,
        strategy: info.strategy,
        subtaskCount: info.subtaskCount,
        totalTokens: info.totalTokens,
      },
      timestamp: new Date().toISOString(),
    });
  }

  private broadcastCostWarning(
    runId: string,
    stageId: string,
    info: { estimatedUsd: number; message: string },
  ): void {
    this.wsManager.broadcastToRun(runId, {
      type: "parallel:cost:warning",
      runId,
      payload: {
        stageId,
        estimatedUsd: info.estimatedUsd,
        message: info.message,
      },
      timestamp: new Date().toISOString(),
    });
  }

  private broadcastCostExceeded(
    runId: string,
    stageId: string,
    info: {
      cumulativeCostUsd: number;
      limitUsd: number;
      completedSubtasks: number;
      abortedSubtasks: number;
    },
  ): void {
    this.wsManager.broadcastToRun(runId, {
      type: "parallel:cost:exceeded",
      runId,
      payload: {
        stageId,
        cumulativeCostUsd: info.cumulativeCostUsd,
        limitUsd: info.limitUsd,
        completedSubtasks: info.completedSubtasks,
        abortedSubtasks: info.abortedSubtasks,
      },
      timestamp: new Date().toISOString(),
    });
  }
}
