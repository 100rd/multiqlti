import type { TeamId, InsertMemory, MemoryType, TeamMemoryHint } from "@shared/types";

type ItemRecord = Record<string, unknown>;

type StageRule = {
  arrayPath?: string;
  field?: string;
  condition?: (item: ItemRecord) => boolean;
  type: MemoryType;
  keyFn: (item: ItemRecord, index: number) => string;
  contentFn: (item: ItemRecord) => string;
};

const STAGE_RULES: Partial<Record<TeamId, StageRule[]>> = {
  planning: [
    {
      arrayPath: "tasks",
      type: "decision",
      keyFn: (_item, i) => `task-${i}`,
      contentFn: (item) => String(item.title ?? ""),
    },
    {
      arrayPath: "risks",
      type: "issue",
      keyFn: (_item, i) => `risk-${i}`,
      contentFn: (item) => String(item.description ?? ""),
    },
  ],
  architecture: [
    {
      // techStack is an object — handled specially in extractByRules
      field: "techStack",
      type: "decision",
      keyFn: (_item, _i) => "tech-stack",
      contentFn: (item) => String(item.value ?? ""),
    },
    {
      arrayPath: "components",
      type: "fact",
      keyFn: (item) => `component-${String(item.name ?? "unknown")}`,
      contentFn: (item) => String(item.name ?? ""),
    },
  ],
  development: [
    {
      arrayPath: "dependencies",
      type: "dependency",
      keyFn: (item) => `dep-${String(item.name ?? "unknown")}`,
      contentFn: (item) => String(item.name ?? ""),
    },
  ],
  testing: [
    {
      arrayPath: "issues",
      condition: (item) => item.severity === "critical",
      type: "issue",
      keyFn: (_item, i) => `test-issue-${i}`,
      contentFn: (item) => String(item.description ?? ""),
    },
  ],
  code_review: [
    {
      arrayPath: "securityIssues",
      type: "issue",
      keyFn: (_item, i) => `security-${i}`,
      contentFn: (item) => String(item.description ?? ""),
    },
  ],
  deployment: [
    {
      field: "deploymentStrategy",
      type: "decision",
      keyFn: () => "deploy-strategy",
      contentFn: (item) => String(item.value ?? ""),
    },
  ],
};

export class MemoryExtractor {
  async extractFromStageResult(
    teamId: TeamId,
    runId: number,
    pipelineId: number,
    output: Record<string, unknown>,
  ): Promise<InsertMemory[]> {
    const ruleMemories = this.extractByRules(teamId, pipelineId, runId, output);
    const hintMemories = this.extractModelHints(pipelineId, runId, output);
    return [...ruleMemories, ...hintMemories];
  }

  private extractByRules(
    teamId: TeamId,
    pipelineId: number,
    runId: number,
    output: Record<string, unknown>,
  ): InsertMemory[] {
    const rules = STAGE_RULES[teamId];
    if (!rules) return [];

    const results: InsertMemory[] = [];
    const source = `${teamId}/run-${runId}`;

    for (const rule of rules) {
      if (rule.arrayPath) {
        const arr = output[rule.arrayPath];
        if (!Array.isArray(arr)) continue;

        arr.forEach((rawItem: unknown, i: number) => {
          const item = rawItem as ItemRecord;
          if (rule.condition && !rule.condition(item)) return;
          const content = rule.contentFn(item);
          if (!content) return;
          results.push({
            scope: "pipeline",
            scopeId: String(pipelineId),
            type: rule.type,
            key: rule.keyFn(item, i),
            content,
            source,
            createdByRunId: runId,
          });
        });
      } else if (rule.field) {
        const value = output[rule.field];
        if (value === undefined || value === null) continue;

        // techStack is a name→value object — emit one memory per key
        if (rule.field === "techStack" && typeof value === "object" && !Array.isArray(value)) {
          Object.entries(value as Record<string, unknown>).forEach(([name, v]) => {
            results.push({
              scope: "pipeline",
              scopeId: String(pipelineId),
              type: rule.type,
              key: `tech-${name}`,
              content: String(v ?? ""),
              source,
              createdByRunId: runId,
            });
          });
        } else {
          const item: ItemRecord = { value };
          const content = rule.contentFn(item);
          if (!content) continue;
          results.push({
            scope: "pipeline",
            scopeId: String(pipelineId),
            type: rule.type,
            key: rule.keyFn(item, 0),
            content,
            source,
            createdByRunId: runId,
          });
        }
      }
    }

    return results;
  }

  private extractModelHints(
    pipelineId: number,
    runId: number,
    output: Record<string, unknown>,
  ): InsertMemory[] {
    const rawHints = output.memories;
    if (!Array.isArray(rawHints)) return [];

    const source = `model-hints/run-${runId}`;
    const results: InsertMemory[] = [];

    for (const hint of rawHints) {
      const h = hint as TeamMemoryHint;
      if (!h.key || !h.content || !h.type) continue;
      results.push({
        scope: "pipeline",
        scopeId: String(pipelineId),
        type: h.type,
        key: h.key,
        content: h.content,
        source,
        createdByRunId: runId,
      });
    }

    return results;
  }
}
