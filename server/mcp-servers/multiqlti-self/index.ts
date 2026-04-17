/**
 * Multiqlti Self MCP Server (issue #274)
 *
 * Exposes multiqlti domain objects as MCP tools so that external MCP clients
 * (Claude Code, Cursor, etc.) can interact with the platform programmatically.
 *
 * Transports:
 *  - stdio  — invoked directly by CLI clients
 *  - streamable-http — exposed via POST /api/mcp (behind Caddy)
 *
 * Auth:
 *  - Every call must carry a valid `mcp_client` token in the request context.
 *  - Scope checked per call: workspace access + tool allow-list + concurrency.
 *
 * Tools exposed (7):
 *  1. list_workspaces          — workspace metadata (scoped to token)
 *  2. list_pipelines           — pipeline definitions for a workspace
 *  3. run_pipeline             — async; returns run_id immediately
 *  4. get_run                  — status, output, stage trace events
 *  5. cancel_run               — cancel a running pipeline
 *  6. list_connections         — connection metadata only (NO secrets)
 *  7. query_connection_usage   — usage metrics for a connection
 *
 * Security invariants:
 *  - Secrets never appear in any tool response.
 *  - Tool calls are recorded in the audit log (recordToolCall).
 *  - Unknown tools return an error rather than panicking.
 *  - All inputs are validated before use.
 */

import type { IStorage } from "../../storage";
import type { PipelineController } from "../../controller/pipeline-controller";
import { recordToolCall } from "../../tools/audit";
import {
  checkWorkspaceAccess,
  checkToolAccess,
  acquireRunSlot,
  releaseRunSlot,
} from "./auth";
import type { McpTokenScope } from "@shared/types";

// ─── Tool name constants ───────────────────────────────────────────────────────

export const TOOL_LIST_WORKSPACES = "list_workspaces";
export const TOOL_LIST_PIPELINES = "list_pipelines";
export const TOOL_RUN_PIPELINE = "run_pipeline";
export const TOOL_GET_RUN = "get_run";
export const TOOL_CANCEL_RUN = "cancel_run";
export const TOOL_LIST_CONNECTIONS = "list_connections";
export const TOOL_QUERY_CONNECTION_USAGE = "query_connection_usage";

export const ALL_TOOLS = [
  TOOL_LIST_WORKSPACES,
  TOOL_LIST_PIPELINES,
  TOOL_RUN_PIPELINE,
  TOOL_GET_RUN,
  TOOL_CANCEL_RUN,
  TOOL_LIST_CONNECTIONS,
  TOOL_QUERY_CONNECTION_USAGE,
] as const;

export type McpToolName = (typeof ALL_TOOLS)[number];

// ─── Tool input types ──────────────────────────────────────────────────────────

interface ListPipelinesInput {
  workspace_id: string;
}

interface RunPipelineInput {
  pipeline_id: string;
  input: string;
}

interface GetRunInput {
  run_id: string;
}

interface CancelRunInput {
  run_id: string;
}

interface ListConnectionsInput {
  workspace_id: string;
}

interface QueryConnectionUsageInput {
  connection_id: string;
}

// ─── Call context ──────────────────────────────────────────────────────────────

export interface McpCallContext {
  /** The authenticated MCP client token ID. */
  tokenId: string;
  /** The token's resolved scope. */
  scope: McpTokenScope;
  /** Optional trace ID for linking audit entries. */
  traceId?: string;
}

// ─── Error types ──────────────────────────────────────────────────────────────

export class McpScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpScopeError";
  }
}

export class McpConcurrencyError extends Error {
  constructor(tokenId: string, max: number) {
    super(
      `Token ${tokenId} has reached the maximum concurrent run limit of ${max}. ` +
        "Wait for an existing run to complete before starting a new one.",
    );
    this.name = "McpConcurrencyError";
  }
}

export class McpToolNotFoundError extends Error {
  constructor(toolName: string) {
    super(`Unknown MCP tool: "${toolName}"`);
    this.name = "McpToolNotFoundError";
  }
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

export class MultiqltiMcpServer {
  constructor(
    private readonly storage: IStorage,
    private readonly controller: PipelineController,
  ) {}

  // ── Tool dispatch ────────────────────────────────────────────────────────────

