import type { TeamId } from "@shared/types";
import { SDLC_TEAMS } from "@shared/constants";

const MOCK_RESPONSES: Record<TeamId, (input: string) => string> = {
  planning: (input) =>
    JSON.stringify(
      {
        tasks: [
          { id: "1", title: "Set up project structure", description: `Initialize the project scaffold for: ${input.slice(0, 80)}`, priority: "high", estimatedHours: 2 },
          { id: "2", title: "Define data models", description: "Create database schemas and TypeScript interfaces", priority: "high", estimatedHours: 3 },
          { id: "3", title: "Implement core business logic", description: "Build the main service layer and API endpoints", priority: "high", estimatedHours: 8 },
          { id: "4", title: "Add input validation", description: "Implement request validation using Zod schemas", priority: "medium", estimatedHours: 2 },
          { id: "5", title: "Write integration tests", description: "Create end-to-end test suite", priority: "medium", estimatedHours: 4 },
        ],
        acceptanceCriteria: [
          "All API endpoints return proper status codes",
          "Input validation rejects malformed requests",
          "Test coverage exceeds 80%",
          "Service starts and responds within 2 seconds",
        ],
        risks: [
          { description: "External API dependencies may introduce latency", severity: "medium", mitigation: "Add circuit breaker and caching layer" },
          { description: "Schema migrations could cause downtime", severity: "high", mitigation: "Use zero-downtime migration strategy" },
        ],
        summary: `Planning complete for: ${input.slice(0, 100)}. 5 tasks identified across setup, implementation, and testing phases.`,
      },
      null,
      2,
    ),

  architecture: () =>
    JSON.stringify(
      {
        components: [
          { name: "API Gateway", type: "gateway", description: "Express.js REST API with middleware chain", dependencies: [] },
          { name: "Service Layer", type: "service", description: "Business logic and orchestration", dependencies: ["API Gateway"] },
          { name: "Data Layer", type: "service", description: "Drizzle ORM data access layer", dependencies: ["Service Layer"] },
          { name: "PostgreSQL", type: "database", description: "Primary data store", dependencies: [] },
          { name: "Redis Cache", type: "service", description: "Caching and session storage", dependencies: [] },
        ],
        techStack: { language: "TypeScript", framework: "Express 5", database: "PostgreSQL", infrastructure: "Docker + Kubernetes" },
        dataFlow: "Client -> API Gateway -> Service Layer -> Data Layer -> PostgreSQL. Cache reads go through Redis.",
        apiEndpoints: [
          { method: "GET", path: "/api/health", description: "Health check endpoint" },
          { method: "GET", path: "/api/resources", description: "List resources with pagination" },
          { method: "POST", path: "/api/resources", description: "Create a new resource" },
          { method: "PUT", path: "/api/resources/:id", description: "Update a resource" },
          { method: "DELETE", path: "/api/resources/:id", description: "Delete a resource" },
        ],
        summary: "Microservice architecture with Express 5, PostgreSQL, and Redis. Clean layered design with clear separation of concerns.",
      },
      null,
      2,
    ),

  development: () =>
    JSON.stringify(
      {
        files: [
          {
            path: "src/index.ts",
            language: "typescript",
            content: `import express from 'express';\nimport { router } from './routes';\nimport { errorHandler } from './middleware/error';\n\nconst app = express();\napp.use(express.json());\napp.use('/api', router);\napp.use(errorHandler);\n\nconst PORT = process.env.PORT || 3000;\napp.listen(PORT, () => console.log(\`Server running on port \${PORT}\`));`,
            description: "Application entry point",
          },
          {
            path: "src/routes/index.ts",
            language: "typescript",
            content: `import { Router } from 'express';\nimport { getResources, createResource } from '../controllers/resource';\n\nexport const router = Router();\nrouter.get('/resources', getResources);\nrouter.post('/resources', createResource);`,
            description: "API route definitions",
          },
          {
            path: "src/controllers/resource.ts",
            language: "typescript",
            content: `import type { Request, Response } from 'express';\nimport { resourceService } from '../services/resource';\n\nexport async function getResources(req: Request, res: Response) {\n  const resources = await resourceService.findAll();\n  res.json(resources);\n}\n\nexport async function createResource(req: Request, res: Response) {\n  const resource = await resourceService.create(req.body);\n  res.status(201).json(resource);\n}`,
            description: "Resource controller",
          },
        ],
        dependencies: [
          { name: "express", version: "^5.0.0" },
          { name: "drizzle-orm", version: "^0.39.0" },
          { name: "zod", version: "^3.25.0" },
        ],
        summary: "Generated 3 core files: entry point, routes, and controller. Clean Express 5 setup with TypeScript.",
      },
      null,
      2,
    ),

  testing: () =>
    JSON.stringify(
      {
        testFiles: [
          {
            path: "tests/resource.test.ts",
            language: "typescript",
            content: `import { describe, it, expect } from 'vitest';\nimport request from 'supertest';\nimport { app } from '../src/index';\n\ndescribe('GET /api/resources', () => {\n  it('returns 200 with empty array', async () => {\n    const res = await request(app).get('/api/resources');\n    expect(res.status).toBe(200);\n    expect(res.body).toEqual([]);\n  });\n});\n\ndescribe('POST /api/resources', () => {\n  it('creates a resource and returns 201', async () => {\n    const res = await request(app).post('/api/resources').send({ name: 'test' });\n    expect(res.status).toBe(201);\n    expect(res.body.name).toBe('test');\n  });\n});`,
            testCount: 2,
          },
        ],
        testStrategy: "Unit tests for service layer, integration tests for API endpoints using supertest.",
        coverageTargets: { lines: 85, branches: 75, functions: 90 },
        issues: [
          { file: "src/controllers/resource.ts", line: 5, severity: "warning", description: "Missing error handling for service call" },
        ],
        summary: "Generated 2 test cases covering GET and POST endpoints. 1 potential issue identified.",
      },
      null,
      2,
    ),

  code_review: () =>
    JSON.stringify(
      {
        findings: [
          { file: "src/index.ts", line: 8, severity: "suggestion", category: "quality", description: "Consider extracting port to config module", suggestion: "Create src/config.ts for environment variables" },
          { file: "src/controllers/resource.ts", line: 4, severity: "warning", category: "quality", description: "Missing try-catch around async operations", suggestion: "Wrap in try-catch or use express-async-errors" },
        ],
        securityIssues: [
          { file: "src/routes/index.ts", type: "input-validation", severity: "medium", description: "No input validation on POST /resources", fix: "Add Zod schema validation middleware" },
        ],
        score: { quality: 7, security: 6, maintainability: 8 },
        approved: true,
        summary: "Code approved with minor suggestions. 2 quality findings and 1 security issue (input validation). Overall score: 7/10.",
      },
      null,
      2,
    ),

  deployment: () =>
    JSON.stringify(
      {
        files: [
          {
            path: "Dockerfile",
            language: "dockerfile",
            content: "FROM node:20-alpine AS builder\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nRUN npm run build\n\nFROM node:20-alpine\nWORKDIR /app\nCOPY --from=builder /app/dist ./dist\nCOPY --from=builder /app/node_modules ./node_modules\nCOPY package.json ./\nEXPOSE 3000\nCMD [\"node\", \"dist/index.js\"]",
            description: "Multi-stage Docker build",
          },
          {
            path: "docker-compose.yml",
            language: "yaml",
            content: "version: '3.8'\nservices:\n  app:\n    build: .\n    ports:\n      - '3000:3000'\n    environment:\n      - DATABASE_URL=postgresql://user:pass@db:5432/app\n    depends_on:\n      - db\n  db:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_USER: user\n      POSTGRES_PASSWORD: pass\n      POSTGRES_DB: app\n    volumes:\n      - pgdata:/var/lib/postgresql/data\nvolumes:\n  pgdata:",
            description: "Docker Compose for local development",
          },
          {
            path: ".github/workflows/deploy.yml",
            language: "yaml",
            content: "name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n      - run: npm ci\n      - run: npm test\n      - run: npm run build\n      - run: docker build -t app .",
            description: "GitHub Actions CI/CD pipeline",
          },
        ],
        deploymentStrategy: "Blue-green deployment with Docker containers. CI/CD via GitHub Actions.",
        environments: [
          { name: "development", config: { replicas: 1, resources: "256Mi/0.5CPU" } },
          { name: "production", config: { replicas: 3, resources: "512Mi/1CPU" } },
        ],
        summary: "Generated Dockerfile, docker-compose.yml, and CI/CD pipeline. Blue-green deployment strategy.",
      },
      null,
      2,
    ),

  monitoring: () =>
    JSON.stringify(
      {
        dashboards: [
          {
            name: "Service Overview",
            panels: [
              { title: "Request Rate", type: "graph", query: "rate(http_requests_total[5m])" },
              { title: "Error Rate", type: "graph", query: "rate(http_requests_total{status=~\"5..\"}[5m])" },
              { title: "P95 Latency", type: "stat", query: "histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))" },
              { title: "Active Connections", type: "stat", query: "node_active_connections" },
            ],
          },
        ],
        alerts: [
          { name: "High Error Rate", condition: "error_rate > 5%", severity: "critical", channel: "pagerduty" },
          { name: "High Latency", condition: "p95_latency > 2s", severity: "warning", channel: "slack" },
          { name: "Disk Usage", condition: "disk_usage > 85%", severity: "warning", channel: "slack" },
        ],
        healthChecks: [
          { name: "API Health", endpoint: "/api/health", interval: "30s", timeout: "5s" },
          { name: "Database", endpoint: "/api/health/db", interval: "60s", timeout: "10s" },
        ],
        summary: "Set up monitoring dashboard with 4 key panels, 3 alert rules, and 2 health checks.",
      },
      null,
      2,
    ),

  fact_check: (input) =>
    JSON.stringify(
      {
        verdict: "pass",
        issues: [],
        enrichedOutput: input.slice(0, 200),
        summary: "Mock fact-check: no issues found. (Note: real fact-check requires xAI Grok with web search capability.)",
      },
      null,
      2,
    ),
};

