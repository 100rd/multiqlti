/**
 * MCP Server Routes (issue #274)
 *
 * Exposes multiqlti as an MCP server via two transports:
 *
 * 1. POST /mcp — streamable-http transport (for hosted clients / Caddy)
 *    - Accepts a single JSON-RPC 2.0 request body
 *    - Returns a single JSON-RPC 2.0 response
 *    - Auth: Bearer mcp_client token in Authorization header
 *    - NOTE: uses /mcp (no /api prefix) to bypass session requireAuth middleware
 *
 * 2. GET  /mcp/tools — list available tools (no auth required)
 *    - Used by MCP clients during capability discovery
 *
 * Token management endpoints (require user session auth):
 *   POST   /api/workspaces/:id/mcp-tokens       — create token
 *   GET    /api/workspaces/:id/mcp-tokens        — list tokens
 *   DELETE /api/workspaces/:id/mcp-tokens/:tid   — revoke token
 *
 * Security:
 *  - /mcp transport endpoints use mcp_client token auth (not user sessions)
 *  - Tool calls are scope-checked (workspace access + tool allow-list + concurrency)
 *  - All tool calls are audit-logged
 *  - No secrets returned in any response
 */

import { Router } from "express";
import { z } from "zod";
import type { Request, Response } from "express";
import type { IStorage } from "../storage";
import type { PipelineController } from "../controller/pipeline-controller";
import { requireAuth, requireRole } from "../auth/middleware";
import { mcpTokenStore } from "../mcp-servers/multiqlti-self/auth";
import {
  getMultiqltiMcpServer,
  handleMcpRequest,
  MCP_TOOL_DEFINITIONS,
} from "../mcp-servers/multiqlti-self/index";
import type { McpCallContext, McpJsonRpcRequest } from "../mcp-servers/multiqlti-self/index";
import type { McpTokenScope, CreateMcpClientTokenInput } from "@shared/types";

// ─── Validation schemas ───────────────────────────────────────────────────────

const WorkspaceParamsSchema = z.object({ id: z.string().min(1) });
const TokenParamsSchema = z.object({ id: z.string().min(1), tid: z.string().min(1) });

const McpTokenScopeSchema = z.object({
  workspaceIds: z.array(z.string().min(1)).min(1),
  allowedTools: z
    .array(z.string().min(1))
    .min(1)
    .refine(
      (arr) => arr[0] === "*" || arr.every((t) => typeof t === "string"),
      "allowedTools must be ['*'] or a list of tool names",
    ) as z.ZodType<McpTokenScope["allowedTools"]>,
  maxRunConcurrency: z.number().int().min(1).max(20).default(5),
});

const CreateMcpTokenBodySchema = z.object({
  name: z.string().min(1).max(200),
  scope: McpTokenScopeSchema,
  expiresAt: z.string().datetime().optional(),
});

const McpJsonRpcBodySchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

// ─── Token auth helper ─────────────────────────────────────────────────────────

/**
 * Extract and validate the Bearer mcp_client token from the Authorization header.
 * Returns the resolved call context or null if invalid.
 */
function resolveMcpToken(req: Request): McpCallContext | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const rawToken = authHeader.slice(7);
  const validated = mcpTokenStore.validate(rawToken);
  if (!validated) return null;
  return {
    tokenId: validated.id,
    scope: validated.scope,
  };
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerMcpRoutes(
  router: Router,
  storage: IStorage,
  controller: PipelineController,
): void {
  const mcpServer = getMultiqltiMcpServer(storage, controller);

  // ── GET /mcp/tools — capability discovery (no auth) ─────────────────────────
  // Must be registered on a router that bypasses session auth middleware.
  router.get("/mcp/tools", (_req: Request, res: Response) => {
    res.json({ tools: MCP_TOOL_DEFINITIONS });
  });

  // ── POST /mcp — streamable-http transport ────────────────────────────────────
  // Uses mcp_client token auth (not user sessions).
  router.post("/mcp", async (req: Request, res: Response) => {
    const ctx = resolveMcpToken(req);
    if (!ctx) {
      return res.status(401).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Unauthorized: missing or invalid MCP token" },
      });
    }

    const bodyParse = McpJsonRpcBodySchema.safeParse(req.body);
    if (!bodyParse.success) {
      return res.status(400).json({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: `Invalid JSON-RPC request: ${bodyParse.error.message}`,
        },
      });
    }

    const request = bodyParse.data as McpJsonRpcRequest;
    const response = await handleMcpRequest(request, mcpServer, ctx);
    return res.json(response);
  });

  // ── Token management — require user session auth ──────────────────────────────

  // POST /api/workspaces/:id/mcp-tokens — create token
  router.post(
    "/api/workspaces/:id/mcp-tokens",
    requireAuth,
    requireRole("admin"),
    async (req: Request, res: Response) => {
      const params = WorkspaceParamsSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: "Invalid workspace ID" });
      }
      const workspaceId = params.data.id;

      const bodyParse = CreateMcpTokenBodySchema.safeParse(req.body);
      if (!bodyParse.success) {
        return res.status(400).json({ error: bodyParse.error.message });
      }
      const body = bodyParse.data;

      // Ensure workspaceIds in scope include the requested workspace
      if (!body.scope.workspaceIds.includes(workspaceId)) {
        return res.status(400).json({
          error: "scope.workspaceIds must include the workspace ID for this endpoint",
        });
      }

      const input: CreateMcpClientTokenInput = {
        workspaceId,
        name: body.name,
        scope: body.scope,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      };

      const result = mcpTokenStore.create(input);

      return res.status(201).json({
        token: result.token,
        rawToken: result.rawToken, // Shown once; not persisted
      });
    },
  );

  // GET /api/workspaces/:id/mcp-tokens — list tokens
  router.get(
    "/api/workspaces/:id/mcp-tokens",
    requireAuth,
    requireRole("admin", "maintainer"),
    (req: Request, res: Response) => {
      const params = WorkspaceParamsSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: "Invalid workspace ID" });
      }
      const tokens = mcpTokenStore.listByWorkspace(params.data.id);
      return res.json(tokens);
    },
  );

  // DELETE /api/workspaces/:id/mcp-tokens/:tid — revoke token
  router.delete(
    "/api/workspaces/:id/mcp-tokens/:tid",
    requireAuth,
    requireRole("admin"),
    (req: Request, res: Response) => {
      const params = TokenParamsSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: "Invalid workspace or token ID" });
      }

      const token = mcpTokenStore.getById(params.data.tid);
      if (!token) {
        return res.status(404).json({ error: "Token not found" });
      }
      if (token.workspaceId !== params.data.id) {
        return res.status(403).json({ error: "Token does not belong to this workspace" });
      }

      const ok = mcpTokenStore.revoke(params.data.tid);
      if (!ok) {
        return res.status(404).json({ error: "Token not found" });
      }
      return res.json({ revoked: true, id: params.data.tid });
    },
  );
}