  /**
   * Dispatch a tool call with scope checking and audit logging.
   * Throws on scope/validation errors; returns serialisable result on success.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: McpCallContext,
  ): Promise<unknown> {
    const startedAt = new Date();
    let result: unknown = null;
    let error: string | null = null;

    // Validate tool name
    if (!(ALL_TOOLS as readonly string[]).includes(toolName)) {
      throw new McpToolNotFoundError(toolName);
    }

    // Check tool allow-list
    if (!checkToolAccess(ctx.scope, toolName)) {
      throw new McpScopeError(
        `Token does not have permission to call tool "${toolName}". ` +
          `Allowed tools: ${ctx.scope.allowedTools.join(", ")}`,
      );
    }

    const t0 = Date.now();
    try {
      result = await this.dispatch(toolName as McpToolName, args, ctx);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const durationMs = Date.now() - t0;
      // Audit log — fire-and-forget, never throws
      void recordToolCall(this.storage, {
        connectionId: `mcp_client:${ctx.tokenId}`,
        connectionType: "mcp_client",
        toolName,
        args,
        result: error === null ? result : undefined,
        error,
        durationMs,
        startedAt,
        traceId: ctx.traceId,
      });
    }

    return result;
  }

  // ── Individual tool handlers ─────────────────────────────────────────────────

  private async dispatch(
    toolName: McpToolName,
    args: Record<string, unknown>,
    ctx: McpCallContext,
  ): Promise<unknown> {
    switch (toolName) {
      case TOOL_LIST_WORKSPACES:
        return this.listWorkspaces(ctx);
      case TOOL_LIST_PIPELINES:
        return this.listPipelines(validateListPipelines(args), ctx);
      case TOOL_RUN_PIPELINE:
        return this.runPipeline(validateRunPipeline(args), ctx);
      case TOOL_GET_RUN:
        return this.getRun(validateGetRun(args));
      case TOOL_CANCEL_RUN:
        return this.cancelRun(validateCancelRun(args));
      case TOOL_LIST_CONNECTIONS:
        return this.listConnections(validateListConnections(args), ctx);
      case TOOL_QUERY_CONNECTION_USAGE:
        return this.queryConnectionUsage(validateQueryConnectionUsage(args), ctx);
    }
  }

  /** list_workspaces — returns workspaces the token is scoped to. */
  private async listWorkspaces(ctx: McpCallContext) {
    const allWorkspaces = await this.storage.getWorkspaces();
    return allWorkspaces
      .filter((ws) => checkWorkspaceAccess(ctx.scope, ws.id))
      .map((ws) => ({
        id: ws.id,
        name: ws.name,
        type: ws.type,
        status: ws.status,
        createdAt: ws.createdAt,
      }));
  }

