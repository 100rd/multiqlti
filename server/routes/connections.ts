/**
 * Workspace Connections REST API (issue #267)
 *
 * 6 endpoints for managing external connections (GitLab, GitHub, Kubernetes,
 * AWS, Jira, Grafana, generic MCP) scoped to a workspace.
 *
 * RBAC (mapped to global system roles):
 *   - admin     → full CRUD + test
 *   - maintainer → read metadata only (no secrets)
 *   - user      → no access (403)
 *
 * Security invariants (enforced throughout):
 *   - Secrets are NEVER included in any API response.
 *   - The test endpoint does not persist connection artifacts.
 *   - All mutating actions emit an audit log entry (stub hook for future).
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { validateConnectionConfig, CONNECTION_TYPES } from "@shared/schema";
import type { IStorage } from "../storage";
import { requireRole } from "../auth/middleware";
import { log } from "../index";

// ─── Zod request schemas ──────────────────────────────────────────────────────

const WorkspaceConnectionParamsSchema = z.object({
  id: z.string().min(1),
});

const ConnectionParamsSchema = z.object({
  id: z.string().min(1),
  cid: z.string().min(1),
});

const CreateConnectionBodySchema = z.object({
  type: z.enum(CONNECTION_TYPES),
  name: z.string().min(1).max(200),
  config: z.record(z.unknown()).default({}),
  secrets: z.record(z.string()).optional(),
});

const UpdateConnectionBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  config: z.record(z.unknown()).optional(),
  /** Explicitly set to null to remove secrets; omit to leave unchanged. */
  secrets: z.record(z.string()).nullable().optional(),
  status: z.enum(["active", "inactive", "error"]).optional(),
});

// ─── Audit stub ───────────────────────────────────────────────────────────────

type AuditAction =
  | "connection.created"
  | "connection.updated"
  | "connection.deleted"
  | "connection.tested";

