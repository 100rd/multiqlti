/**
 * Redis Streams / BullMQ baseline adapter.
 *
 * Simulates the current federation transport which uses WebSockets with
 * HMAC-signed messages. The queue layer (BullMQ over Redis) adds persistent
 * job storage for stage execution.
 *
 * Baseline characteristics (derived from existing implementation):
 * - WebSocket framing overhead: ~50 bytes per message (JSON envelope)
 * - HMAC-SHA256 signing: ~0.05 ms CPU overhead per message
 * - Redis RTT on LAN: 0.3–2 ms
 * - BullMQ job enqueue: 1–3 ms (Redis call + Lua eval)
 * - Reconnect: manual, no built-in back-off beyond ioredis retryStrategy
 * - No native pub/sub multiplexing — one WS connection per peer
 * - Auth: HMAC-SHA256 per message, optional ECDH E2E encryption
 */

import crypto from "crypto";
import type {
  TransportAdapter,
  BenchMessage,
  LatencySample,
  ReconnectMetrics,
} from "../types.js";

/** Simulated network parameters for the Redis/WS baseline. */
const BASE_LATENCY_MS = 0.8; // median RTT on same-datacenter network
const LATENCY_JITTER_MS = 0.5; // max random jitter
const HMAC_OVERHEAD_MS = 0.05; // SHA256 signing cost
const REDIS_RTT_MS = 0.4; // Redis command RTT
const WS_FRAME_OVERHEAD_MS = 0.02; // WebSocket framing
const RECONNECT_BASE_MS = 500; // initial reconnect delay (ioredis retryStrategy)
const RECONNECT_ATTEMPTS = 3; // typical reconnect attempts needed

export class RedisBaselineAdapter implements TransportAdapter {
  readonly name = "redis-ws-baseline";
  readonly description =
    "Current transport: WebSocket + HMAC-SHA256 auth + optional ECDH E2E. " +
    "Queue layer: BullMQ over Redis Streams. " +
    "One WS connection per peer, manual reconnect via ioredis retryStrategy.";

  private partitioned = false;

  async setup(): Promise<void> {
    // No real server needed — simulation only
  }

  async send(msg: BenchMessage, lossRate: number): Promise<LatencySample> {
    if (this.partitioned) {
      return {
        messageId: msg.id,
        latencyMs: 0,
        success: false,
        droppedByPacketLoss: false,
      };
    }

    // Simulate packet loss
    if (Math.random() < lossRate) {
      return {
        messageId: msg.id,
        latencyMs: 0,
        success: false,
        droppedByPacketLoss: true,
      };
    }

    // Simulate processing time: HMAC sign + WS frame + Redis RTT
    const processingMs =
      HMAC_OVERHEAD_MS +
      WS_FRAME_OVERHEAD_MS +
      REDIS_RTT_MS +
      BASE_LATENCY_MS +
      Math.random() * LATENCY_JITTER_MS;

    // Compute a real HMAC to match actual CPU cost
    const hmac = crypto
      .createHmac("sha256", "bench-secret")
      .update(JSON.stringify(msg))
      .digest("hex");
    void hmac; // used only for CPU cost simulation

    await simulateDelay(processingMs);

    return {
      messageId: msg.id,
      latencyMs: processingMs,
      success: true,
    };
  }

  async partition(): Promise<void> {
    this.partitioned = true;
  }

  async recover(): Promise<ReconnectMetrics> {
    const startMs = Date.now();
    let attempts = 0;

    // Simulate exponential back-off reconnect (ioredis retryStrategy)
    let delay = RECONNECT_BASE_MS;
    while (attempts < RECONNECT_ATTEMPTS) {
      await simulateDelay(delay);
      delay = Math.min(delay * 1.5, 10_000);
      attempts++;
    }

    this.partitioned = false;
    const reconnectDurationMs = Date.now() - startMs;

    return {
      partitionDetectedMs: RECONNECT_BASE_MS, // ioredis detects via socket error
      reconnectAttempts: attempts,
      reconnectDurationMs,
      messagesDropped: 0, // BullMQ jobs are durable — they survive partition
      messagesRedelivered: 2, // BullMQ retries in-flight jobs
    };
  }

  async teardown(): Promise<void> {
    this.partitioned = false;
  }
}

function simulateDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