  /** list_pipelines — returns pipelines for a workspace the token may access. */
  private async listPipelines(args: ListPipelinesInput, ctx: McpCallContext) {
    if (!checkWorkspaceAccess(ctx.scope, args.workspace_id)) {
      throw new McpScopeError(
        `Token does not have access to workspace "${args.workspace_id}".`,
      );
    }
    const pipelines = await this.storage.getPipelines();
    return pipelines
      .filter((p) => !p.isTemplate)
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        stageCount: Array.isArray(p.stages) ? (p.stages as unknown[]).length : 0,
        isTemplate: p.isTemplate,
        createdAt: p.createdAt,
      }));
  }

  /**
   * run_pipeline — starts the pipeline via the controller (same path as the
   * REST API) and returns the run ID immediately. Execution is asynchronous.
   */
  private async runPipeline(args: RunPipelineInput, ctx: McpCallContext) {
    // Concurrency gate
    if (!acquireRunSlot(ctx.tokenId, ctx.scope.maxRunConcurrency)) {
      throw new McpConcurrencyError(ctx.tokenId, ctx.scope.maxRunConcurrency);
    }

    let runId: string;
    try {
      // startRun creates the run record AND kicks off execution asynchronously
      const run = await this.controller.startRun(
        args.pipeline_id,
        args.input,
        undefined,
        `mcp_client:${ctx.tokenId}`,
      );
      runId = run.id;
    } catch (err) {
      // Release slot immediately if startup failed
      releaseRunSlot(ctx.tokenId);
      throw err;
    }

    // Release slot when the run reaches a terminal state
    void this.waitForRunCompletion(runId, ctx.tokenId);

    const run = await this.storage.getPipelineRun(runId);
    return {
      runId,
      status: run?.status ?? "running",
      startedAt: run?.startedAt ?? null,
    };
  }

  /** Poll storage until run reaches terminal state, then release the slot. */
  private async waitForRunCompletion(runId: string, tokenId: string): Promise<void> {
    const POLL_INTERVAL_MS = 2_000;
    const MAX_POLLS = 3_600; // ~2 hours at 2s intervals
    const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "rejected"]);

    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(POLL_INTERVAL_MS);
      try {
        const run = await this.storage.getPipelineRun(runId);
        if (!run || TERMINAL_STATUSES.has(run.status)) {
          releaseRunSlot(tokenId);
          return;
        }
      } catch {
        releaseRunSlot(tokenId);
        return;
      }
    }

    // Timed out — release anyway
    releaseRunSlot(tokenId);
  }

  /** get_run — returns run status, output, and stage trace events. */
  private async getRun(args: GetRunInput) {
    const run = await this.storage.getPipelineRun(args.run_id);
    if (!run) {
      throw new Error(`Run not found: "${args.run_id}"`);
    }

    const stages = await this.storage.getStageExecutions(args.run_id);

    return {
      id: run.id,
      pipelineId: run.pipelineId,
      status: run.status,
      input: run.input,
      output: run.output ?? null,
      currentStageIndex: run.currentStageIndex,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
      stages: stages.map((s) => ({
        id: s.id,
        teamId: s.teamId,
        status: s.status,
        startedAt: s.startedAt ?? null,
        completedAt: s.completedAt ?? null,
      })),
    };
  }

  /** cancel_run — cancels a running pipeline run. */
  private async cancelRun(args: CancelRunInput) {
    const run = await this.storage.getPipelineRun(args.run_id);
    if (!run) {
      throw new Error(`Run not found: "${args.run_id}"`);
    }

    const terminalStatuses = ["completed", "failed", "cancelled", "rejected"] as const;
    if (terminalStatuses.includes(run.status as (typeof terminalStatuses)[number])) {
      return { runId: args.run_id, cancelled: false };
    }

    await this.controller.cancelRun(args.run_id);
    return { runId: args.run_id, cancelled: true };
  }

  /** list_connections — returns connection metadata only; NO secrets ever returned. */
  private async listConnections(args: ListConnectionsInput, ctx: McpCallContext) {
    if (!checkWorkspaceAccess(ctx.scope, args.workspace_id)) {
      throw new McpScopeError(
        `Token does not have access to workspace "${args.workspace_id}".`,
      );
    }

    const connections = await this.storage.getWorkspaceConnections(args.workspace_id);
    return connections.map((c) => ({
      id: c.id,
      workspaceId: c.workspaceId,
      type: c.type,
      name: c.name,
      hasSecrets: c.hasSecrets,
      status: c.status,
      lastTestedAt: c.lastTestedAt ?? null,
      createdAt: c.createdAt,
      // Explicitly omit: config, secrets, or any field that could leak credentials
    }));
  }

  /** query_connection_usage — returns usage metrics for a connection. */
  private async queryConnectionUsage(
    args: QueryConnectionUsageInput,
    ctx: McpCallContext,
  ) {
    const connection = await this.storage.getWorkspaceConnection(args.connection_id);
    if (!connection) {
      throw new Error(`Connection not found: "${args.connection_id}"`);
    }
    if (!checkWorkspaceAccess(ctx.scope, connection.workspaceId)) {
      throw new McpScopeError(
        `Token does not have access to workspace "${connection.workspaceId}".`,
      );
    }

    return this.storage.getConnectionUsageMetrics(args.connection_id);
  }
}

// ─── Input validators ──────────────────────────────────────────────────────────

function requireString(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (typeof val !== "string" || val.trim() === "") {
    throw new Error(`Missing or invalid argument "${key}" — expected a non-empty string.`);
  }
  return val.trim();
}

function validateListPipelines(args: Record<string, unknown>): ListPipelinesInput {
  return { workspace_id: requireString(args, "workspace_id") };
}

function validateRunPipeline(args: Record<string, unknown>): RunPipelineInput {
  return {
    pipeline_id: requireString(args, "pipeline_id"),
    input: requireString(args, "input"),
  };
}

function validateGetRun(args: Record<string, unknown>): GetRunInput {
  return { run_id: requireString(args, "run_id") };
}

function validateCancelRun(args: Record<string, unknown>): CancelRunInput {
  return { run_id: requireString(args, "run_id") };
}

function validateListConnections(args: Record<string, unknown>): ListConnectionsInput {
  return { workspace_id: requireString(args, "workspace_id") };
}