function auditLog(
  action: AuditAction,
  userId: string | undefined,
  connectionId: string,
  workspaceId: string,
): void {
  // TODO: persist to audit_log table (future issue)
  log(
    `[audit] ${action} connectionId=${connectionId} workspaceId=${workspaceId} userId=${userId ?? "unknown"}`,
    "connections",
  );
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerConnectionRoutes(app: Express, storage: IStorage): void {
  // All routes under /api/workspaces/:id/connections require auth already
  // (applied globally via `app.use("/api/workspaces", requireAuth)` in routes.ts).

  // ── GET /api/workspaces/:id/connections ─────────────────────────────────────
  // List all connections for a workspace. Secrets never included.
  // Accessible by admin and maintainer (workspace admin + member).

  app.get(
    "/api/workspaces/:id/connections",
    requireRole("maintainer", "admin"),
    async (req: Request, res: Response) => {
      const params = WorkspaceConnectionParamsSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: params.error.message });
      }

      try {
        const connections = await storage.getWorkspaceConnections(params.data.id);
        return res.json(connections);
      } catch (err) {
        return res.status(500).json({ error: "Failed to list connections" });
      }
    },
  );

  // ── POST /api/workspaces/:id/connections ────────────────────────────────────
  // Create a new connection. Validates config against the type-specific Zod schema.
  // Admin only.

  app.post(
    "/api/workspaces/:id/connections",
    requireRole("admin"),
    async (req: Request, res: Response) => {
      const params = WorkspaceConnectionParamsSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: params.error.message });
      }

      const body = CreateConnectionBodySchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({
          error: "Validation failed",
          issues: body.error.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }

      // Validate type-specific config
      let validatedConfig: Record<string, unknown>;
      try {
        validatedConfig = validateConnectionConfig(body.data.type, body.data.config);
      } catch (err) {
        return res.status(400).json({
          error: "Invalid connection config",
          details: (err as Error).message,
        });
      }

      try {
        const connection = await storage.createWorkspaceConnection({
          workspaceId: params.data.id,
          type: body.data.type,
          name: body.data.name,
          config: validatedConfig,
          secrets: body.data.secrets,
          createdBy: req.user?.id ?? null,
        });

        auditLog("connection.created", req.user?.id, connection.id, params.data.id);
        return res.status(201).json(connection);
      } catch (err) {
        return res.status(500).json({ error: "Failed to create connection" });
      }
    },
  );

  // ── GET /api/workspaces/:id/connections/:cid ────────────────────────────────
  // Read a single connection. Secrets never included.
  // Accessible by admin and maintainer.

  app.get(
    "/api/workspaces/:id/connections/:cid",
    requireRole("maintainer", "admin"),
    async (req: Request, res: Response) => {
      const params = ConnectionParamsSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: params.error.message });
      }

      try {
        const connection = await storage.getWorkspaceConnection(params.data.cid);
        if (!connection) {
          return res.status(404).json({ error: "Connection not found" });
        }
        if (connection.workspaceId !== params.data.id) {
          return res.status(404).json({ error: "Connection not found" });
        }
        return res.json(connection);
      } catch (err) {
        return res.status(500).json({ error: "Failed to get connection" });
      }
    },
  );

  // ── PATCH /api/workspaces/:id/connections/:cid ──────────────────────────────
  // Partial update. Secrets are rotated only when the `secrets` field is
  // explicitly provided. Omitting `secrets` leaves existing secrets unchanged.
  // Admin only.

  app.patch(
    "/api/workspaces/:id/connections/:cid",
    requireRole("admin"),
    async (req: Request, res: Response) => {
      const params = ConnectionParamsSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: params.error.message });
      }

      const body = UpdateConnectionBodySchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({
          error: "Validation failed",
          issues: body.error.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }

      try {
        const existing = await storage.getWorkspaceConnection(params.data.cid);
        if (!existing) {
          return res.status(404).json({ error: "Connection not found" });
        }
        if (existing.workspaceId !== params.data.id) {
          return res.status(404).json({ error: "Connection not found" });
        }

        // If a new config is provided, validate it against the type-specific schema
        let validatedConfig: Record<string, unknown> | undefined;
        if (body.data.config !== undefined) {
          try {
            validatedConfig = validateConnectionConfig(existing.type, body.data.config);
          } catch (err) {
            return res.status(400).json({
              error: "Invalid connection config",
              details: (err as Error).message,
            });
          }
        }

        const updated = await storage.updateWorkspaceConnection(params.data.cid, {
          ...(body.data.name !== undefined && { name: body.data.name }),
          ...(validatedConfig !== undefined && { config: validatedConfig }),
          ...(body.data.secrets !== undefined && { secrets: body.data.secrets }),
          ...(body.data.status !== undefined && { status: body.data.status }),
        });

        auditLog("connection.updated", req.user?.id, params.data.cid, params.data.id);
        return res.json(updated);
      } catch (err) {
        return res.status(500).json({ error: "Failed to update connection" });
      }
    },
  );

  // ── DELETE /api/workspaces/:id/connections/:cid ─────────────────────────────
  // Remove a connection. Admin only.

  app.delete(
    "/api/workspaces/:id/connections/:cid",
    requireRole("admin"),
    async (req: Request, res: Response) => {
      const params = ConnectionParamsSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: params.error.message });
      }

      try {
        const existing = await storage.getWorkspaceConnection(params.data.cid);
        if (!existing) {
          return res.status(404).json({ error: "Connection not found" });
        }
        if (existing.workspaceId !== params.data.id) {
          return res.status(404).json({ error: "Connection not found" });
        }

        await storage.deleteWorkspaceConnection(params.data.cid);
        auditLog("connection.deleted", req.user?.id, params.data.cid, params.data.id);
        return res.status(204).send();
      } catch (err) {
        return res.status(500).json({ error: "Failed to delete connection" });
      }
    },
  );

  // ── POST /api/workspaces/:id/connections/:cid/test ──────────────────────────
  // Dry-run connectivity check. Does NOT persist any side-effect artifacts.
  // Returns { ok, latencyMs, details }.
  // Admin only.

  app.post(
    "/api/workspaces/:id/connections/:cid/test",
    requireRole("admin"),
    async (req: Request, res: Response) => {
      const params = ConnectionParamsSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: params.error.message });
      }

      try {
        const existing = await storage.getWorkspaceConnection(params.data.cid);
        if (!existing) {
          return res.status(404).json({ error: "Connection not found" });
        }
        if (existing.workspaceId !== params.data.id) {
          return res.status(404).json({ error: "Connection not found" });
        }

        const startMs = Date.now();

        // Perform a lightweight reachability probe (no side effects).
        const testResult = await performConnectivityCheck(existing.type, existing.config);

        const latencyMs = Date.now() - startMs;

        // Record lastTestedAt — this is the only permitted side-effect (metadata only).
        await storage.updateWorkspaceConnection(params.data.cid, {
          lastTestedAt: new Date(),
          ...(testResult.ok ? {} : { status: "error" }),
        });

        auditLog("connection.tested", req.user?.id, params.data.cid, params.data.id);

        return res.json({
          ok: testResult.ok,
          latencyMs,
          details: testResult.details,
        });
      } catch (err) {
        return res.status(500).json({ error: "Failed to test connection" });
      }
    },
  );

  // ── GET /api/workspaces/:id/connections/:cid/usage ─────────────────────────
  // Usage metrics for a connection: calls/day (30d), top tools, error rate (7d),
  // P95 latency, and orphan detection.
  // Accessible by admin and maintainer.

  app.get(
    "/api/workspaces/:id/connections/:cid/usage",
    requireRole("maintainer", "admin"),
    async (req: Request, res: Response) => {
      const params = ConnectionParamsSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: params.error.message });
      }

      try {
        const connection = await storage.getWorkspaceConnection(params.data.cid);
        if (!connection) {
          return res.status(404).json({ error: "Connection not found" });
        }
        if (connection.workspaceId !== params.data.id) {
          return res.status(404).json({ error: "Connection not found" });
        }

        const metrics = await storage.getConnectionUsageMetrics(params.data.cid);
        return res.json(metrics);
      } catch (err) {
        log(`[connections] Failed to get usage metrics: ${err instanceof Error ? err.message : err}`, "connections");
        return res.status(500).json({ error: "Failed to get usage metrics" });
      }
    },
  );
}

