/**
 * Federation transport benchmark runner.
 *
 * Usage:
 *   npx tsx scripts/federation-bench/index.ts [--json] [--scenario <name>]
 *
 * Flags:
 *   --json         Output full JSON report to stdout
 *   --scenario     Run a single named scenario (default: all)
 *
 * Each transport adapter is run through all scenarios in sequence.
 * Results are printed as a markdown table and optionally as JSON.
 */

import { RedisBaselineAdapter } from "./adapters/redis-baseline.js";
import { NatsAdapter } from "./adapters/nats-adapter.js";
import { GrpcAdapter } from "./adapters/grpc-adapter.js";
import { Libp2pAdapter } from "./adapters/libp2p-adapter.js";
import { QuicAdapter } from "./adapters/quic-adapter.js";
import { DEFAULT_SCENARIOS, runScenario } from "./scenarios.js";
import { buildReport, renderMarkdownTable, renderConsoleTable } from "./reporter.js";
import type { BenchmarkResult, ScenarioConfig } from "./types.js";

const ADAPTERS = [
  new RedisBaselineAdapter(),
  new NatsAdapter(),
  new GrpcAdapter(),
  new Libp2pAdapter(),
  new QuicAdapter(),
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outputJson = args.includes("--json");
  const scenarioArg = args.find((_, i) => args[i - 1] === "--scenario");

  const scenarios: ScenarioConfig[] = scenarioArg
    ? DEFAULT_SCENARIOS.filter((s) => s.name === scenarioArg)
    : DEFAULT_SCENARIOS;

  if (scenarios.length === 0) {
    console.error(`Unknown scenario: ${scenarioArg}`);
    console.error(
      `Available: ${DEFAULT_SCENARIOS.map((s) => s.name).join(", ")}`,
    );
    process.exit(1);
  }

  const results: BenchmarkResult[] = [];

  for (const adapter of ADAPTERS) {
    console.error(`\nRunning adapter: ${adapter.name}`);
    await adapter.setup();

    for (const scenario of scenarios) {
      console.error(`  scenario: ${scenario.name}...`);
      try {
        const result = await runScenario(adapter, scenario);
        results.push(result);
        console.error(
          `    p50=${result.latency.p50Ms.toFixed(2)}ms  ` +
            `p99=${result.latency.p99Ms.toFixed(2)}ms  ` +
            `err=${(result.errorRate * 100).toFixed(1)}%`,
        );
      } catch (err) {
        console.error(`    ERROR: ${(err as Error).message}`);
      }
    }

    await adapter.teardown();
  }

  if (outputJson) {
    const report = buildReport(results);
    process.stdout.write(JSON.stringify(report, null, 2));
    process.stdout.write("\n");
  } else {
    console.log("\n## Federation Transport Benchmark Results\n");
    console.log(renderMarkdownTable(results));
    console.log("\n## Console Summary\n");
    console.log(renderConsoleTable(results));
  }
}

main().catch((err: unknown) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