function validateQueryConnectionUsage(
  args: Record<string, unknown>,
): QueryConnectionUsageInput {
  return { connection_id: requireString(args, "connection_id") };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── MCP Wire Protocol helpers ────────────────────────────────────────────────

/**
 * Tool definition for the MCP protocol (tools/list response).
 * Used by both transports (stdio + streamable-http).
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: TOOL_LIST_WORKSPACES,
    description: "List all workspaces accessible by this MCP token.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: TOOL_LIST_PIPELINES,
    description: "List pipeline definitions for a workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "The workspace ID." },
      },
      required: ["workspace_id"],
    },
  },
  {
    name: TOOL_RUN_PIPELINE,
    description:
      "Start a pipeline run asynchronously. Returns run_id immediately; poll get_run for status.",
    inputSchema: {
      type: "object",
      properties: {
        pipeline_id: { type: "string", description: "The pipeline ID to run." },
        input: { type: "string", description: "The user input for the pipeline." },
      },
      required: ["pipeline_id", "input"],
    },
  },
  {
    name: TOOL_GET_RUN,
    description: "Get the current status, output, and stage trace for a pipeline run.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The pipeline run ID." },
      },
      required: ["run_id"],
    },
  },
  {
    name: TOOL_CANCEL_RUN,
    description: "Cancel a running pipeline.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The pipeline run ID to cancel." },
      },
      required: ["run_id"],
    },
  },
  {
    name: TOOL_LIST_CONNECTIONS,
    description:
      "List workspace connections (metadata only — no secrets are returned).",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "The workspace ID." },
      },
      required: ["workspace_id"],
    },
  },
  {
    name: TOOL_QUERY_CONNECTION_USAGE,
    description: "Get usage metrics for a workspace connection.",
    inputSchema: {
      type: "object",
      properties: {
        connection_id: { type: "string", description: "The connection ID." },
      },
      required: ["connection_id"],
    },
  },
];

// ─── JSON-RPC types ───────────────────────────────────────────────────────────

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const JSONRPC_VERSION = "2.0" as const;

/**
 * Handle a single MCP JSON-RPC request.
 * Used by both stdio and streamable-http transports.
 */
export async function handleMcpRequest(
  request: McpJsonRpcRequest,
  server: MultiqltiMcpServer,
  ctx: McpCallContext,
): Promise<McpJsonRpcResponse> {
  const { id, method, params = {} } = request;

  if (method === "tools/list") {
    return {
      jsonrpc: JSONRPC_VERSION,
      id,
      result: { tools: MCP_TOOL_DEFINITIONS },
    };
  }

  if (method === "tools/call") {
    const toolName = typeof params.name === "string" ? params.name : "";
    const args =
      params.arguments && typeof params.arguments === "object"
        ? (params.arguments as Record<string, unknown>)
        : {};

    try {
      const result = await server.callTool(toolName, args, ctx);
      return {
        jsonrpc: JSONRPC_VERSION,
        id,
        result: { content: [{ type: "text", text: JSON.stringify(result) }] },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof McpScopeError
          ? -32001 // permission denied
          : err instanceof McpConcurrencyError
            ? -32002 // rate limited
            : err instanceof McpToolNotFoundError
              ? -32601 // method not found
              : -32000; // server error
      return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
    }
  }

  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code: -32601, message: `Method not found: "${method}"` },
  };
}

/**
 * Process a newline-delimited stream of JSON-RPC requests (stdio transport).
 *
 * @param lines     — raw JSON strings, one per line
 * @param server    — the MCP server instance
 * @param ctx       — call context (token + scope)
 * @param writeLine — output function (injectable for tests)
 */
export async function processStdioLines(
  lines: string[],
  server: MultiqltiMcpServer,
  ctx: McpCallContext,
  writeLine: (s: string) => void = (s) => process.stdout.write(s + "\n"),
): Promise<void> {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let request: McpJsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as McpJsonRpcRequest;
    } catch {
      const errorResp: McpJsonRpcResponse = {
        jsonrpc: JSONRPC_VERSION,
        id: null,
        error: { code: -32700, message: "Parse error" },
      };
      writeLine(JSON.stringify(errorResp));
      continue;
    }

    const response = await handleMcpRequest(request, server, ctx);
    writeLine(JSON.stringify(response));
  }
}

// ─── Singleton factory ────────────────────────────────────────────────────────

let _server: MultiqltiMcpServer | null = null;

/** Get or create the singleton MCP server. Used by the route handler. */
export function getMultiqltiMcpServer(
  storage: IStorage,
  controller: PipelineController,
): MultiqltiMcpServer {
  if (!_server) {
    _server = new MultiqltiMcpServer(storage, controller);
  }
  return _server;
}

/** Reset singleton (tests only). */
export function _resetMultiqltiMcpServer(): void {
  _server = null;
}