// ─── Connectivity check ───────────────────────────────────────────────────────

interface ConnectivityResult {
  ok: boolean;
  details: string;
}

/**
 * Performs a lightweight probe to verify the external service is reachable.
 *
 * This is a best-effort check — it does not authenticate, does not write data,
 * and does not persist any artifacts. Only the config (non-secret) fields are
 * used to derive the probe URL.
 *
 * On error the method resolves (never rejects) with ok=false, so the route
 * can always return a structured response.
 */
async function performConnectivityCheck(
  type: string,
  config: Record<string, unknown>,
): Promise<ConnectivityResult> {
  const probeUrl = resolveProbeUrl(type, config);

  if (!probeUrl) {
    return { ok: false, details: `No probe URL available for type "${type}"` };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(probeUrl, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "multiqlti-connection-test/1.0" },
    });

    clearTimeout(timeoutId);

    // Any HTTP response (even 401/403) proves the host is reachable.
    return {
      ok: response.status < 500,
      details: `HTTP ${response.status} from ${probeUrl}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, details: `Probe failed: ${message}` };
  }
}

/**
 * Derive a suitable probe URL from the non-secret connection config.
 * Returns null when no suitable endpoint can be determined.
 */
function resolveProbeUrl(type: string, config: Record<string, unknown>): string | null {
  switch (type) {
    case "gitlab": {
      const host = typeof config.host === "string" ? config.host : "https://gitlab.com";
      return `${host}/api/v4/version`;
    }
    case "github": {
      const host = typeof config.host === "string" ? config.host : "https://api.github.com";
      return `${host}/`;
    }
    case "kubernetes": {
      const server = typeof config.server === "string" ? config.server : null;
      return server ? `${server}/livez` : null;
    }
    case "jira": {
      const host = typeof config.host === "string" ? config.host : null;
      return host ? `${host}/status` : null;
    }
    case "grafana": {
      const host = typeof config.host === "string" ? config.host : null;
      return host ? `${host}/api/health` : null;
    }
    case "aws": {
      // AWS doesn't have a simple public probe endpoint — skip.
      return null;
    }
    case "generic_mcp": {
      const endpoint = typeof config.endpoint === "string" ? config.endpoint : null;
      return endpoint;
    }
    default:
      return null;
  }
}
