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
];
