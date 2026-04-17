/**
 * Tests for the ScenarioRunner and DEFAULT_SCENARIOS definitions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DEFAULT_SCENARIOS, runScenario } from "../../../scripts/federation-bench/scenarios.js";
import { RedisBaselineAdapter } from "../../../scripts/federation-bench/adapters/redis-baseline.js";
import type { ScenarioConfig, TransportAdapter, BenchMessage, LatencySample, ReconnectMetrics } from "../../../scripts/federation-bench/types.js";

/** A minimal in-memory adapter for scenario testing. */
class SyncAdapter implements TransportAdapter {
  readonly name = "sync-test";
  readonly description = "Deterministic test adapter";

  private partitioned = false;
  readonly sendLog: Array<{ id: string; lossRate: number }> = [];

  async setup(): Promise<void> {}

  async send(msg: BenchMessage, lossRate: number): Promise<LatencySample> {
    this.sendLog.push({ id: msg.id, lossRate });

    if (this.partitioned) {
      return { messageId: msg.id, latencyMs: 0, success: false };
    }
    if (Math.random() < lossRate) {
      return { messageId: msg.id, latencyMs: 0, success: false, droppedByPacketLoss: true };
    }
    return { messageId: msg.id, latencyMs: 0.5, success: true };
  }

  async partition(): Promise<void> {
    this.partitioned = true;
  }

  async recover(): Promise<ReconnectMetrics> {
    this.partitioned = false;
    return {
      partitionDetectedMs: 100,
      reconnectAttempts: 1,
      reconnectDurationMs: 50,
      messagesDropped: 0,
      messagesRedelivered: 0,
    };
  }

  async teardown(): Promise<void> {
    this.partitioned = false;
  }
}

describe("DEFAULT_SCENARIOS", () => {
  it("contains all five required scenario names", () => {
    const names = DEFAULT_SCENARIOS.map((s) => s.name);
    expect(names).toContain("normal");
    expect(names).toContain("packet-loss-5pct");
    expect(names).toContain("partition-recovery");
    expect(names).toContain("burst-throughput");
    expect(names).toContain("sustained-load");
  });

  it("packet-loss-5pct has packetLossRate=0.05", () => {
    const scenario = DEFAULT_SCENARIOS.find((s) => s.name === "packet-loss-5pct")!;
    expect(scenario.packetLossRate).toBe(0.05);
  });

  it("partition-recovery has partitionDurationMs set", () => {
    const scenario = DEFAULT_SCENARIOS.find((s) => s.name === "partition-recovery")!;
    expect(scenario.partitionDurationMs).toBeDefined();
    expect(scenario.partitionDurationMs).toBeGreaterThan(0);
  });

  it("burst-throughput has burstSize and concurrency > 1", () => {
    const scenario = DEFAULT_SCENARIOS.find((s) => s.name === "burst-throughput")!;
    expect(scenario.burstSize).toBeDefined();
    expect(scenario.burstSize).toBeGreaterThan(0);
    expect(scenario.concurrency).toBeGreaterThan(1);
  });

  it("all scenarios have positive messageCount and messageSizeBytes", () => {
    for (const s of DEFAULT_SCENARIOS) {
      expect(s.messageCount).toBeGreaterThan(0);
      expect(s.messageSizeBytes).toBeGreaterThan(0);
    }
  });
});

