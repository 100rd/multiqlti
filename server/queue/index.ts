export { getRedisConnection, closeRedis } from "./connection.js";
export { StageQueueProducer, STAGE_QUEUE_NAME } from "./producer.js";
export type { StageJobData } from "./producer.js";
export { createStageWorker } from "./stage-worker.js";
export type { StageJobResult } from "./stage-worker.js";

/**
 * Feature flag check: worker queue is enabled only when both
 * MULTI_FEATURES_WORKER_QUEUE=true AND a valid REDIS_URL are set.
 */
export function isQueueEnabled(): boolean {
  return (
    process.env.MULTI_FEATURES_WORKER_QUEUE === "true" &&
    !!process.env.REDIS_URL
  );
}
