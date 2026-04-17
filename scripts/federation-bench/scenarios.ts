/**
 * Benchmark scenario definitions and execution engine.
 *
 * Each ScenarioConfig describes a test case. The ScenarioRunner drives an
 * adapter through the scenario and collects a BenchmarkResult.
 */

import crypto from "crypto";
import type {
  TransportAdapter,
  BenchMessage,
  BenchmarkResult,
  LatencySample,
  ScenarioConfig,
  ScenarioName,
  ThroughputMetrics,
} from "./types.js";

export const DEFAULT_SCENARIOS: ScenarioConfig[] = [
  {
    name: "normal",
    messageCount: 200,
    messageSizeBytes: 512,
    concurrency: 1,
    packetLossRate: 0,
  },
  {
    name: "packet-loss-5pct",
    messageCount: 200,
    messageSizeBytes: 512,
    concurrency: 1,
    packetLossRate: 0.05,
  },
  {
    name: "partition-recovery",
    messageCount: 100,
    messageSizeBytes: 512,
    concurrency: 1,
    packetLossRate: 0,
    partitionDurationMs: 500,
  },
  {
    name: "burst-throughput",
    messageCount: 500,
    messageSizeBytes: 1024,
    concurrency: 10,
    packetLossRate: 0,
    burstSize: 50,
  },
  {
    name: "sustained-load",
    messageCount: 1000,
    messageSizeBytes: 256,
    concurrency: 5,
    packetLossRate: 0,
  },
];

/** Build a test message with the given approximate payload size. */
function buildMessage(sizeBytes: number): BenchMessage {
  // Pad payload to approximate the target size
  const padding = "x".repeat(Math.max(0, sizeBytes - 100));
  return {
    id: crypto.randomUUID(),
    payload: { padding, ts: Date.now() },
    sentAt: Date.now(),
  };
}

/** Compute percentile from sorted latency array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

/** Aggregate latency samples into summary statistics. */
function aggregateLatency(samples: LatencySample[]): BenchmarkResult["latency"] {
  const successful = samples
    .filter((s) => s.success)
    .map((s) => s.latencyMs)
    .sort((a, b) => a - b);

  if (successful.length === 0) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0, meanMs: 0, minMs: 0, maxMs: 0 };
  }

  const sum = successful.reduce((a, b) => a + b, 0);
  return {
    p50Ms: percentile(successful, 50),
    p95Ms: percentile(successful, 95),
    p99Ms: percentile(successful, 99),
    meanMs: sum / successful.length,
    minMs: successful[0],
    maxMs: successful[successful.length - 1],
  };
}

/** Run a single scenario against an adapter and return a BenchmarkResult. */
export async function runScenario(
  adapter: TransportAdapter,
  config: ScenarioConfig,
): Promise<BenchmarkResult> {
  const samples: LatencySample[] = [];
  const startMs = Date.now();

  if (config.name === "partition-recovery") {
    return runPartitionScenario(adapter, config, startMs);
  }

  // Normal / packet-loss / burst / sustained scenarios
  if (config.concurrency <= 1) {
    for (let i = 0; i < config.messageCount; i++) {
      const msg = buildMessage(config.messageSizeBytes);
      const sample = await adapter.send(msg, config.packetLossRate);
      samples.push(sample);

      // Burst: pause after each burst window
      if (config.burstSize && i > 0 && i % config.burstSize === 0) {
        await new Promise((r) => setTimeout(r, 5));
      }
    }
  } else {
    // Concurrent sends
    const batches = Math.ceil(config.messageCount / config.concurrency);
    for (let b = 0; b < batches; b++) {
      const batchSize = Math.min(
        config.concurrency,
        config.messageCount - b * config.concurrency,
      );
      const batch = Array.from({ length: batchSize }, () =>
        buildMessage(config.messageSizeBytes),
      );
      const batchSamples = await Promise.all(
        batch.map((msg) => adapter.send(msg, config.packetLossRate)),
      );
      samples.push(...batchSamples);
    }
  }

  const totalDurationMs = Date.now() - startMs;
  const successCount = samples.filter((s) => s.success).length;
  const errorRate = 1 - successCount / samples.length;
  const totalBytes = successCount * config.messageSizeBytes;

  const throughput: ThroughputMetrics = {
    messagesPerSecond: (successCount / totalDurationMs) * 1000,
    bytesPerSecond: (totalBytes / totalDurationMs) * 1000,
    totalMessages: samples.length,
    totalDurationMs,
  };

  return {
    transport: adapter.name,
    scenario: config.name,
    latency: aggregateLatency(samples),
    throughput,
    errorRate,
    samples,
  };
}

/** Run the partition-recovery scenario: send → partition → recover → resume. */
async function runPartitionScenario(
  adapter: TransportAdapter,
  config: ScenarioConfig,
  startMs: number,
): Promise<BenchmarkResult> {
  const samples: LatencySample[] = [];
  const half = Math.floor(config.messageCount / 2);

  // Phase 1: send messages before partition
  for (let i = 0; i < half; i++) {
    const msg = buildMessage(config.messageSizeBytes);
    const sample = await adapter.send(msg, config.packetLossRate);
    samples.push(sample);
  }

  // Phase 2: trigger partition
  await adapter.partition();

  // Phase 3: attempt sends during partition (will fail)
  for (let i = 0; i < 10; i++) {
    const msg = buildMessage(config.messageSizeBytes);
    const sample = await adapter.send(msg, 0);
    samples.push(sample);
  }

  // Phase 4: recover
  const reconnect = await adapter.recover();

  // Phase 5: send messages after recovery
  for (let i = 0; i < half; i++) {
    const msg = buildMessage(config.messageSizeBytes);
    const sample = await adapter.send(msg, config.packetLossRate);
    samples.push(sample);
  }

  const totalDurationMs = Date.now() - startMs;
  const successCount = samples.filter((s) => s.success).length;
  const totalBytes = successCount * config.messageSizeBytes;

  const throughput: ThroughputMetrics = {
    messagesPerSecond: (successCount / totalDurationMs) * 1000,
    bytesPerSecond: (totalBytes / totalDurationMs) * 1000,
    totalMessages: samples.length,
    totalDurationMs,
  };

  return {
    transport: adapter.name,
    scenario: config.name as ScenarioName,
    latency: aggregateLatency(samples),
    throughput,
    reconnect,
    errorRate: 1 - successCount / samples.length,
    samples,
  };
}
