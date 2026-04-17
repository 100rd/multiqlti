/**
 * Shared types for the federation transport benchmark harness.
 *
 * All adapters implement TransportAdapter. The ScenarioRunner drives each
 * adapter through a standard set of scenarios and collects BenchmarkResult
 * objects that the Reporter renders into a comparison matrix.
 */

/** A single message transmitted during benchmarking. */
export interface BenchMessage {
  id: string;
  payload: Record<string, unknown>;
  sentAt: number; // ms since epoch
}

/** Per-message latency sample collected during a benchmark run. */
export interface LatencySample {
  messageId: string;
  latencyMs: number;
  success: boolean;
  droppedByPacketLoss?: boolean;
}

/** Throughput metrics for a benchmark run. */
export interface ThroughputMetrics {
  messagesPerSecond: number;
  bytesPerSecond: number;
  totalMessages: number;
  totalDurationMs: number;
}

/** Reconnect metrics collected during partition/recovery scenarios. */
export interface ReconnectMetrics {
  partitionDetectedMs: number; // time from partition to detection
  reconnectAttempts: number;
  reconnectDurationMs: number; // time from recovery start to stable connection
  messagesDropped: number;
  messagesRedelivered: number;
}

/** Full result for one scenario run against one adapter. */
export interface BenchmarkResult {
  transport: string;
  scenario: ScenarioName;
  latency: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    meanMs: number;
    minMs: number;
    maxMs: number;
  };
  throughput: ThroughputMetrics;
  reconnect?: ReconnectMetrics;
  errorRate: number; // 0–1
  samples: LatencySample[];
}

/** Named scenarios the harness can execute. */
export type ScenarioName =
  | "normal"
  | "packet-loss-5pct"
  | "partition-recovery"
  | "burst-throughput"
  | "sustained-load";

/** Configuration for a scenario run. */
export interface ScenarioConfig {
  name: ScenarioName;
  messageCount: number;
  messageSizeBytes: number;
  concurrency: number;
  packetLossRate: number; // 0–1, simulated
  partitionDurationMs?: number; // for partition scenarios
  burstSize?: number; // messages in burst before pause
}

/**
 * Common interface that every transport adapter must implement.
 * Adapters may simulate the underlying transport rather than
 * making real network calls (SPIKE mode).
 */
export interface TransportAdapter {
  /** Human-readable name for the transport. */
  readonly name: string;

  /** Brief description of the transport and its characteristics. */
  readonly description: string;

  /** Initialize the adapter (bind ports, create connections, etc.). */
  setup(): Promise<void>;

  /**
   * Send a message and measure round-trip latency.
   * Returns a LatencySample — if the adapter simulates packet loss it
   * should set droppedByPacketLoss=true instead of throwing.
   */
  send(msg: BenchMessage, lossRate: number): Promise<LatencySample>;

  /** Simulate a network partition (stop accepting/sending messages). */
  partition(): Promise<void>;

  /** Recover from a simulated partition. */
  recover(): Promise<ReconnectMetrics>;

  /** Tear down all resources created during setup. */
  teardown(): Promise<void>;
}
