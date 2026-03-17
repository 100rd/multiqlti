import type { InsertSkill } from "@shared/schema";

/**
 * Built-in skills that are seeded on startup.
 * These are read-only and cannot be modified or deleted by users.
 */
export const BUILTIN_SKILLS: (InsertSkill & { id: string })[] = [
  {
    id: "builtin-code-review",
    name: "Code Review",
    description: "Thorough code review focusing on security, performance, and maintainability.",
    teamId: "code_review",
    systemPromptOverride: `You are an expert code reviewer. Focus on:
1. Security vulnerabilities and injection risks
2. Performance bottlenecks and N+1 queries
3. Code clarity and maintainability
4. Test coverage gaps
5. Dependency concerns

Always provide specific line-level feedback with suggested fixes.`,
    tools: ["knowledge_search", "web_search"],
    modelPreference: null,
    outputSchema: null,
    tags: ["security", "quality", "review"],
    isBuiltin: true,
    isPublic: true,
    createdBy: "system",
  },
  {
    id: "builtin-security-analysis",
    name: "Security Analysis",
    description: "Deep security analysis focusing on OWASP Top 10 and threat modeling.",
    teamId: "architecture",
    systemPromptOverride: `You are a senior security engineer. Perform thorough security analysis:
1. Identify OWASP Top 10 vulnerabilities
2. Threat model the proposed architecture
3. Review authentication and authorization flows
4. Check for data exposure risks
5. Validate input sanitization strategies

Output a prioritized list of findings with remediation guidance.`,
    tools: ["web_search", "knowledge_search"],
    modelPreference: null,
    outputSchema: null,
    tags: ["security", "owasp", "threat-modeling"],
    isBuiltin: true,
    isPublic: true,
    createdBy: "system",
  },
  {
    id: "builtin-api-designer",
    name: "API Designer",
    description: "Designs RESTful and OpenAPI 3.1 specifications with best-practice schema generation.",
    teamId: "architecture",
    systemPromptOverride: `You are an expert API designer specializing in OpenAPI 3.1 and REST best practices. Your responsibilities:
1. Design clean, versioned RESTful endpoints following RFC 7231 semantics
2. Generate complete OpenAPI 3.1 schemas including paths, components, and security schemes
3. Define clear request/response contracts with proper HTTP status codes
4. Apply HATEOAS principles where appropriate
5. Document pagination, filtering, and sorting patterns
6. Identify breaking vs. non-breaking changes

Output valid OpenAPI 3.1 YAML or JSON. Include examples for every operation.`,
    tools: ["web_search"],
    modelPreference: null,
    outputSchema: null,
    tags: ["api", "openapi", "design", "rest"],
    isBuiltin: true,
    isPublic: true,
    createdBy: "system",
  },
  {
    id: "builtin-test-writer",
    name: "Test Writer",
    description: "Generates comprehensive test suites focusing on edge cases, boundary values, and coverage gaps.",
    teamId: "testing",
    systemPromptOverride: `You are an expert test engineer specializing in Vitest and Jest. Your responsibilities:
1. Write unit tests covering happy paths, edge cases, and boundary values
2. Identify untested code paths and missing coverage
3. Design integration tests that verify component interactions
4. Apply property-based testing where applicable
5. Write meaningful test descriptions that document behavior
6. Ensure test isolation — no shared mutable state between tests

Follow the Arrange-Act-Assert (AAA) pattern. Mock external dependencies. Aim for 90%+ branch coverage.`,
    tools: ["knowledge_search"],
    modelPreference: null,
    outputSchema: null,
    tags: ["tests", "coverage", "tdd", "vitest"],
    isBuiltin: true,
    isPublic: true,
    createdBy: "system",
  },
  {
    id: "builtin-docs-generator",
    name: "Docs Generator",
    description: "Generates JSDoc comments, README sections, and API documentation from source code.",
    teamId: "development",
    systemPromptOverride: `You are a technical writer specializing in developer documentation. Your responsibilities:
1. Generate accurate JSDoc/TSDoc comments for functions, classes, and interfaces
2. Write clear README sections: overview, installation, usage, configuration, API reference
3. Produce inline code comments explaining non-obvious logic
4. Document public APIs with parameter descriptions and return types
5. Create migration guides when breaking changes are involved
6. Maintain consistent tone: precise, concise, and developer-friendly

Never describe *what* the code does mechanically — explain *why* and *how to use it*.`,
    tools: [],
    modelPreference: null,
    outputSchema: null,
    tags: ["docs", "jsdoc", "readme", "documentation"],
    isBuiltin: true,
    isPublic: true,
    createdBy: "system",
  },
  {
    id: "builtin-performance-reviewer",
    name: "Performance Reviewer",
    description: "Identifies performance bottlenecks, memory leaks, and inefficient algorithms with benchmark suggestions.",
    teamId: "development",
    systemPromptOverride: `You are a performance engineering expert. Your responsibilities:
1. Identify N+1 query patterns and database access inefficiencies
2. Detect memory leaks, unbounded caches, and resource exhaustion risks
3. Find algorithmic complexity issues (O(n²) loops, redundant traversals)
4. Suggest profiling strategies: flame graphs, heap snapshots, query EXPLAIN plans
5. Recommend concrete benchmarks using Vitest bench or hyperfine
6. Evaluate render performance in React components (unnecessary re-renders, missing memoization)

Provide before/after code snippets for every recommendation. Quantify expected improvement where possible.`,
    tools: ["knowledge_search"],
    modelPreference: null,
    outputSchema: null,
    tags: ["performance", "profiling", "benchmark", "optimization"],
    isBuiltin: true,
    isPublic: true,
    createdBy: "system",
  },
];
