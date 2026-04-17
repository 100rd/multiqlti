/**
 * NATS (core + JetStream) transport adapter.
 *
 * Simulates NATS characteristics without requiring a running NATS server.
 * Real client: nats.ws (browser) / nats (Node.js) — both at v2.x.
 *
 * Key characteristics:
 * - Core NATS: fire-and-forget pub/sub, no persistence, sub-millisecond RTT
 * - JetStream: durable consumers, exactly-once delivery via Ack + sequence IDs
 * - Built-in clustering with RAFT consensus (no external coordinator)
 * - TLS + NKeys (Ed25519) + Decentralized JWT auth
 * - Max payload: 1 MiB by default (configurable to 64 MiB)
 * - Multi-tenancy via Accounts isolation
 * - Reconnect: automatic with configurable retry + reconnect buffer (default 8 MiB)
 * - NAT traversal: requires NATS server reachable on known port; no built-in NAT hole-punching
 * - TS client maturity: nats.deno/nats.js — production-grade, maintained by NATS.io team
 */

import type {
  TransportAdapter,
  BenchMessage,
  LatencySample,
  ReconnectMetrics,
} from "../types.js";

/** Simulated network parameters for NATS JetStream. */
const BASE_LATENCY_MS = 0.3; // NATS is optimized for low latency
const LATENCY_JITTER_MS = 0.2;
const JS_ACK_OVERHEAD_MS = 0.1; // JetStream acknowledgment round-trip
const RECONNECT_MS = 250; // NATS client reconnects very quickly
const RECONNECT_ATTEMPTS = 2; // Fast cluster failover

export class NatsAdapter implements TransportAdapter {
  readonly name = "nats-jetstream";
  readonly description =
    "NATS Core + JetStream: durable pub/sub with exactly-once delivery. " +
    "NKeys/JWT auth, TLS, built-in clustering via RAFT. " +
    "Node.js client: nats@2.x (npm). Sub-millisecond RTT on LAN. " +
    "Reconnect buffer preserves messages during brief partitions.";

  private partitioned = false;
  private reconnectBuffer: BenchMessage[] = [];

  async setup(): Promise<void> {
    // Real setup: connect({ servers: ['nats://host:4222'], reconnect: true })
  }

  async send(msg: BenchMessage, lossRate: number): Promise<LatencySample> {
    if (this.partitioned) {
      // NATS reconnect buffer absorbs messages during short partitions
      this.reconnectBuffer.push(msg);
      return {
        messageId: msg.id,
        latencyMs: 0,
        success: false,
        droppedByPacketLoss: false,
      };
    }

    if (Math.random() < lossRate) {
      return {
        messageId: msg.id,
        latencyMs: 0,
        success: false,
        droppedByPacketLoss: true,
      };
    }

    // JetStream publish + ack round-trip
    const latencyMs =
      BASE_LATENCY_MS +
      JS_ACK_OVERHEAD_MS +
      Math.random() * LATENCY_JITTER_MS;

    await simulateDelay(latencyMs);

    return {
      messageId: msg.id,
      latencyMs,
      success: true,
    };
  }

  async partition(): Promise<void> {
    this.partitioned = true;
    this.reconnectBuffer = [];
  }

  async recover(): Promise<ReconnectMetrics> {
    const startMs = Date.now();
    const buffered = this.reconnectBuffer.length;

    // NATS reconnect is fast — single attempt with exponential back-off
    await simulateDelay(RECONNECT_MS * RECONNECT_ATTEMPTS);

    this.partitioned = false;

    // Flush reconnect buffer
    const redelivered = buffered;
    this.reconnectBuffer = [];

    return {
      partitionDetectedMs: 50, // NATS detects TCP close almost immediately
      reconnectAttempts: RECONNECT_ATTEMPTS,
      reconnectDurationMs: Date.now() - startMs,
      messagesDropped: 0, // JetStream guarantees no loss with ack
      messagesRedelivered: redelivered,
    };
  }

  async teardown(): Promise<void> {
    this.partitioned = false;
    this.reconnectBuffer = [];
  }
}

function simulateDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
