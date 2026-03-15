/**
 * DAG Condition Evaluator — Phase 6.2
 *
 * Pure functions for evaluating DAGEdge conditions against stage outputs.
 * NEVER uses eval() — conditions use a safe operator struct.
 */
import type { DAGCondition } from "@shared/types";

/** Regex for valid field paths: alphanumeric+underscore, max 3 dot-separated segments. */
const FIELD_PATH_RE = /^[a-zA-Z0-9_]{1,50}(\.[a-zA-Z0-9_]{1,50}){0,2}$/;

/**
 * Resolves a dot-path field from an output object.
 * Returns undefined for invalid paths or missing values.
 * Security: rejects paths not matching FIELD_PATH_RE.
 */
export function resolvePath(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  if (!FIELD_PATH_RE.test(path)) return undefined;
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Evaluates a DAGCondition against the completed stage's output.
 * Returns true if the condition is satisfied, false otherwise.
 */
export function evaluateCondition(
  output: Record<string, unknown>,
  condition: DAGCondition,
): boolean {
  const resolved = resolvePath(output, condition.field);

  switch (condition.operator) {
    case "exists":
      return resolved !== undefined && resolved !== null;

    case "eq":
      return resolved === condition.value;

    case "neq":
      return resolved !== condition.value;

    case "gt":
      return typeof resolved === "number" &&
        typeof condition.value === "number" &&
        resolved > condition.value;

    case "lt":
      return typeof resolved === "number" &&
        typeof condition.value === "number" &&
        resolved < condition.value;

    case "contains":
      if (typeof resolved === "string" && typeof condition.value === "string") {
        return resolved.includes(condition.value);
      }
      if (Array.isArray(resolved)) {
        return resolved.includes(condition.value);
      }
      return false;

    default:
      return false;
  }
}
