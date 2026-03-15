/**
 * DAG Executor — Phase 6.2
 *
 * Executes a PipelineDAG by resolving topological order at runtime,
 * evaluating edge conditions, and running independent stages in parallel.
 *
 * Integration: PipelineController passes a `StageExecuteFn` callback so this
 * executor can invoke the existing per-stage logic without duplication.
 */
import type { IStorage } from "../storage";
import type { WsManager } from "../ws/manager";
import type { DAGStage, DAGEdge, PipelineDAG } from "@shared/types";
import type { PipelineRun } from "@shared/schema";
import { evaluateCondition } from "./dag-condition-evaluator";

/** Maximum number of stages executing in parallel to avoid API rate limit bursts. */
const MAX_PARALLEL_STAGES = 5;

/** Runtime state during a DAG execution. */
interface DAGExecutionState {
  completedStageIds: Set<string>;
  skippedStageIds: Set<string>;
  stageOutputs: Map<string, Record<string, unknown>>;
  activeStageIds: Set<string>;
  stageIndexCounter: number;
}

/**
 * Callback type: executes a single DAG stage.
 * Provided by PipelineController to avoid duplicating stage logic.
 */
export type StageExecuteFn = (
  run: PipelineRun,
  stage: DAGStage,
  stageInput: Record<string, unknown>,
  stageIndex: number,
  dagStageId: string,
) => Promise<{ output: Record<string, unknown>; failed: boolean }>;

/** Returns stages that are ready to execute given the current state. */
export function computeReadyStages(
  dag: PipelineDAG,
  state: DAGExecutionState,
): DAGStage[] {
  const ready: DAGStage[] = [];

  for (const stage of dag.stages) {
    if (!stage.enabled) continue;
    if (state.completedStageIds.has(stage.id)) continue;
    if (state.skippedStageIds.has(stage.id)) continue;
    if (state.activeStageIds.has(stage.id)) continue;

    const incoming = dag.edges.filter((e) => e.to === stage.id);

    if (incoming.length === 0) {
      ready.push(stage);
      continue;
    }

    const allParentsDone = incoming.every(
      (e) => state.completedStageIds.has(e.from) || state.skippedStageIds.has(e.from),
    );
    if (!allParentsDone) continue;

    const anyEdgePasses = incoming.some((e) => {
      if (!e.condition) return true;
      const parentOutput = state.stageOutputs.get(e.from) ?? {};
      return evaluateCondition(parentOutput, e.condition);
    });

    if (anyEdgePasses) {
      ready.push(stage);
    } else {
      state.skippedStageIds.add(stage.id);
    }
  }

  return ready;
}

/** Assembles input for a stage based on its parent outputs. */
export function assembleStageInput(
  stage: DAGStage,
  dag: PipelineDAG,
  state: DAGExecutionState,
  runInput: string,
): Record<string, unknown> {
  const incoming = dag.edges.filter((e) => e.to === stage.id);

  if (incoming.length === 0) {
    return { taskDescription: runInput };
  }

  if (incoming.length === 1) {
    return state.stageOutputs.get(incoming[0].from) ?? {};
  }

  // Multiple parents — merge all completed parent outputs keyed by stage ID
  const merged: Record<string, unknown> = {};
  for (const edge of incoming) {
    if (state.completedStageIds.has(edge.from)) {
      merged[edge.from] = state.stageOutputs.get(edge.from) ?? {};
    }
  }
  return merged;
}

export class DAGExecutor {
  constructor(
    private storage: IStorage,
    private wsManager: WsManager,
  ) {}

  async executeDAG(
    run: PipelineRun,
    dag: PipelineDAG,
    signal: AbortSignal,
    executeStage: StageExecuteFn,
  ): Promise<void> {
    const state: DAGExecutionState = {
      completedStageIds: new Set(),
      skippedStageIds: new Set(),
      stageOutputs: new Map(),
      activeStageIds: new Set(),
      stageIndexCounter: 0,
    };

    // Create stage execution records for all enabled stages upfront
    for (let i = 0; i < dag.stages.length; i++) {
      const stage = dag.stages[i];
      await this.storage.createStageExecution({
        runId: run.id,
        stageIndex: i,
        teamId: stage.teamId,
        modelSlug: stage.modelSlug,
        status: stage.enabled ? "pending" : "skipped",
        dagStageId: stage.id,
        input: {},
      });
      if (!stage.enabled) {
        state.skippedStageIds.add(stage.id);
      }
    }

    let failed = false;

    // Process waves until no ready stages remain
    while (!signal.aborted && !failed) {
      const ready = computeReadyStages(dag, state);
      if (ready.length === 0) break;

      // Cap parallel concurrency
      const batch = ready.slice(0, MAX_PARALLEL_STAGES);

      for (const stage of batch) {
        state.activeStageIds.add(stage.id);
        this.broadcast(run.id, {
          type: "dag:stage:ready",
          runId: run.id,
          payload: { stageId: stage.id, teamId: stage.teamId },
          timestamp: new Date().toISOString(),
        });
      }

      const results = await Promise.allSettled(
        batch.map(async (stage) => {
          const input = assembleStageInput(stage, dag, state, run.input);
          const idx = state.stageIndexCounter++;
          const result = await executeStage(run, stage, input, idx, stage.id);
          return { stage, result };
        }),
      );

      for (const settled of results) {
        if (settled.status === "fulfilled") {
          const { stage, result } = settled.value;
          state.activeStageIds.delete(stage.id);
          if (result.failed) {
            failed = true;
          } else {
            state.completedStageIds.add(stage.id);
            state.stageOutputs.set(stage.id, result.output);
          }
        } else {
          // Promise itself rejected — treat as failure
          failed = true;
          console.error("DAG stage execution error:", settled.reason);
        }
      }
    }

    // Broadcast any stages that were deferred-skipped due to no conditions passing
    for (const stage of dag.stages) {
      if (state.skippedStageIds.has(stage.id)) {
        this.broadcast(run.id, {
          type: "dag:stage:skipped",
          runId: run.id,
          payload: { stageId: stage.id },
          timestamp: new Date().toISOString(),
        });
      }
    }

    if (!failed && !signal.aborted) {
      this.broadcast(run.id, {
        type: "dag:completed",
        runId: run.id,
        payload: {
          completedStages: state.completedStageIds.size,
          skippedStages: state.skippedStageIds.size,
        },
        timestamp: new Date().toISOString(),
      });
    }
  }

  private broadcast(runId: string, event: { type: string; runId: string; payload: Record<string, unknown>; timestamp: string }): void {
    this.wsManager.broadcastToRun(runId, event as never);
  }
}
