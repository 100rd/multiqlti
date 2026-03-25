import { Redis } from "ioredis";

let redis: Redis | null = null;

/**
 * Returns a shared Redis connection for the worker queue.
 * Returns null when REDIS_URL is not configured (queue disabled).
 *
 * Uses `maxRetriesPerRequest: null` as required by BullMQ workers.
 */
export function getRedisConnection(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy(times: number) {
        // Exponential back-off capped at 10 seconds
        return Math.min(times * 500, 10_000);
      },
    });
  }
  return redis;
}

/**
 * Gracefully close the shared Redis connection.
 * Safe to call even when no connection exists.
 */
export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
