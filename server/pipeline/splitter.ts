import type { Gateway } from "../gateway/index";
import type { ParallelConfig, SplitPlan, SubTask, ShardingMode } from "@shared/types";
import {
  estimateComplexity,
  computeShardCount,
  DEFAULT_SHARD_TARGET_SIZE,
} from "./complexity-estimator";
import { pickCheapestModelSlug, checkSplitCost } from "./model-tier-router";

const MIN_INPUT_LENGTH_TO_SPLIT = 200;

// ─── Sharding system prompt ───────────────────────────────────────────────────

function shardingModeHint(mode: ShardingMode): string {
  switch (mode) {
    case "equal":
      return "Divide the work into equal-sized chunks.";
    case "weighted":
      return "Divide the work so that more complex parts get their own chunk (weight by estimated effort).";
    case "natural":
      return "Split along natural boundaries such as file boundaries, module boundaries, or test suites.";
  }
}

function buildSplitterSystemPrompt(
  teamId: string,
  maxAgents: number,
  shardCount: number,
  shardingMode: ShardingMode,
): string {
  return `You are a task splitter. Given a task for the "${teamId}" stage, decide:
1. Can this task be meaningfully parallelized?
2. If yes, split into independent subtasks (target: ${shardCount}, max: ${maxAgents}).

Sharding strategy: ${shardingModeHint(shardingMode)}

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

// ─── Validation ───────────────────────────────────────────────────────────────

function isTooShortToSplit(input: string): boolean {
  return input.trim().length < MIN_INPUT_LENGTH_TO_SPLIT;
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

function capSubtasks(plan: SplitPlan, maxAgents: number): SplitPlan {
  if (plan.subtasks.length <= maxAgents) return plan;
  return {
    ...plan,
    subtasks: plan.subtasks.slice(0, maxAgents),
  };
}

// ─── Pre-check result ─────────────────────────────────────────────────────────

export interface SplitPreCheck {
  shardCount: number;
  shardingMode: ShardingMode;
  complexityScore: number;
  cheapModelSlug: string;
  costAction: "proceed" | "warn" | "block";
  costMessage?: string;
  estimatedCostUsd: number;
}

// ─── Splitter class ───────────────────────────────────────────────────────────

export class Splitter {
  private gateway: Gateway;
  private config: ParallelConfig;

  constructor(gateway: Gateway, config: ParallelConfig) {
    this.gateway = gateway;
    this.config = config;
  }

  /**
   * Pre-split analysis: compute shards and cost estimate without calling the LLM.
   * Callers may surface the warning or abort when costAction === "block".
   */
  preCheck(stageInput: string, primaryModelSlug: string): SplitPreCheck {
    const shardingMode: ShardingMode = this.config.shardingStrategy ?? "equal";
    const { score } = estimateComplexity(stageInput);
    const shardCount = computeShardCount(
      score,
      this.config.shardTargetSize ?? DEFAULT_SHARD_TARGET_SIZE,
      this.config.maxAgents,
    );
    const cheapModelSlug = pickCheapestModelSlug(primaryModelSlug, primaryModelSlug);

    const inputTokens = Math.ceil(stageInput.length / 4);
    const costResult = checkSplitCost(
      inputTokens,
      shardCount,
      primaryModelSlug,
      this.config.costThreshold,
    );

    return {
      shardCount,
      shardingMode,
      complexityScore: score,
      cheapModelSlug,
      costAction: costResult.action,
      costMessage: costResult.action !== "proceed" ? costResult.message : undefined,
      estimatedCostUsd: costResult.estimate.totalCostUsd,
    };
  }

  async split(
    stageInput: string,
    teamId: string,
    primaryModelSlug?: string,
  ): Promise<SplitPlan & { preCheck?: SplitPreCheck }> {
    if (!this.config.enabled) {
      return { shouldSplit: false, reason: "parallel execution disabled", subtasks: [] };
    }

    if (isTooShortToSplit(stageInput)) {
      return {
        shouldSplit: false,
        reason: "input too short to benefit from splitting",
        subtasks: [],
      };
    }

    // ── Dynamic sharding ──────────────────────────────────────────────────────
    const shardingMode: ShardingMode = this.config.shardingStrategy ?? "equal";
    const { score } = estimateComplexity(stageInput);
    const shardCount = computeShardCount(
      score,
      this.config.shardTargetSize ?? DEFAULT_SHARD_TARGET_SIZE,
      this.config.maxAgents,
    );

    // ── Model-tier routing ────────────────────────────────────────────────────
    const resolvedPrimary = primaryModelSlug ?? this.config.splitterModelSlug ?? "mock";
    const cheapModel = pickCheapestModelSlug(resolvedPrimary, resolvedPrimary);
    const modelSlug = this.config.splitterModelSlug ?? cheapModel;

    // ── Cost pre-check ────────────────────────────────────────────────────────
    const inputTokens = Math.ceil(stageInput.length / 4);
    const costResult = checkSplitCost(
      inputTokens,
      shardCount,
      resolvedPrimary,
      this.config.costThreshold,
    );

    const preCheck: SplitPreCheck = {
      shardCount,
      shardingMode,
      complexityScore: score,
      cheapModelSlug: cheapModel,
      costAction: costResult.action,
      costMessage: costResult.action !== "proceed" ? costResult.message : undefined,
      estimatedCostUsd: costResult.estimate.totalCostUsd,
    };

    if (costResult.action === "block") {
      return {
        shouldSplit: false,
        reason: `Split blocked: ${costResult.message ?? "cost limit exceeded"}`,
        subtasks: [],
        preCheck,
      };
    }

    // ── LLM splitting call ────────────────────────────────────────────────────
    const systemPrompt = buildSplitterSystemPrompt(
      teamId,
      this.config.maxAgents,
      shardCount,
      shardingMode,
    );

    const response = await this.gateway.complete({
      modelSlug,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Task input:\n\n${stageInput}` },
      ],
    });

    const plan = parseSplitPlan(response.content);
    const capped = capSubtasks(plan, this.config.maxAgents);

    return { ...capped, preCheck };
  }
}
