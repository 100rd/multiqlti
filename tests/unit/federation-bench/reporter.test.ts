/**
 * Tests for the benchmark reporter — summarize(), buildReport(),
 * renderMarkdownTable(), renderConsoleTable().
 */

import { describe, it, expect } from "vitest";
import {
  summarize,
  buildReport,
  renderMarkdownTable,
  renderConsoleTable,
} from "../../../scripts/federation-bench/reporter.js";
import type { BenchmarkResult } from "../../../scripts/federation-bench/types.js";

/** Build a minimal valid BenchmarkResult for testing. */
function makeResult(
  overrides: Partial<BenchmarkResult> = {},
): BenchmarkResult {
  return {
    transport: "test-transport",
    scenario: "normal",
    latency: {
      p50Ms: 1.23,
      p95Ms: 3.45,
      p99Ms: 5.67,
      meanMs: 2.0,
      minMs: 0.5,
      maxMs: 10.0,
    },
    throughput: {
      messagesPerSecond: 1234.56,
      bytesPerSecond: 500_000,
      totalMessages: 200,
      totalDurationMs: 160,
    },
    errorRate: 0.02,
    samples: [
      { messageId: "m1", latencyMs: 1.0, success: true },
      { messageId: "m2", latencyMs: 0, success: false, droppedByPacketLoss: true },
    ],
    ...overrides,
  };
}

describe("summarize()", () => {
  it("maps transport and scenario correctly", () => {
    const result = makeResult({ transport: "nats-jetstream", scenario: "burst-throughput" });
    const summary = summarize(result);
    expect(summary.transport).toBe("nats-jetstream");
    expect(summary.scenario).toBe("burst-throughput");
  });

  it("rounds latency values to 2 decimal places", () => {
    const result = makeResult({
      latency: {
        p50Ms: 1.2345,
        p95Ms: 3.4567,
        p99Ms: 5.6789,
        meanMs: 2.345,
        minMs: 0.123,
        maxMs: 10.987,
      },
    });
    const summary = summarize(result);
    expect(summary.p50Ms).toBe(1.23);
    expect(summary.p95Ms).toBe(3.46);
    expect(summary.p99Ms).toBe(5.68);
    expect(summary.meanMs).toBe(2.35);
  });

  it("converts errorRate to percentage", () => {
    const result = makeResult({ errorRate: 0.0523 });
    const summary = summarize(result);
    expect(summary.errorPct).toBe(5.23);
  });

  it("rounds msgPerSec to 2 decimal places", () => {
    const result = makeResult({
      throughput: {
        messagesPerSecond: 12345.678,
        bytesPerSecond: 500_000,
        totalMessages: 200,
        totalDurationMs: 160,
      },
    });
    const summary = summarize(result);
    expect(summary.msgPerSec).toBe(12345.68);
  });

  it("reconnectMs is undefined when result has no reconnect data", () => {
    const result = makeResult({ reconnect: undefined });
    const summary = summarize(result);
    expect(summary.reconnectMs).toBeUndefined();
    expect(summary.reconnectAttempts).toBeUndefined();
    expect(summary.messagesDropped).toBeUndefined();
  });

  it("populates reconnect fields when present", () => {
    const result = makeResult({
      reconnect: {
        partitionDetectedMs: 500,
        reconnectAttempts: 3,
        reconnectDurationMs: 1234.5,
        messagesDropped: 5,
        messagesRedelivered: 2,
      },
    });
    const summary = summarize(result);
    expect(summary.reconnectMs).toBe(1234.5);
    expect(summary.reconnectAttempts).toBe(3);
    expect(summary.messagesDropped).toBe(5);
  });
});

