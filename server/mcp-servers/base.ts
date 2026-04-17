/**
 * Base interface and types for built-in MCP servers (issue #270).
 *
 * Each built-in MCP server:
 *  - Is tied to a specific ConnectionType ("kubernetes", "github", "gitlab", "docker-run" conceptually)
 *  - Exposes a set of ToolHandlers that the BuiltinMcpServerRegistry registers
 *  - Receives connection config + resolved secrets at startup
 *  - Enforces scope: which operations are allowed vs. require an explicit allow-flag
 */

import type { ToolHandler } from "../tools/registry";
import type { ConnectionType } from "@shared/types";

// ─── Server Config ─────────────────────────────────────────────────────────────

/**
 * Runtime configuration supplied to a built-in MCP server when it starts.
 * Secrets are passed as a plain map — they were decrypted from storage and
 * must NEVER be logged or included in tool output.
 */
export interface BuiltinMcpServerConfig {
  /** The workspace connection ID this server represents. */
  connectionId: string;
  /** Non-secret configuration JSON (URLs, usernames, project keys, etc.). */
  config: Record<string, unknown>;
  /**
   * Decrypted secrets. Must never appear in logs or tool responses.
   * The server is responsible for redacting these values from all output.
   */
  secrets: Record<string, string>;
  /**
   * When true the server may execute destructive operations
   * (delete namespace, force-push, etc.). Defaults to false.
   */
  allowDestructive?: boolean;
}

// ─── Tool Scope ────────────────────────────────────────────────────────────────

/** The two permission tiers for built-in tools. */
export type ToolScope = "read" | "destructive";

/**
 * Metadata attached to every tool exposed by a built-in MCP server.
 * The registry uses `scope` to decide whether the operation is gated by
 * `allowDestructive`.
 */
export interface BuiltinToolMeta {
  /** Human-readable category for grouping in the UI. */
  category: string;
  /** "read" = always allowed; "destructive" = requires `allowDestructive` flag. */
  scope: ToolScope;
}

// ─── Server Interface ─────────────────────────────────────────────────────────

/**
 * Interface all built-in MCP servers must implement.
 *
 * The registry calls `start()` once when a matching connection is created /
 * enabled, then calls `stop()` when the connection is deleted / disabled.
 */
export interface IBuiltinMcpServer {
  /**
   * The connection type this server handles.
   * Must match exactly one of the CONNECTION_TYPES values.
   */
  readonly connectionType: ConnectionType;

  /**
   * Initialise the server with the connection config and resolved secrets.
   * Must not throw for invalid config — surface errors as tool execution results.
   */
  start(cfg: BuiltinMcpServerConfig): Promise<void>;

  /** Release all resources held by this server. */
  stop(): Promise<void>;

  /**
   * Return all tool handlers this server exposes.
   * Called after `start()` — handlers may close over the resolved config.
   */
  getToolHandlers(): ToolHandler[];

  /**
   * Return the scope for a named tool.
   * Returns undefined if the tool is unknown (treated as "read").
   */
  getToolScope(toolName: string): ToolScope | undefined;
}

// ─── Secret Redaction ─────────────────────────────────────────────────────────

/**
 * Replace every occurrence of a secret value in `text` with a placeholder.
 * Called on every string returned from tool executors.
 *
 * Rules:
 * - Only non-empty secret values are redacted.
 * - The replacement is `[REDACTED]`.
 * - Comparison is case-sensitive (secrets are case-sensitive credentials).
 */
export function redactSecrets(text: string, secrets: Record<string, string>): string {
  let result = text;
  for (const value of Object.values(secrets)) {
    if (!value) continue;
    // Escape special regex chars to avoid broken patterns
    const escaped = value.replace(/[$()*+./?[\\\]^{|}]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "g"), "[REDACTED]");
  }
  return result;
}

// ─── Destructive Guard ────────────────────────────────────────────────────────

/**
 * Throw a typed error when a destructive operation is attempted without the
 * `allowDestructive` flag. The message is safe to surface to the user.
 */
export class DestructiveOperationDeniedError extends Error {
  constructor(toolName: string) {
    super(
      `Tool "${toolName}" is a destructive operation. ` +
        "Set allowDestructive=true on the workspace connection to enable it.",
    );
    this.name = "DestructiveOperationDeniedError";
  }
}

/**
 * Guard helper used inside every destructive tool executor.
 * Throws `DestructiveOperationDeniedError` when `allowDestructive` is falsy.
 */
export function requireDestructiveFlag(
  toolName: string,
  allowDestructive: boolean | undefined,
): void {
  if (!allowDestructive) {
    throw new DestructiveOperationDeniedError(toolName);
  }
}
