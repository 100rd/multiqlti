import type { Gateway } from "../gateway/index";
import type { ParallelConfig, SplitPlan, SubTask } from "@shared/types";

const MIN_INPUT_LENGTH_TO_SPLIT = 200;

/** Picks the cheapest model slug based on a simple cost-tier heuristic. */
function pickCheapestModelSlug(splitterSlug: string | undefined, fallback: string): string {
  return splitterSlug ?? fallback;
}

function buildSplitterSystemPrompt(teamId: string, maxAgents: number): string {
  return `You are a task splitter. Given a task for the "${teamId}" stage, decide:
1. Can this task be meaningfully parallelized?
2. If yes, split into independent subtasks (max ${maxAgents}).

Rules:
- Each subtask MUST be independent (no cross-dependencies)
- Each subtask must be self-contained with enough context
- Don't split trivially small tasks (< ${MIN_INPUT_LENGTH_TO_SPLIT} words input)
- Consider: are there natural boundaries (files, modules, test types)?

Output ONLY valid JSON matching this schema:
{
  "shouldSplit": boolean,
  "reason": string,
  "subtasks": [
    {
      "id": "subtask-1",
      "title": "...",
      "description": "...",
      "context": ["..."],
      "suggestedModel": "...",
      "estimatedComplexity": "low|medium|high"
    }
  ]
}`;
}

function isTooShortToSplit(input: string): boolean {
  return input.trim().length < MIN_INPUT_LENGTH_TO_SPLIT;
}

function parseSplitPlan(raw: string): SplitPlan {
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).shouldSplit !== "boolean"
    ) {
      return { shouldSplit: false, reason: "invalid LLM response format", subtasks: [] };
    }

    const obj = parsed as {
      shouldSplit: boolean;
      reason?: unknown;
      subtasks?: unknown[];
    };

    const subtasks = Array.isArray(obj.subtasks)
      ? (obj.subtasks as SubTask[]).filter(isValidSubTask)
      : [];

    return {
      shouldSplit: obj.shouldSplit,
      reason: typeof obj.reason === "string" ? obj.reason : "",
      subtasks,
    };
  } catch {
    return { shouldSplit: false, reason: "failed to parse LLM response", subtasks: [] };
  }
}

function isValidSubTask(item: unknown): item is SubTask {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.title === "string" &&
    typeof obj.description === "string" &&
    Array.isArray(obj.context)
  );
}

function capSubtasks(plan: SplitPlan, maxAgents: number): SplitPlan {
  if (plan.subtasks.length <= maxAgents) return plan;
  return {
    ...plan,
    subtasks: plan.subtasks.slice(0, maxAgents),
  };
}

export class Splitter {
  private gateway: Gateway;
  private config: ParallelConfig;

  constructor(gateway: Gateway, config: ParallelConfig) {
    this.gateway = gateway;
    this.config = config;
  }

  async split(stageInput: string, teamId: string): Promise<SplitPlan> {
    if (!this.config.enabled) {
      return { shouldSplit: false, reason: "parallel execution disabled", subtasks: [] };
    }

    if (isTooShortToSplit(stageInput)) {
      return { shouldSplit: false, reason: "input too short to benefit from splitting", subtasks: [] };
    }

    const modelSlug = pickCheapestModelSlug(this.config.splitterModelSlug, "mock");
    const systemPrompt = buildSplitterSystemPrompt(teamId, this.config.maxAgents);

    const response = await this.gateway.complete({
      modelSlug,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Task input:\n\n${stageInput}` },
      ],
    });

    const plan = parseSplitPlan(response.content);
    return capSubtasks(plan, this.config.maxAgents);
  }
}
