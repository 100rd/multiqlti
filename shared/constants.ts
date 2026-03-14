import type { TeamConfig, TeamId, PipelineStageConfig } from "./types";

export const SDLC_TEAMS: Record<TeamId, TeamConfig> = {
  planning: {
    id: "planning",
    name: "Planning",
    description: "Requirements analysis, task breakdown, acceptance criteria",
    defaultModelSlug: "llama3-70b",
    systemPromptTemplate: `You are a senior software project planner. Analyze the given task and produce a structured plan.

Your output MUST be valid JSON with this structure:
{
  "tasks": [{ "id": "string", "title": "string", "description": "string", "priority": "high|medium|low", "estimatedHours": number }],
  "acceptanceCriteria": ["string"],
  "risks": [{ "description": "string", "severity": "high|medium|low", "mitigation": "string" }],
  "summary": "string"
}

If you need clarification from the user, include a top-level "questions" array with your questions as strings.
Be specific, actionable, and thorough.`,
    inputSchema: { taskDescription: "The user requirement or feature request" },
    outputSchema: {
      tasks: "Array of subtasks with priorities",
      acceptanceCriteria: "Measurable acceptance criteria",
      risks: "Identified risks with mitigations",
    },
    tools: ["task_breakdown", "requirements_parser"],
    color: "blue",
    icon: "ClipboardList",
  },

  architecture: {
    id: "architecture",
    name: "Architecture",
    description: "System design, tech stack decisions, component structure",
    defaultModelSlug: "llama3-70b",
    systemPromptTemplate: `You are a senior software architect. Based on the planning output, design the system architecture.

Your output MUST be valid JSON with this structure:
{
  "components": [{ "name": "string", "type": "service|library|database|queue|gateway", "description": "string", "dependencies": ["string"] }],
  "techStack": { "language": "string", "framework": "string", "database": "string", "infrastructure": "string" },
  "dataFlow": "string description of data flow",
  "apiEndpoints": [{ "method": "string", "path": "string", "description": "string" }],
  "summary": "string"
}

If you need clarification, include a "questions" array.`,
    inputSchema: { planningOutput: "Output from the planning phase" },
    outputSchema: {
      components: "System components and their relationships",
      techStack: "Technology stack decisions",
      dataFlow: "Data flow description",
    },
    tools: ["diagram_generator", "tech_advisor"],
    color: "purple",
    icon: "Boxes",
  },

  development: {
    id: "development",
    name: "Development",
    description: "Code generation and implementation",
    defaultModelSlug: "deepseek-coder",
    systemPromptTemplate: `You are an expert software developer. Based on the architecture, generate production-ready code.

Your output MUST be valid JSON with this structure:
{
  "files": [{ "path": "string", "language": "string", "content": "string", "description": "string" }],
  "dependencies": [{ "name": "string", "version": "string" }],
  "summary": "string"
}

Write clean, well-structured code. Include error handling and types.
If you need clarification, include a "questions" array.`,
    inputSchema: { architectureOutput: "Output from the architecture phase" },
    outputSchema: {
      files: "Generated source files",
      dependencies: "Required packages",
    },
    tools: ["code_generator", "dependency_resolver"],
    color: "green",
    icon: "Code",
  },

  testing: {
    id: "testing",
    name: "Testing",
    description: "Test generation, execution strategy, coverage analysis",
    defaultModelSlug: "mixtral-8x7b",
    systemPromptTemplate: `You are a QA engineer. Generate comprehensive tests for the code.

Your output MUST be valid JSON with this structure:
{
  "testFiles": [{ "path": "string", "language": "string", "content": "string", "testCount": number }],
  "testStrategy": "string",
  "coverageTargets": { "lines": number, "branches": number, "functions": number },
  "issues": [{ "file": "string", "line": number, "severity": "critical|warning|info", "description": "string" }],
  "summary": "string"
}

If you need clarification, include a "questions" array.`,
    inputSchema: { developmentOutput: "Output from the development phase" },
    outputSchema: {
      testFiles: "Test files",
      coverageTargets: "Coverage targets",
      issues: "Potential issues found",
    },
    tools: ["test_generator", "coverage_analyzer"],
    color: "amber",
    icon: "TestTube",
  },

  code_review: {
    id: "code_review",
    name: "Code Review",
    description: "Quality analysis, security audit, best practices",
    defaultModelSlug: "llama3-70b",
    systemPromptTemplate: `You are a senior code reviewer. Review the code and tests for quality and security.

Your output MUST be valid JSON with this structure:
{
  "findings": [{ "file": "string", "line": number, "severity": "critical|warning|suggestion", "category": "quality|performance|maintainability", "description": "string", "suggestion": "string" }],
  "securityIssues": [{ "file": "string", "type": "string", "severity": "critical|high|medium|low", "description": "string", "fix": "string" }],
  "score": { "quality": number, "security": number, "maintainability": number },
  "approved": boolean,
  "summary": "string"
}

If you need clarification, include a "questions" array.`,
    inputSchema: {
      developmentOutput: "Code from development phase",
      testingOutput: "Tests from testing phase",
    },
    outputSchema: {
      findings: "Review findings",
      securityIssues: "Security vulnerabilities",
      approved: "Whether code passes review",
    },
    tools: ["static_analyzer", "security_scanner"],
    color: "orange",
    icon: "SearchCheck",
  },

  deployment: {
    id: "deployment",
    name: "Deployment",
    description: "CI/CD config, Docker/K8s manifests, deployment scripts",
    defaultModelSlug: "deepseek-coder",
    systemPromptTemplate: `You are a DevOps engineer. Generate deployment configurations.

Your output MUST be valid JSON with this structure:
{
  "files": [{ "path": "string", "language": "string", "content": "string", "description": "string" }],
  "deploymentStrategy": "string",
  "environments": [{ "name": "string", "config": {} }],
  "summary": "string"
}

Generate Dockerfiles, docker-compose, CI/CD pipelines, and K8s manifests as appropriate.
If you need clarification, include a "questions" array.`,
    inputSchema: { allOutputs: "Aggregated outputs from all prior phases" },
    outputSchema: {
      files: "Deployment configuration files",
      deploymentStrategy: "Deployment strategy description",
    },
    tools: ["docker_builder", "k8s_generator", "cicd_builder"],
    color: "cyan",
    icon: "Rocket",
  },

  monitoring: {
    id: "monitoring",
    name: "Monitoring",
    description: "Observability setup, alerting rules, health checks",
    defaultModelSlug: "mixtral-8x7b",
    systemPromptTemplate: `You are an SRE engineer. Set up monitoring and observability.

Your output MUST be valid JSON with this structure:
{
  "dashboards": [{ "name": "string", "panels": [{ "title": "string", "type": "graph|stat|table", "query": "string" }] }],
  "alerts": [{ "name": "string", "condition": "string", "severity": "critical|warning|info", "channel": "string" }],
  "healthChecks": [{ "name": "string", "endpoint": "string", "interval": "string", "timeout": "string" }],
  "summary": "string"
}

If you need clarification, include a "questions" array.`,
    inputSchema: { deploymentOutput: "Output from the deployment phase" },
    outputSchema: {
      dashboards: "Monitoring dashboards",
      alerts: "Alert rules",
      healthChecks: "Health check endpoints",
    },
    tools: ["metrics_builder", "alert_generator"],
    color: "rose",
    icon: "Activity",
  },
};