describe("buildReport()", () => {
  it("sets generatedAt to a valid ISO date string", () => {
    const report = buildReport([makeResult()]);
    expect(() => new Date(report.generatedAt)).not.toThrow();
    expect(isNaN(new Date(report.generatedAt).getTime())).toBe(false);
  });

  it("sets totalResults to the number of results", () => {
    const report = buildReport([makeResult(), makeResult(), makeResult()]);
    expect(report.totalResults).toBe(3);
  });

  it("summary array has one entry per result", () => {
    const results = [
      makeResult({ transport: "a" }),
      makeResult({ transport: "b" }),
    ];
    const report = buildReport(results);
    expect(report.summary.length).toBe(2);
    expect(report.summary[0].transport).toBe("a");
    expect(report.summary[1].transport).toBe("b");
  });

  it("rawResults preserves original results", () => {
    const results = [makeResult({ transport: "original" })];
    const report = buildReport(results);
    expect(report.rawResults[0].transport).toBe("original");
  });

  it("handles empty results array", () => {
    const report = buildReport([]);
    expect(report.totalResults).toBe(0);
    expect(report.summary).toHaveLength(0);
    expect(report.rawResults).toHaveLength(0);
  });
});

describe("renderMarkdownTable()", () => {
  it("produces output containing all transport names", () => {
    const results = [
      makeResult({ transport: "redis-ws-baseline", scenario: "normal" }),
      makeResult({ transport: "nats-jetstream", scenario: "normal" }),
    ];
    const output = renderMarkdownTable(results);
    expect(output).toContain("redis-ws-baseline");
    expect(output).toContain("nats-jetstream");
  });

  it("includes all scenarios as headings", () => {
    const results = [
      makeResult({ scenario: "normal" }),
      makeResult({ scenario: "packet-loss-5pct" }),
    ];
    const output = renderMarkdownTable(results);
    expect(output).toContain("normal");
    expect(output).toContain("packet-loss-5pct");
  });

  it("contains markdown table pipe characters", () => {
    const output = renderMarkdownTable([makeResult()]);
    expect(output).toContain("|");
  });

  it("contains column headers", () => {
    const output = renderMarkdownTable([makeResult()]);
    expect(output).toContain("Transport");
    expect(output).toContain("p50");
    expect(output).toContain("p95");
    expect(output).toContain("msg/s");
    expect(output).toContain("error%");
  });

  it("shows reconnect ms column with data when present", () => {
    const result = makeResult({
      reconnect: {
        partitionDetectedMs: 500,
        reconnectAttempts: 2,
        reconnectDurationMs: 2500,
        messagesDropped: 3,
        messagesRedelivered: 0,
      },
    });
    const output = renderMarkdownTable([result]);
    expect(output).toContain("2500");
  });

  it("returns empty string for empty results", () => {
    const output = renderMarkdownTable([]);
    expect(output.trim()).toBe("");
  });
});

describe("renderConsoleTable()", () => {
  it("contains a header row with column names", () => {
    const output = renderConsoleTable([makeResult()]);
    expect(output).toContain("transport");
    expect(output).toContain("scenario");
    expect(output).toContain("p50ms");
    expect(output).toContain("p99ms");
    expect(output).toContain("err%");
    expect(output).toContain("msg/s");
  });

  it("contains a separator line", () => {
    const output = renderConsoleTable([makeResult()]);
    const lines = output.split("\n");
    const separatorLine = lines.find((l) => l.match(/^-+$/));
    expect(separatorLine).toBeTruthy();
  });

  it("includes one data row per result", () => {
    const results = [
      makeResult({ transport: "alpha" }),
      makeResult({ transport: "beta" }),
      makeResult({ transport: "gamma" }),
    ];
    const output = renderConsoleTable(results);
    expect(output).toContain("alpha");
    expect(output).toContain("beta");
    expect(output).toContain("gamma");
  });

  it("truncates long transport names to fit column width", () => {
    const longName = "a".repeat(30);
    const result = makeResult({ transport: longName });
    const output = renderConsoleTable([result]);
    // Should not crash and should contain part of the name
    expect(output).toContain("aaaaaaaaaa");
  });
});
