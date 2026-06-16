/**
 * Prompt assembly + response parsing for a Task Groups v2 `direct_llm` task.
 *
 * Extracted from TaskOrchestrator.executeDirectLlm (L3 — keep functions <30
 * lines / the orchestrator file <800). Pure + storage-free so it is trivially
 * unit-tested and carries no orchestration state.
 */
import type { TaskRow, TaskGroupIterationRow } from "@shared/schema";
import type { TaskResult } from "@shared/types";

/** Build the dependency-output context map keyed by dependency definition name. */
export function collectDepOutputs(
  task: TaskRow,
  definitions: TaskRow[],
  execs: ReadonlyArray<{ taskId: string | null; output: unknown }>,
): Record<string, unknown> {
  const depOutputs: Record<string, unknown> = {};
  for (const depId of task.dependsOn as string[]) {
    const depDef = definitions.find((d) => d.id === depId);
    const depExec = execs.find((e) => e.taskId === depId);
    if (depDef && depExec?.output) depOutputs[depDef.name] = depExec.output;
  }
  return depOutputs;
}

/** Compose the system prompt for a direct_llm task (group + objective + deps). */
export function buildSystemPrompt(
  task: TaskRow,
  group: { name: string },
  iteration: TaskGroupIterationRow,
  depOutputs: Record<string, unknown>,
): string {
  const depsBlock =
    Object.keys(depOutputs).length > 0
      ? `Results from prerequisite tasks:\n${JSON.stringify(depOutputs, null, 2)}`
      : "";
  return `You are completing a task as part of a larger task group.
Task group: ${group.name}
Overall objective: ${iteration.input}

Your specific task: ${task.name}
Description: ${task.description}

${depsBlock}

Respond with a JSON object:
{
  "summary": "Brief summary of what was accomplished",
  "output": { ... any structured output ... },
  "decisions": ["key decision 1", "key decision 2"]
}`;
}

/** Parse a gateway completion into a TaskResult, tolerating non-JSON content. */
export function parseDirectLlmResponse(content: string): TaskResult {
  try {
    const parsed = JSON.parse(content);
    return {
      summary: parsed.summary ?? content.slice(0, 200),
      output: parsed.output ?? { raw: content },
      decisions: parsed.decisions ?? [],
      artifacts: parsed.artifacts,
    };
  } catch {
    return {
      summary: content.slice(0, 200),
      output: { raw: content },
    };
  }
}
