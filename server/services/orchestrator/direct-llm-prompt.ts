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

function asPlainObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Extract a JSON object from model content that may prepend preamble prose
 * ("Let me answer…") and/or wrap the JSON in a ``` / ```json fence — both of
 * which break a bare JSON.parse and would otherwise drop the model's real
 * `summary`/`output`/`decisions` fields. Tries: direct parse → fenced block →
 * first string-aware balanced {…} object. Returns null when there's no object.
 */
function extractJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  const direct = asPlainObject(safeJsonParse(trimmed));
  if (direct) return direct;

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const inFence = asPlainObject(safeJsonParse(fence[1].trim()));
    if (inFence) return inFence;
  }

  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (esc) {
      esc = false;
    } else if (ch === "\\") {
      esc = true;
    } else if (ch === '"') {
      inStr = !inStr;
    } else if (!inStr && ch === "{") {
      depth++;
    } else if (!inStr && ch === "}") {
      depth--;
      if (depth === 0) return asPlainObject(safeJsonParse(trimmed.slice(start, i + 1)));
    }
  }
  return null;
}

/** First non-empty line that isn't a markdown heading/fence, for a prose summary. */
function fallbackSummary(content: string): string {
  for (const line of content.split("\n")) {
    const t = line.trim().replace(/^#+\s*/, "").replace(/^`{1,3}(?:json)?$/i, "").trim();
    if (t) return t.slice(0, 280);
  }
  return content.trim().slice(0, 280);
}

/**
 * Parse a gateway completion into a TaskResult, tolerating non-JSON content.
 * Models often answer with a preamble + a ```json block (or pure prose); pull
 * the real summary/output/decisions when a JSON object is present, and fall
 * back to a clean prose summary + the full raw text otherwise (so the raw
 * reasoning is never lost).
 */
export function parseDirectLlmResponse(content: string): TaskResult {
  const parsed = extractJsonObject(content);
  if (parsed) {
    const summary =
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary
        : fallbackSummary(content);
    const output = asPlainObject(parsed.output) ?? asPlainObject(parsed) ?? { raw: content };
    const decisions = Array.isArray(parsed.decisions)
      ? parsed.decisions.filter((d): d is string => typeof d === "string")
      : [];
    const artifacts = Array.isArray(parsed.artifacts)
      ? (parsed.artifacts as Record<string, unknown>[])
      : undefined;
    return { summary, output, decisions, artifacts };
  }
  return { summary: fallbackSummary(content), output: { raw: content } };
}