describe("runScenario", () => {
  let adapter: SyncAdapter;

  beforeEach(async () => {
    adapter = new SyncAdapter();
    await adapter.setup();
  });

  afterEach(async () => {
    await adapter.teardown();
  });

  it("returns a BenchmarkResult with correct transport name", async () => {
    const config: ScenarioConfig = {
      name: "normal",
      messageCount: 10,
      messageSizeBytes: 128,
      concurrency: 1,
      packetLossRate: 0,
    };
    const result = await runScenario(adapter, config);
    expect(result.transport).toBe("sync-test");
    expect(result.scenario).toBe("normal");
  });

  it("sends exactly messageCount messages in sequential mode", async () => {
    const config: ScenarioConfig = {
      name: "normal",
      messageCount: 20,
      messageSizeBytes: 128,
      concurrency: 1,
      packetLossRate: 0,
    };
    await runScenario(adapter, config);
    expect(adapter.sendLog.length).toBe(20);
  });

  it("sends exactly messageCount messages in concurrent mode", async () => {
    const config: ScenarioConfig = {
      name: "sustained-load",
      messageCount: 20,
      messageSizeBytes: 128,
      concurrency: 4,
      packetLossRate: 0,
    };
    await runScenario(adapter, config);
    expect(adapter.sendLog.length).toBe(20);
  });

  it("passes lossRate from config to each send call", async () => {
    const config: ScenarioConfig = {
      name: "packet-loss-5pct",
      messageCount: 10,
      messageSizeBytes: 128,
      concurrency: 1,
      packetLossRate: 0.05,
    };
    await runScenario(adapter, config);
    for (const log of adapter.sendLog) {
      expect(log.lossRate).toBe(0.05);
    }
  });

  it("result has all latency percentile fields", async () => {
    const config: ScenarioConfig = {
      name: "normal",
      messageCount: 50,
      messageSizeBytes: 128,
      concurrency: 1,
      packetLossRate: 0,
    };
    const result = await runScenario(adapter, config);
    expect(typeof result.latency.p50Ms).toBe("number");
    expect(typeof result.latency.p95Ms).toBe("number");
    expect(typeof result.latency.p99Ms).toBe("number");
    expect(typeof result.latency.meanMs).toBe("number");
    expect(typeof result.latency.minMs).toBe("number");
    expect(typeof result.latency.maxMs).toBe("number");
  });

  it("result has throughput metrics with positive totalMessages", async () => {
    const config: ScenarioConfig = {
      name: "normal",
      messageCount: 30,
      messageSizeBytes: 128,
      concurrency: 1,
      packetLossRate: 0,
    };
    const result = await runScenario(adapter, config);
    expect(result.throughput.totalMessages).toBe(30);
    expect(result.throughput.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("partition-recovery scenario populates reconnect metrics", async () => {
    const config: ScenarioConfig = {
      name: "partition-recovery",
      messageCount: 20,
      messageSizeBytes: 128,
      concurrency: 1,
      packetLossRate: 0,
      partitionDurationMs: 100,
    };
    const result = await runScenario(adapter, config);
    expect(result.reconnect).toBeDefined();
    expect(result.reconnect!.reconnectAttempts).toBeGreaterThan(0);
    expect(result.reconnect!.reconnectDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("errorRate is between 0 and 1", async () => {
    const config: ScenarioConfig = {
      name: "normal",
      messageCount: 50,
      messageSizeBytes: 128,
      concurrency: 1,
      packetLossRate: 0,
    };
    const result = await runScenario(adapter, config);
    expect(result.errorRate).toBeGreaterThanOrEqual(0);
    expect(result.errorRate).toBeLessThanOrEqual(1);
  });

  it("samples array has length >= messageCount", async () => {
    const config: ScenarioConfig = {
      name: "normal",
      messageCount: 15,
      messageSizeBytes: 128,
      concurrency: 1,
      packetLossRate: 0,
    };
    const result = await runScenario(adapter, config);
    expect(result.samples.length).toBeGreaterThanOrEqual(15);
  });

  it("works correctly with the real RedisBaselineAdapter", async () => {
    const realAdapter = new RedisBaselineAdapter();
    await realAdapter.setup();

    const config: ScenarioConfig = {
      name: "normal",
      messageCount: 10,
      messageSizeBytes: 256,
      concurrency: 1,
      packetLossRate: 0,
    };
    const result = await runScenario(realAdapter, config);
    expect(result.transport).toBe("redis-ws-baseline");
    expect(result.throughput.totalMessages).toBe(10);

    await realAdapter.teardown();
  });
});
