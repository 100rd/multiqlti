/**
 * Results reporter for the federation transport benchmark.
 *
 * Renders BenchmarkResult arrays in two formats:
 * 1. Comparison table (console / CI output)
 * 2. JSON summary (machine-readable, suitable for dashboards or PR comments)
 */

import type { BenchmarkResult, ScenarioName } from "./types.js";

/** Summary entry per transport × scenario. */
export interface SummaryEntry {
  transport: string;
  scenario: ScenarioName;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  meanMs: number;
  msgPerSec: number;
  errorPct: number;
  reconnectMs?: number;
  reconnectAttempts?: number;
  messagesDropped?: number;
}

/** Full JSON report structure. */
export interface BenchReport {
  generatedAt: string;
  totalResults: number;
  summary: SummaryEntry[];
  rawResults: BenchmarkResult[];
}

/** Build a summary entry from a raw BenchmarkResult. */
export function summarize(result: BenchmarkResult): SummaryEntry {
  return {
    transport: result.transport,
    scenario: result.scenario,
    p50Ms: round(result.latency.p50Ms),
    p95Ms: round(result.latency.p95Ms),
    p99Ms: round(result.latency.p99Ms),
    meanMs: round(result.latency.meanMs),
    msgPerSec: round(result.throughput.messagesPerSecond),
    errorPct: round(result.errorRate * 100),
    reconnectMs: result.reconnect
      ? round(result.reconnect.reconnectDurationMs)
      : undefined,
    reconnectAttempts: result.reconnect?.reconnectAttempts,
    messagesDropped: result.reconnect?.messagesDropped,
  };
}

/** Build the full JSON report from all results. */
export function buildReport(results: BenchmarkResult[]): BenchReport {
  return {
    generatedAt: new Date().toISOString(),
    totalResults: results.length,
    summary: results.map(summarize),
    rawResults: results,
  };
}

/** Render results as a markdown comparison table grouped by scenario. */
export function renderMarkdownTable(results: BenchmarkResult[]): string {
  const scenarios = [...new Set(results.map((r) => r.scenario))];
  const lines: string[] = [];

  for (const scenario of scenarios) {
    const group = results.filter((r) => r.scenario === scenario);
    lines.push(`### Scenario: ${scenario}`);
    lines.push("");
    lines.push(
      "| Transport | p50 ms | p95 ms | p99 ms | mean ms | msg/s | error% | reconnect ms | dropped |",
    );
    lines.push(
      "|-----------|-------:|-------:|-------:|--------:|------:|-------:|-------------:|--------:|",
    );

    for (const r of group) {
      const s = summarize(r);
      lines.push(
        `| ${s.transport} | ${s.p50Ms} | ${s.p95Ms} | ${s.p99Ms} | ${s.meanMs} | ${s.msgPerSec} | ${s.errorPct} | ${s.reconnectMs ?? "—"} | ${s.messagesDropped ?? "—"} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Render a compact console summary (no markdown). */
export function renderConsoleTable(results: BenchmarkResult[]): string {
  const header = [
    "transport".padEnd(22),
    "scenario".padEnd(22),
    "p50ms".padStart(7),
    "p95ms".padStart(7),
    "p99ms".padStart(7),
    "err%".padStart(6),
    "msg/s".padStart(8),
  ].join("  ");

  const separator = "-".repeat(header.length);

  const rows = results.map((r) => {
    const s = summarize(r);
    return [
      s.transport.padEnd(22),
      s.scenario.padEnd(22),
      String(s.p50Ms).padStart(7),
      String(s.p95Ms).padStart(7),
      String(s.p99Ms).padStart(7),
      String(s.errorPct).padStart(6),
      String(s.msgPerSec).padStart(8),
    ].join("  ");
  });

  return [header, separator, ...rows].join("\n");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
