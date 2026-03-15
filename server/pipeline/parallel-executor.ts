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

export interface ParallelStageResult {
  output: Record<string, unknown>;
  tokensUsed: number;
  raw: string;
  meta: ParallelExecutionMeta;
}

function buildSubtaskInput(subtask: SubTask): Record<string, unknown> {
  const contextNote = subtask.context.length > 0
    ? `\n\nContext:\n${subtask.context.join("\n")}`
    : "";
  return { taskDescription: `${subtask.description}${contextNote}` };
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
    const splitter = new Splitter(this.gateway, parallelConfig);
    const plan = await splitter.split(inputStr, stage.teamId);

    if (!plan.shouldSplit || plan.subtasks.length === 0) return null;

    this.broadcastSplit(context.runId, stageId, plan.subtasks);

    const subtaskResults = await this.runSubtasksInParallel(
      plan.subtasks,
      stage,
      context,
      stageId,
    );

    const succeeded = subtaskResults.filter((r): r is SubTaskResult => r !== null);
    const failedCount = subtaskResults.length - succeeded.length;

    if (succeeded.length === 0) {
      throw new Error(`All ${plan.subtasks.length} parallel subtasks failed`);
    }

    const mergerModelSlug = parallelConfig.mergerModelSlug ?? stage.modelSlug;
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

  private async runSubtasksInParallel(
    subtasks: SubTask[],
    stage: PipelineStageConfig,
    context: StageContext,
    stageId: string,
  ): Promise<Array<SubTaskResult | null>> {
    const subtaskPromises = subtasks.map((subtask) =>
      this.runSingleSubtask(subtask, stage, context, stageId),
    );

    const settledResults = await Promise.allSettled(subtaskPromises);

    return settledResults.map((result) => {
      if (result.status === "fulfilled") return result.value;
      return null;
    });
  }

  private async runSingleSubtask(
    subtask: SubTask,
    stage: PipelineStageConfig,
    context: StageContext,
    stageId: string,
  ): Promise<SubTaskResult> {
    const modelSlug = subtask.suggestedModel ?? stage.modelSlug;

    this.broadcastSubtaskStarted(context.runId, stageId, subtask.id, modelSlug);

    const start = Date.now();

    const team = this.teamRegistry.getTeam(stage.teamId);
    const subtaskInput = buildSubtaskInput(subtask);
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

  private broadcastSplit(runId: string, stageId: string, subtasks: SubTask[]): void {
    this.wsManager.broadcastToRun(runId, {
      type: "parallel:split",
      runId,
      payload: { stageId, planId: `${stageId}-plan`, subtasks },
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
}