export const TEAM_ORDER: TeamId[] = [
  "planning",
  "architecture",
  "development",
  "testing",
  "code_review",
  "deployment",
  "monitoring",
];

export const DEFAULT_PIPELINE_STAGES: PipelineStageConfig[] = TEAM_ORDER.map(
  (teamId) => ({
    teamId,
    modelSlug: SDLC_TEAMS[teamId].defaultModelSlug,
    enabled: true,
  }),
);

export const DEFAULT_MODELS = [
  {
    name: "Llama 3 70B Instruct",
    slug: "llama3-70b",
    provider: "mock" as const,
    endpoint: null,
    contextLimit: 8192,
    capabilities: ["planning", "architecture", "review", "general"],
    isActive: true,
  },
  {
    name: "DeepSeek Coder 33B",
    slug: "deepseek-coder",
    provider: "mock" as const,
    endpoint: null,
    contextLimit: 16384,
    capabilities: ["coding", "deployment", "refactoring"],
    isActive: true,
  },
  {
    name: "Mixtral 8x7B v0.1",
    slug: "mixtral-8x7b",
    provider: "mock" as const,
    endpoint: null,
    contextLimit: 32768,
    capabilities: ["testing", "analysis", "monitoring", "general"],
    isActive: true,
  },
  {
    name: "Phi-3 Mini 128K",
    slug: "phi3-mini",
    provider: "mock" as const,
    endpoint: null,
    contextLimit: 131072,
    capabilities: ["summarization", "classification", "lightweight"],
    isActive: true,
  },

  // ─── Anthropic ──────────────────────────────────────
  {
    name: "Claude Sonnet 4.6",
    slug: "claude-sonnet-4-6",
    modelId: "claude-sonnet-4-6",
    provider: "anthropic" as const,
    endpoint: null,
    contextLimit: 200000,
    capabilities: ["planning", "architecture", "code_review", "reasoning", "general"],
    isActive: true,
  },
  {
    name: "Claude Haiku 4.5",
    slug: "claude-haiku-4-5",
    modelId: "claude-haiku-4-5",
    provider: "anthropic" as const,
    endpoint: null,
    contextLimit: 200000,
    capabilities: ["testing", "summarization", "lightweight", "fast"],
    isActive: true,
  },

  // ─── Google ─────────────────────────────────────────
  {
    name: "Gemini 2.0 Flash",
    slug: "gemini-2-0-flash",
    modelId: "gemini-2.0-flash",
    provider: "google" as const,
    endpoint: null,
    contextLimit: 1048576,
    capabilities: ["development", "testing", "analysis", "multimodal", "fast"],
    isActive: true,
  },

  // ─── xAI ────────────────────────────────────────────
  {
    name: "Grok 3",
    slug: "grok-3",
    modelId: "grok-3",
    provider: "xai" as const,
    endpoint: null,
    contextLimit: 131072,
    capabilities: ["planning", "architecture", "development", "reasoning"],
    isActive: true,
  },
  {
    name: "Grok 3 Mini",
    slug: "grok-3-mini",
    modelId: "grok-3-mini",
    provider: "xai" as const,
    endpoint: null,
    contextLimit: 131072,
    capabilities: ["testing", "summarization", "lightweight", "fast"],
    isActive: true,
  },
];
