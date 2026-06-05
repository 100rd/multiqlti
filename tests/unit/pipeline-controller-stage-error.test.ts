/**
 * Controller-level test for issue #342 — when a DAG stage throws, the catch
 * block in PipelineController must persist the error message onto the stage
 * execution row (not just broadcast it over WebSocket / write it to traces).
 *
 * Drives the real `makeDAGStageExecuteFn` catch path against MemStorage with a
 * team stub whose `execute()` throws. The queue module is mocked so the
 * controller imports without a live Redis/BullMQ (ioredis) connection.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../server/queue/index.js", () => ({
  isQueueEnabled: () => false,
  StageQueueProducer: class {},
  getRedisConnection: () => null,
}));

import { PipelineController } from "../../server/controller/pipeline-controller.js";
import { MemStorage } from "../../server/storage.js";
import type { TeamRegistry } from "../../server/teams/registry.js";
import type { WsManager } from "../../server/ws/manager.js";
import type { DAGStage } from "../../shared/types.js";
import type { PipelineRun } from "../../shared/schema.js";

const PROVIDER_ERROR = "provider 500: model crashed during inference";

const DAG_STAGE_ID = "dag-stage-1";

function makeThrowingTeamRegistry(): TeamRegistry {
  return {
    getTeam: () => ({
      execute: async () => {
        throw new Error(PROVIDER_ERROR);
      },
    }),
  } as unknown as TeamRegistry;
}

function makeWsManager(): WsManager {
  return { broadcastToRun: vi.fn() } as unknown as WsManager;
}

const dagStage: DAGStage = {
  id: DAG_STAGE_ID,
  teamId: "planning",
  modelSlug: "mock",
  enabled: true,
  position: { x: 0, y: 0 },
};

describe("PipelineController DAG stage failure (#342)", () => {
  it("persists the thrown error onto the stage execution row", async () => {
    const storage = new MemStorage();
    const controller = new PipelineController(
      storage,
      makeThrowingTeamRegistry(),
      makeWsManager(),
    );

    const pipeline = await storage.createPipeline({ name: "P", stages: [] });
    const run = await storage.createPipelineRun({
      pipelineId: pipeline.id,
      status: "running",
      input: "i",
      currentStageIndex: 0,
      dagMode: true,
    });
    const stageExec = await storage.createStageExecution({
      runId: run.id,
      stageIndex: 0,
      teamId: "planning",
      modelSlug: "mock",
      status: "pending",
      input: {},
      dagStageId: DAG_STAGE_ID,
    });

    // Reach the private DAG execute factory the DAGExecutor would call.
    const execute = (
      controller as unknown as {
        makeDAGStageExecuteFn: (
          r: PipelineRun,
        ) => (
          r: PipelineRun,
          s: DAGStage,
          input: Record<string, unknown>,
          stageIndex: number,
          dagStageId: string,
        ) => Promise<{ output: Record<string, unknown>; failed: boolean }>;
      }
    ).makeDAGStageExecuteFn(run);

    const result = await execute(run, dagStage, {}, 0, DAG_STAGE_ID);

    expect(result.failed).toBe(true);

    const [persisted] = await storage.getStageExecutions(run.id);
    expect(persisted.id).toBe(stageExec.id);
    expect(persisted.status).toBe("failed");
    expect(persisted.error).toBe(PROVIDER_ERROR);
  });
});
