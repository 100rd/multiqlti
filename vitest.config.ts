import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client", "src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          pool: "forks",
          singleFork: true,
        },
      },
    ],
    coverage: {
      provider: "v8",
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
      },
      // Measure coverage on the actively tested server modules.
      // Full server coverage (routes/chat, workspace, tools, ws) is tracked in
      // nightly CI once those modules gain test suites.
      include: [
        // streaming-stage-execution: changed modules (>=80% lines targeted).
        "server/gateway/providers/cli-spawn.ts",
        "server/gateway/providers/claude-cli.ts",
        "server/gateway/secret-scrub.ts",
        "server/gateway/index.ts",
        "server/teams/base.ts",
        "server/controller/stage-progress.ts",
        "server/privacy/**/*.ts",
        "server/memory/extractor.ts",
        "server/routes/privacy.ts",
        "server/routes/strategies.ts",
        "server/routes/memory.ts",
        "server/routes/sandbox.ts",
        "server/routes/settings.ts",
        "server/routes/pipelines.ts",
        "server/gateway/providers/mock.ts",
        "server/gateway/catalog-sync.ts",
        "server/routes/models.ts",
        "server/knowledge/source-allowlist.ts",
        "server/knowledge/safe-fetch.ts",
        "server/knowledge/practice-card-service.ts",
        "server/routes/practice-cards.ts",
        "server/knowledge/diff-engine.ts",
        "server/knowledge/compliance-mapper.ts",
        "server/knowledge/refresh-scheduler.ts",
        "server/knowledge/seed-terraform-cards.ts",
        "server/news/news-service.ts",
        "server/news/relevance-ranker.ts",
        "server/memory/omniscience-board-provider.ts",
        "server/news/news-sources.ts",
        "server/news/news-fetcher.ts",
        "server/news/brief-generator.ts",
        "server/news/brief-scheduler.ts",
        "server/routes/news.ts",
        "server/news/news-deps.ts",
        // debate-research orchestrator (>=80% lines on new modules).
        "server/orchestrator/plan-schema.ts",
        "server/orchestrator/untrusted-content.ts",
        "server/orchestrator/orchestrator-config.ts",
        "server/orchestrator/orchestrator-agent.ts",
        "server/orchestrator/debate-runner.ts",
        "server/orchestrator/research-service.ts",
        "server/orchestrator/grounding-step.ts",
        "server/orchestrator/steps/index.ts",
        "server/orchestrator/build-agent.ts",
        "server/routes/orchestrator.ts",
      ],
      exclude: ["server/**/*.test.ts", "server/index.ts", "server/vite.ts"],
    },
  },
});
