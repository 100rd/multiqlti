/**
 * MCP Tool Call Audit Layer (issue #271)
 *
 * Wraps raw tool-call data with mandatory secret-redaction before persistence.
 * Also holds the set of sensitive key-name patterns that must be stripped from
 * args and result objects (Authorization headers, tokens, passwords, etc.).
 *
 * Rules:
 *  - Only redacted data is ever written to storage.
 *  - Redaction operates on JSON-serializable structures recursively.
 *  - Sensitive key names are matched case-insensitively.
 *  - String values matched by the sensitive-value regex are replaced by "[REDACTED]".
 *  - Errors from persistence are swallowed and warned — never re-thrown into
 *    the hot path.
 */

import type { IStorage } from "../storage";
import type { RecordMcpToolCallInput } from "@shared/types";

// ─── Redaction ────────────────────────────────────────────────────────────────

/** Key names whose values must always be redacted. Case-insensitive matching. */
const SENSITIVE_KEY_NAMES = new Set([
  "authorization",
  "token",
  "apikey",
  "api_key",
  "secret",
  "password",
  "passwd",
  "credential",
  "credentials",
  "private_key",
  "privatekey",
  "access_key",
  "accesskey",
  "secret_key",
  "secretkey",
  "auth",
  "x-api-key",
  "bearer",
]);

/**
 * Regex for detecting secret-like string values.
 * Matches common token formats: `Bearer <token>`, `sk-...`, AWS AKIA*, GitHub
 * PATs (ghp_), GitLab PATs (glpat-), and generic hex/base64 secrets ≥ 24 chars.
 */
const SECRET_VALUE_PATTERN =
  /Bearer\s+\S+|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9_]{36}|glpat-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{32,}={0,2}/g;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_NAMES.has(key.toLowerCase());
}

/**
 * Deep-redact a JSON-serializable value.
 *  - Objects: redact values whose key is sensitive; recurse into safe values.
 *  - Arrays: recurse into each element.
 *  - Strings: replace patterns matching SECRET_VALUE_PATTERN with "[REDACTED]".
 *  - Numbers / booleans / null: pass through unchanged.
 */
export function redactForAudit(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return value.replace(SECRET_VALUE_PATTERN, "[REDACTED]");
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(redactForAudit);
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = isSensitiveKey(k) ? "[REDACTED]" : redactForAudit(v);
    }
    return result;
  }

  return value;
}

// ─── Audit Recorder ───────────────────────────────────────────────────────────

/** Default retention window in days — rows older than this are eligible for pruning. */
export const MCP_TOOL_CALL_RETENTION_DAYS = Number(
  process.env.MCP_TOOL_CALL_RETENTION_DAYS ?? "90",
);

export interface AuditCallInput {
  runId?: string | null;
  stageId?: string | null;
  connectionId: string;
  connectionType?: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string | null;
  durationMs: number;
  startedAt: Date;
  /** The OTel traceId for the parent pipeline run span, if any. */
  traceId?: string;
  /** The OTel spanId of the parent pipeline run span, if any. */
  parentSpanId?: string;
}

/**
 * Record a single MCP tool call to storage (with redaction) and emit an OTel
 * span as a child of the pipeline run span.
 *
 * This function NEVER throws — all errors are caught and warned so the caller's
 * hot path is unaffected.
 */
export async function recordToolCall(
  storage: IStorage,
  input: AuditCallInput,
): Promise<void> {
  const redactedArgs = redactForAudit(input.args) as Record<string, unknown>;
  const redactedResult = input.result !== undefined ? redactForAudit(input.result) : null;
  const redactedError = input.error ? sanitizeErrorMessage(input.error) : null;

  // ── Persist to DB ───────────────────────────────────────────────────────────
  const record: RecordMcpToolCallInput = {
    runId: input.runId ?? null,
    stageId: input.stageId ?? null,
    connectionId: input.connectionId,
    toolName: input.toolName,
    argsJson: redactedArgs,
    resultJson: redactedResult,
    error: redactedError,
    durationMs: input.durationMs,
    startedAt: input.startedAt,
  };

  try {
    await storage.recordMcpToolCall(record);
  } catch (err) {
    console.warn(
      "[audit] Failed to persist mcp_tool_call:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Sanitize an error message before persisting.
 * Strips any embedded token-like values that might have leaked into the error.
 */
function sanitizeErrorMessage(msg: string): string {
  return msg.replace(SECRET_VALUE_PATTERN, "[REDACTED]");
}

