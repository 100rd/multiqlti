import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

// ─── Flake quarantine (retry: 2, SCOPED to these files only) ────────────────
//
// These files exhibit *non-deterministic* failures (timing / async-propagation
// races, provider timeouts, occasional unhandled errors) that pass on a re-run.
// Root causes are fixed at the source where cheap — the remote-agent port-bind
// flake is fixed in tests/helpers/test-agent.ts (OS-assigned ephemeral ports).
// The retries below cover the *residual* timing races only.
//
// IMPORTANT (anti-masking guarantee): `retry` is applied via dedicated vitest
// projects that include EXACTLY the files listed here — it is never global.
// Every other test in the suite still fails on its first failure. A file listed
// here that fails *deterministically* (a real regression) still fails all 3
// attempts and turns CI red; only genuine flakes (pass-on-retry) are absorbed.
// When a root cause is fixed, remove the file from the relevant list.
const FLAKY_UNIT = [
  // Provider tests that occasionally time out under load (external-ish timing).
  "tests/unit/providers/antigravity.test.ts",
  "tests/unit/providers/antigravity-cli.test.ts",
  "tests/unit/providers/antigravity-model-resolution.test.ts",
  // Occasional "unhandled error" races in tool/RAG teardown.
  "tests/unit/tools/tool-builtins.test.ts",
  "tests/unit/rag/memory-search-tool.test.ts",
  // Route-registration ordering sensitivity.
  "tests/unit/costs/costs-routes.test.ts",
];
const FLAKY_INTEGRATION = [
  // Port-bind EADDRINUSE — root-caused in tests/helpers/test-agent.ts (ephemeral
  // ports). Retry kept as belt-and-suspenders for any residual startup timing.
  "tests/integration/remote-agent-lifecycle.test.ts",
  // Async config-propagation timing race ("expected length 2, got 1"). Test-side
  // timing only; see PR notes re: a possible product-side race (follow-up).
  "tests/integration/config-sync-multi-instance.test.ts",
];

// The whole integration suite runs in ONE process (pool: forks, singleFork) —
// 50+ files, ~800 tests, serially. Under that sustained load, GC / event-loop
// pauses occasionally push an otherwise-fast test past the default 5s deadline
// (observed: models-api "Test timed out in 5000ms", runs-extended "Hook timed
// out in 10000ms" — both pass in isolation in <200ms). Raising the deadlines
// removes these *load-induced* timeouts. This does NOT mask real failures: a
// timeout is not an assertion failure, and a genuinely hung/broken test still
// fails — just after a longer, load-tolerant deadline.
const INTEGRATION_TEST_TIMEOUT_MS = 20_000;
const INTEGRATION_HOOK_TIMEOUT_MS = 30_000;

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client", "src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  // Task #52.2: the "unit-dom" project below renders .tsx components (React
  // Testing Library) without the app's own @vitejs/plugin-react (that plugin
  // lives only in vite.config.ts, for the actual client build). Without this,
  // esbuild's default classic JSX transform emits bare `React.createElement`
  // calls with no `React` import, failing every render with "React is not
  // defined" — client/src components rely on the automatic runtime (no
  // explicit `import React` anywhere), same as vite.config.ts's react() plugin.
  esbuild: {
    jsx: "automatic",
  },
  // Task #52.2: matches vite.config.ts's identical override. The repo's root
  // postcss.config.js still lists `tailwindcss` as a classic PostCSS plugin
  // (stale — tailwindcss v4's PostCSS integration moved to the separate
  // `@tailwindcss/postcss` package, wired only via the `@tailwindcss/vite`
  // plugin in vite.config.ts). Without this override, any .tsx test that
  // imports a component pulling in third-party CSS (e.g. Statistics.tsx →
  // react-grid-layout/css/styles.css) crashes vite:css with that mismatch.
  css: {
    postcss: {
      plugins: [],
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...FLAKY_UNIT],
          environment: "node",
        },
      },
      {
        // Task #52.2: FE component tests (React Testing Library). Split into its
        // own project (glob'd on .tsx only, so it never overlaps the "unit"
        // project's .ts-only include) because these need a DOM (jsdom), unlike
        // every other unit test in the repo which runs under plain "node".
        extends: true,
        test: {
          name: "unit-dom",
          include: ["tests/unit/**/*.test.tsx"],
          exclude: [...configDefaults.exclude],
          environment: "jsdom",
          setupFiles: ["tests/unit/setup-dom.ts"],
          // Some client/src pages import third-party CSS (e.g. Statistics.tsx →
          // react-grid-layout/css/styles.css), which this repo's root PostCSS
          // config can't process outside the real Vite build (tailwindcss v4's
          // PostCSS plugin moved to @tailwindcss/postcss, wired only in
          // vite.config.ts). RTL assertions here check text content, never
          // computed styles, so CSS processing is unneeded — disable it.
          css: false,
        },
      },
      {
        extends: true,
        test: {
          name: "unit-flaky",
          include: [...FLAKY_UNIT],
          environment: "node",
          // antigravity CLI/provider tests occasionally exceed 5s under load.
          testTimeout: 15_000,
          retry: 2,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...FLAKY_INTEGRATION],
          environment: "node",
          pool: "forks",
          singleFork: true,
          testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
          hookTimeout: INTEGRATION_HOOK_TIMEOUT_MS,
        },
      },
      {
        extends: true,
        test: {
          name: "integration-flaky",
          include: [...FLAKY_INTEGRATION],
          environment: "node",
          pool: "forks",
          singleFork: true,
          testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
          hookTimeout: INTEGRATION_HOOK_TIMEOUT_MS,
          retry: 2,
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
        // github-trigger-polling — the poller + the reusable gh JSON seam.
        "server/services/github-poller.ts",
        "server/services/github-status.ts",
      ],
      exclude: ["server/**/*.test.ts", "server/index.ts", "server/vite.ts"],
    },
  },
});
