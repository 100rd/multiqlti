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
        "server/routes/knowledge.ts",
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
        "server/orchestrator/deliberation/stop-policy.ts",
        "server/orchestrator/deliberation/stability-judge.ts",
        "server/orchestrator/deliberation/deliberation-controller.ts",
        "server/orchestrator/research-service.ts",
        "server/orchestrator/grounding-step.ts",
        "server/orchestrator/steps/index.ts",
        "server/orchestrator/build-agent.ts",
        "server/routes/orchestrator.ts",
        // /consensus run mode (adaptive-stability deliberation engine).
        "server/consensus/verdict-schema.ts",
        "server/consensus/critical-issue-ledger.ts",
        "server/consensus/consensus-voters.ts",
        "server/consensus/consensus-engine.ts",
        "server/consensus/consensus-controller.ts",
        "server/routes/consensus.ts",
        // live-run-activity-ui (new modules ≥80%).
        "server/routes/activity.ts",
        "server/routes/activity-model-map.ts",
        "server/routes/authorize-run.ts",
        "server/ws/manager.ts",
        // task-groups edit + history + live-activity history (new modules >=80%).
        "server/routes/authorize-task-group.ts",
        "server/routes/task-groups.ts",
        "server/services/task-graph.ts",
        "server/services/task-group-editor.ts",
        // task-groups-v2 BE1/BE2 — schema + storage (Mem + Pg, lockstep). The
        // coverage.include list is an ALLOWLIST: a new module is unmeasured
        // unless named here. storage.ts + storage-pg.ts carry the BE2 impls.
        "server/storage.ts",
        "server/storage-pg.ts",
        "server/storage-task-groups-v2.ts",
        // task-groups-v2 Wave 2 — BE3 orchestrator, BE4 tracer, BE5 editor,
        // BE6 iteration routes + legacy-trace alias (new modules >=80%).
        "server/services/task-orchestrator.ts",
        "server/services/task-tracer.ts",
        // task-groups-v2 regression-fix wave — extracted orchestrator helpers.
        "server/services/orchestrator/execution-claims.ts",
        "server/services/orchestrator/direct-llm-prompt.ts",
        "server/services/orchestrator/iteration-tracing.ts",
        "server/services/orchestrator/errors.ts",
        "server/routes/task-iterations.ts",
        "server/routes/task-traces.ts",
        // task-groups-v2 Wave 3 — BE7 template authz + CRUD routes, BE8 compose.
        "server/routes/authorize-task-template.ts",
        "server/routes/task-templates.ts",
        "server/services/task-template-compose.ts",
        // task-groups-v2 FE pure modules (node-testable, no DOM): iteration
        // shaping/gating + the shared task-form logic + the timeline (incl. the
        // new execution-row adapter). Listed so they're measured (allowlist).
        "client/src/lib/task-iterations.ts",
        "client/src/components/task-groups/task-form-logic.ts",
        "client/src/components/task-groups/timeline.ts",
      ],
      exclude: ["server/**/*.test.ts", "server/index.ts", "server/vite.ts"],
    },
  },
});