function detectTeam(messages: Array<{ role: string; content: string }>): TeamId {
  const systemMsg = messages.find((m) => m.role === "system")?.content ?? "";
  for (const team of Object.values(SDLC_TEAMS)) {
    if (systemMsg.includes(team.name) || systemMsg.includes(team.id)) {
      return team.id;
    }
  }
  return "development";
}

function extractUserInput(messages: Array<{ role: string; content: string }>): string {
  const userMsg = messages.filter((m) => m.role === "user").pop();
  return userMsg?.content ?? "";
}

export class MockProvider {
  async complete(
    messages: Array<{ role: string; content: string }>,
    _options?: { maxTokens?: number },
  ): Promise<{ content: string; tokensUsed: number; finishReason?: "stop" | "tool_use" }> {
    const team = detectTeam(messages);
    const input = extractUserInput(messages);
    const content = MOCK_RESPONSES[team](input);
    return { content, tokensUsed: Math.floor(content.length / 4), finishReason: "stop" as const };
  }

  async *stream(
    messages: Array<{ role: string; content: string }>,
  ): AsyncGenerator<string> {
    const { content } = await this.complete(messages);
    const chunkSize = 20;
    for (let i = 0; i < content.length; i += chunkSize) {
      yield content.slice(i, i + chunkSize);
      await new Promise((r) => setTimeout(r, 30));
    }
  }
}
