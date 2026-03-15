import type { Gateway } from "../gateway/index";
import type { MergeStrategy, SubTaskResult, TeamId } from "@shared/types";

/** Default merge strategy per team type. */
export const STAGE_MERGE_DEFAULTS: Record<TeamId, "concatenate" | "review"> = {
  planning: "review",
  architecture: "review",
  development: "review",
  testing: "concatenate",
  code_review: "concatenate",
  deployment: "review",
  monitoring: "concatenate",
  fact_check: "concatenate",
};

function resolveStrategy(strategy: MergeStrategy, teamId: string): "concatenate" | "review" {
  if (strategy !== "auto") return strategy;
  return STAGE_MERGE_DEFAULTS[teamId as TeamId] ?? "review";
}

function concatenateResults(results: SubTaskResult[]): string {
  return results
    .map((r) => `### ${r.subtask.title}\n\n${r.output}`)
    .join("\n\n---\n\n");
}

function buildMergerSystemPrompt(subtaskCount: number): string {
  return `You received outputs from ${subtaskCount} agents working on subtasks of the same stage.
Review for: conflicts, duplications, missing integration points.
Produce one unified output that coherently combines all results.`;
}

async function reviewMerge(
  results: SubTaskResult[],
  modelSlug: string,
  gateway: Gateway,
): Promise<string> {
  const combinedInputs = results
    .map((r, idx) => `### Subtask ${idx + 1}: ${r.subtask.title}\n\n${r.output}`)
    .join("\n\n---\n\n");

  const response = await gateway.complete({
    modelSlug,
    messages: [
      { role: "system", content: buildMergerSystemPrompt(results.length) },
      { role: "user", content: `Subtask outputs:\n\n${combinedInputs}\n\nProduce one unified output:` },
    ],
  });

  return response.content;
}

export class Merger {
  async merge(
    subtaskResults: SubTaskResult[],
    strategy: MergeStrategy,
    teamId: string,
    mergerModelSlug: string,
    gateway: Gateway,
  ): Promise<string> {
    if (subtaskResults.length === 0) return "";

    const resolved = resolveStrategy(strategy, teamId);

    if (resolved === "concatenate") {
      return concatenateResults(subtaskResults);
    }

    return reviewMerge(subtaskResults, mergerModelSlug, gateway);
  }
}
