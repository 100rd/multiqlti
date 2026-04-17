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
import { tracer } from "../tracing/tracer";
import { exportTrace } from "../tracing/otlp-exporter";

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
  pipelineRunId?: string | null;
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
    pipelineRunId: input.pipelineRunId ?? null,
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

  // ── OTel span ───────────────────────────────────────────────────────────────
  if (input.traceId) {
    emitOtelSpan(input);
  }
}

/**
 * Sanitize an error message before persisting.
 * Strips any embedded token-like values that might have leaked into the error.
 */
function sanitizeErrorMessage(msg: string): string {
  return msg.replace(SECRET_VALUE_PATTERN, "[REDACTED]");
}

/**
 * Emit an OTel span for the tool call as a child of the pipeline run span.
 * Uses the existing in-process Tracer + OTLP exporter.
 * Errors are swallowed — observability must not affect correctness.
 */
function emitOtelSpan(input: AuditCallInput): void {
  try {
    const traceId = input.traceId!;
    const spanId = tracer.startSpan(
      traceId,
      `mcp.tool_call/${input.toolName}`,
      input.parentSpanId,
    );

    const attributes: Record<string, string | number> = {
      "connection.id": input.connectionId,
      "tool.name": input.toolName,
      "duration_ms": input.durationMs,
    };
    if (input.connectionType) {
      attributes["connection.type"] = input.connectionType;
    }
    if (input.stageId) {
      attributes["stage.id"] = input.stageId;
    }

    const status = input.error ? "error" : "ok";

    if (input.error) {
      // Use the already-sanitized error message
      attributes["error"] = sanitizeErrorMessage(input.error);
    }

    tracer.endSpan(spanId, status, attributes);

    // Export the single span via the same OTLP exporter used for pipeline spans.
    // We build a minimal PipelineTrace wrapping just this span.
    const span = buildMinimalSpan(spanId, traceId, input);

    void exportTrace({
      traceId,
      runId: input.pipelineRunId ?? "",
      spans: [span],
    });
  } catch (err) {
    console.warn(
      "[audit] Failed to emit OTel span:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Build a minimal TraceSpan-compatible object for a single tool-call span. */
function buildMinimalSpan(spanId: string, traceId: string, input: AuditCallInput) {
  const startMs = input.startedAt.getTime();
  return {
    spanId,
    parentSpanId: input.parentSpanId,
    name: `mcp.tool_call/${input.toolName}`,
    startTime: startMs,
    endTime: startMs + input.durationMs,
    attributes: {
      "connection.id": input.connectionId,
      ...(input.connectionType ? { "connection.type": input.connectionType } : {}),
      "tool.name": input.toolName,
      duration_ms: input.durationMs,
      ...(input.stageId ? { "stage.id": input.stageId } : {}),
      ...(input.error ? { error: sanitizeErrorMessage(input.error) } : {}),
    },
    events: [],
    status: input.error ? ("error" as const) : ("ok" as const),
  };
}
