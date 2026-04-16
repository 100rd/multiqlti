/**
 * Connection-scope enforcement for pipeline stages (issue #269).
 *
 * Each stage declares an explicit allow-list of workspace connection IDs
 * (`allowedConnections`). The default is an empty list, which means
 * deny-all. Any attempt to invoke a tool tied to a connection not on the
 * allow-list is blocked and an audit event is emitted via the WS manager.
 */

import type { ToolDefinition, ConnectionBlockedError } from "@shared/types";
import type { WsManager } from "../ws/manager";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Tag prefix attached to tool definitions that are scoped to a connection. */
export const CONNECTION_TAG_PREFIX = "connection:";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the connection ID encoded in a tool's tags, if any.
 * Tools tied to a connection are tagged `connection:<id>`.
 */
export function getConnectionIdFromTool(tool: ToolDefinition): string | undefined {
  for (const tag of tool.tags ?? []) {
    if (tag.startsWith(CONNECTION_TAG_PREFIX)) {
      return tag.slice(CONNECTION_TAG_PREFIX.length);
    }
  }
  return undefined;
}

/**
 * Filter a list of tools to only those permitted by the stage's allow-list.
 *
 * Rules:
 * - Tools with no connection tag are always allowed (builtin tools).
 * - Tools with a connection tag are allowed only if their connection ID
 *   appears in `allowedConnections`.
 * - When `allowedConnections` is undefined or empty, all connection-scoped
 *   tools are denied (default-deny).
 */
export function filterToolsByAllowedConnections(
  tools: ToolDefinition[],
  allowedConnections: string[] | undefined,
): ToolDefinition[] {
  const allowed = new Set(allowedConnections ?? []);
  return tools.filter((tool) => {
    const connectionId = getConnectionIdFromTool(tool);
    if (connectionId === undefined) return true;   // builtin — always allowed
    return allowed.has(connectionId);
  });
}

/**
 * Check whether a named tool call is permitted for this stage.
 *
 * Returns `null` if the tool is allowed, or a structured `ConnectionBlockedError`
 * if it should be blocked.
 */
export function checkToolAllowed(
  toolName: string,
  allTools: ToolDefinition[],
  allowedConnections: string[] | undefined,
  stageId: string,
  runId: string,
): ConnectionBlockedError | null {
  const tool = allTools.find((t) => t.name === toolName);
  if (!tool) return null; // unknown tool — let the registry handle "not found"

  const connectionId = getConnectionIdFromTool(tool);
  if (connectionId === undefined) return null; // builtin — always allowed

  const allowed = new Set(allowedConnections ?? []);
  if (allowed.has(connectionId)) return null;

  return {
    code: "CONNECTION_BLOCKED",
    connectionId,
    stageId,
    runId,
    message:
      `Tool "${toolName}" (connection: ${connectionId}) is not in the stage's ` +
      `allowedConnections list. Add connection "${connectionId}" to the stage config to enable it.`,
  };
}

// ─── Audit emission ───────────────────────────────────────────────────────────

/**
 * Emit a WS audit event when a stage tries to invoke a disallowed connection.
 * The payload is structured so the UI can surface it in the trace timeline.
 */
export function emitConnectionBlockedEvent(
  wsManager: WsManager,
  runId: string,
  stageExecutionId: string | undefined,
  error: ConnectionBlockedError,
): void {
  wsManager.broadcastToRun(runId, {
    type: "stage:connection:blocked",
    runId,
    stageExecutionId,
    payload: {
      code: error.code,
      connectionId: error.connectionId,
      stageId: error.stageId,
      message: error.message,
    },
    timestamp: new Date().toISOString(),
  });
}
