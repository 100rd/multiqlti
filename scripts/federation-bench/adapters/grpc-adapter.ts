/**
 * gRPC bidirectional streaming transport adapter.
 *
 * Simulates gRPC characteristics using HTTP/2 bidirectional streams.
 * Real client: @grpc/grpc-js (Node.js pure-JS implementation).
 *
 * Key characteristics:
 * - HTTP/2 multiplexing: many logical streams over one TCP connection
 * - Bidirectional streaming with flow control
 * - Protobuf serialization: compact binary, 20–40% smaller than JSON
 * - mTLS built-in: both sides authenticate with certificates
 * - Reconnect: @grpc/grpc-js has built-in channel state machine with
 *   exponential back-off (IDLE → CONNECTING → READY → TRANSIENT_FAILURE)
 * - No built-in persistence — message loss possible during partition
 * - NAT: HTTP/2 requires persistent TCP; corporate proxies may strip HTTP/2
 *   and downgrade to HTTP/1.1 (CONNECT tunnel workaround possible)
 * - Multi-tenancy: per-call metadata for tenant ID; no native queue isolation
 * - TS client maturity: @grpc/grpc-js is the official Node.js impl, well maintained
 * - Proto compilation: requires protoc toolchain or ts-proto
 */

import type {
  TransportAdapter,
  BenchMessage,
  LatencySample,
  ReconnectMetrics,
} from "../types.js";

/** Simulated network parameters for gRPC over HTTP/2. */
const BASE_LATENCY_MS = 0.5; // HTTP/2 framing is slightly heavier than raw WS
const LATENCY_JITTER_MS = 0.3;
const PROTOBUF_SAVINGS_MS = -0.1; // protobuf is faster to serialize than JSON
const RECONNECT_BASE_MS = 1000; // gRPC back-off starts at 1 s
const RECONNECT_MAX_MS = 120_000; // gRPC default max backoff
const RECONNECT_ATTEMPTS = 2;

export class GrpcAdapter implements TransportAdapter {
  readonly name = "grpc-bidi-streaming";
  readonly description =
    "gRPC bidirectional streaming over HTTP/2. " +
    "Protobuf serialization, mTLS auth, flow control. " +
    "Node.js client: @grpc/grpc-js (npm). " +
    "Built-in reconnect state machine. No persistence — messages lost during partition.";

  private partitioned = false;
  private inFlightMessages: BenchMessage[] = [];

  async setup(): Promise<void> {
    // Real setup: load proto, create ChannelCredentials, construct stub
    // const client = new FederationServiceClient(
    //   'host:50051',
    //   grpc.credentials.createSsl(rootCerts, privateKey, certChain),
    // );
  }

  async send(msg: BenchMessage, lossRate: number): Promise<LatencySample> {
    if (this.partitioned) {
      // No reconnect buffer in base gRPC — messages are dropped
      this.inFlightMessages.push(msg);
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

    // HTTP/2 + protobuf serialization time
    const latencyMs =
      BASE_LATENCY_MS +
      PROTOBUF_SAVINGS_MS +
      Math.random() * LATENCY_JITTER_MS;

    await simulateDelay(Math.max(latencyMs, 0.1));

    return {
      messageId: msg.id,
      latencyMs: Math.max(latencyMs, 0.1),
      success: true,
    };
  }

  async partition(): Promise<void> {
    this.partitioned = true;
    this.inFlightMessages = [];
  }

  async recover(): Promise<ReconnectMetrics> {
    const startMs = Date.now();
    const dropped = this.inFlightMessages.length;

    // gRPC channel back-off: starts at 1s, exponential
    let delay = RECONNECT_BASE_MS;
    for (let i = 0; i < RECONNECT_ATTEMPTS; i++) {
      await simulateDelay(delay);
      delay = Math.min(delay * 1.6, RECONNECT_MAX_MS);
    }

    this.partitioned = false;
    this.inFlightMessages = [];

    return {
      partitionDetectedMs: 2000, // gRPC keepalive ping timeout (default: ~20s, tunable to 2s)
      reconnectAttempts: RECONNECT_ATTEMPTS,
      reconnectDurationMs: Date.now() - startMs,
      messagesDropped: dropped,
      messagesRedelivered: 0, // application must implement retry layer
    };
  }

  async teardown(): Promise<void> {
    this.partitioned = false;
    this.inFlightMessages = [];
  }
}

function simulateDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
