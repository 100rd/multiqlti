import type { TeamId } from "../../shared/types.js";

/**
 * Recorded mock LLM responses per TeamId.
 * These are used in tests that need deterministic, pre-canned output.
 */
export const RECORDED_RESPONSES: Record<TeamId, string> = {
  planning: JSON.stringify({
    tasks: [
      { id: "1", title: "Initialize project", description: "Set up repo and tooling", priority: "high", estimatedHours: 1 },
    ],
    acceptanceCriteria: ["Project builds without errors"],
    risks: [],
    summary: "Recorded planning output for test fixture.",
  }),

  architecture: JSON.stringify({
    components: [
      { name: "API", type: "gateway", description: "REST API", dependencies: [] },
    ],
    techStack: { language: "TypeScript", framework: "Express", database: "Postgres", infrastructure: "Docker" },
    dataFlow: "Client -> API -> DB",
    apiEndpoints: [{ method: "GET", path: "/api/health", description: "Health check" }],
    summary: "Recorded architecture output for test fixture.",
  }),

  development: JSON.stringify({
    files: [{ path: "src/index.ts", language: "typescript", content: "// placeholder", description: "Entry point" }],
    dependencies: [],
    summary: "Recorded development output for test fixture.",
  }),

  testing: JSON.stringify({
    testFiles: [],
    testStrategy: "Unit tests with Vitest.",
    coverageTargets: { lines: 80, branches: 70, functions: 85 },
    issues: [],
    summary: "Recorded testing output for test fixture.",
  }),

  code_review: JSON.stringify({
    findings: [],
    securityIssues: [],
    score: { quality: 9, security: 9, maintainability: 9 },
    approved: true,
    summary: "Recorded code review output for test fixture. No issues found.",
  }),

  deployment: JSON.stringify({
    files: [],
    deploymentStrategy: "Docker Compose",
    environments: [{ name: "development", config: { replicas: 1, resources: "256Mi" } }],
    summary: "Recorded deployment output for test fixture.",
  }),

  monitoring: JSON.stringify({
    dashboards: [],
    alerts: [],
    healthChecks: [{ name: "API", endpoint: "/api/health", interval: "30s", timeout: "5s" }],
    summary: "Recorded monitoring output for test fixture.",
  }),

  fact_check: JSON.stringify({
    verdict: "pass",
    issues: [],
    enrichedOutput: "Recorded fact-check output.",
    summary: "Recorded fact-check output for test fixture.",
  }),
};
