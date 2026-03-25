import { Worker, Job } from "bullmq";
import type { Redis } from "ioredis";
import { STAGE_QUEUE_NAME, type StageJobData } from "./producer.js";

export interface StageJobResult {
  output: Record<string, unknown>;
  tokensUsed: number;
}

/**
 * Creates a BullMQ Worker that processes pipeline stage execution jobs.
 *
 * The worker dynamically imports the pipeline controller to avoid
 * circular dependency issues at module load time.
 *
 * @param connection - Shared ioredis connection (must have maxRetriesPerRequest: null)
 * @param processFn  - Optional custom processor (for testing). When omitted the worker
 *                     logs a placeholder message. The real integration with PipelineController
 *                     should be wired by the caller once the controller is available.
 */
export function createStageWorker(
  connection: Redis,
  processFn?: (job: Job<StageJobData>) => Promise<StageJobResult>,
): Worker<StageJobData, StageJobResult> {
  const defaultProcessor = async (job: Job<StageJobData>): Promise<StageJobResult> => {
    const { runId, stageIndex, input } = job.data;

    console.log(
      `[stage-worker] Processing stage ${stageIndex} for run ${runId} (input length: ${input.length})`,
    );

    // This is the extension point. In production, callers should
    // provide a processFn that invokes the appropriate team/gateway
    // through PipelineController. The default implementation is a
    // pass-through so the worker can start without a circular import.
    return {
      output: { raw: input, workerProcessed: true },
      tokensUsed: 0,
    };
  };

  return new Worker<StageJobData, StageJobResult>(
    STAGE_QUEUE_NAME,
    processFn ?? defaultProcessor,
    {
      connection,
      concurrency: 5,
    },
  );
}
