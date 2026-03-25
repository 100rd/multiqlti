import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export interface StageJobData {
  runId: string;
  stageIndex: number;
  stageConfig: Record<string, unknown>;
  input: string;
}

export const STAGE_QUEUE_NAME = "stage:execute";

/**
 * Enqueues pipeline stage jobs onto the BullMQ queue for out-of-process execution.
 * Jobs are configured with exponential back-off retries and automatic cleanup.
 */
export class StageQueueProducer {
  private queue: Queue;

  constructor(connection: Redis) {
    this.queue = new Queue(STAGE_QUEUE_NAME, { connection });
  }

  /**
   * Add a stage execution job to the queue.
   * Returns the BullMQ job ID.
   */
  async enqueueStage(data: StageJobData): Promise<string> {
    const job = await this.queue.add("execute", data, {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    });
    return job.id!;
  }

  /**
   * Query the current state of a previously enqueued job.
   * Returns BullMQ job state or "unknown" if the job no longer exists.
   */
  async getJobStatus(jobId: string): Promise<string> {
    const job = await this.queue.getJob(jobId);
    if (!job) return "unknown";
    return await job.getState();
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
