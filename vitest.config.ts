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
        "server/privacy/**/*.ts",
        "server/memory/extractor.ts",
        "server/routes/privacy.ts",
        "server/routes/strategies.ts",
        "server/routes/memory.ts",
        "server/routes/sandbox.ts",
        "server/routes/settings.ts",
        "server/routes/pipelines.ts",
        "server/gateway/providers/mock.ts",
      ],
      exclude: ["server/**/*.test.ts", "server/index.ts", "server/vite.ts"],
    },
  },
});
