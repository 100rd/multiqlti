/**
 * ArgoCD Settings Routes -- Phase 6.10
 *
 * Endpoints:
 *   GET    /api/settings/argocd        -- current config (no token)
 *   PUT    /api/settings/argocd        -- save/update config
 *   DELETE /api/settings/argocd        -- remove config
 *   POST   /api/settings/argocd/test   -- test connectivity
 *
 * All routes require authentication (covered by upstream requireAuth middleware).
 *
 * Bug #128: Refactored to use IStorage instead of direct db access so
 * MemStorage mode (no DATABASE_URL) does not cause 500 errors.
 */
import { Router } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import { encrypt, decrypt } from "../crypto";
import { mcpClientManager } from "../tools/mcp-client";
import { argoCdService } from "../services/argocd-service";
import type { ArgoCdConfigRow } from "@shared/schema";

// --- SSRF protection --------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
]);

function isSsrfUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(hostname)) return true;
    // Block link-local addresses (169.254.x.x)
    if (/^169\.254\./.test(hostname)) return true;
    // Block 10.x.x.x, 172.16-31.x.x, 192.168.x.x
    if (/^10\./.test(hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
    if (/^192\.168\./.test(hostname)) return true;
    return false;
  } catch {
    return true; // Invalid URL -- block it
  }
}

// --- Validation schemas ------------------------------------------------------

const SaveArgoCdConfigSchema = z.object({
  serverUrl: z.string().url({ message: "serverUrl must be a valid URL" }).max(500),
  token: z.string().min(1).max(2000).optional(), // omit = keep existing
  verifySsl: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

// --- Helpers -----------------------------------------------------------------

/** Returns the effective ArgoCD server URL -- env var takes precedence over DB. */
function getEnvServerUrl(): string | undefined {
  return process.env["ARGOCD_SERVER_URL"] ?? undefined;
}

/** Returns the effective ArgoCD token from env -- env var takes precedence over DB. */
function getEnvToken(): string | undefined {
  return process.env["ARGOCD_TOKEN"] ?? undefined;
}

/** Build a safe public config response (no token). */
function buildPublicConfig(
  row: {
    serverUrl: string | null;
    verifySsl: boolean;
    enabled: boolean;
    mcpServerId: number | null;
    lastHealthCheckAt: Date | null;
    healthStatus: string;
    healthError: string | null;
  } | null,
  envOverride: boolean,
): object {
  if (!row && !envOverride) {
    return { configured: false };
  }

  const serverUrl = envOverride ? getEnvServerUrl() : row?.serverUrl;
  const hasToken = envOverride ? !!getEnvToken() : !!row;

  return {
    configured: !!(serverUrl && hasToken),
    serverUrl: serverUrl ?? null,
    verifySsl: row?.verifySsl ?? true,
    enabled: row?.enabled ?? false,
    healthStatus: row?.healthStatus ?? "unknown",
    healthError: row?.healthError ?? null,
    lastHealthCheckAt: row?.lastHealthCheckAt ?? null,
    mcpServerId: row?.mcpServerId ?? null,
    source: envOverride ? "env" : "db",
  };
}

// --- Route registration ------------------------------------------------------

export function registerArgoCdSettingsRoutes(router: Router, storage: IStorage): void {
  /** GET /api/settings/argocd */
  router.get("/api/settings/argocd", async (_req, res) => {
    try {
      const envOverride = !!(getEnvServerUrl() && getEnvToken());
      const row = await storage.getArgoCdConfig();
      return res.json(buildPublicConfig(row, envOverride));
    } catch (e) {
      return res.status(500).json({ error: (e as Error).message });
    }
  });

  /** PUT /api/settings/argocd */
  router.put("/api/settings/argocd", async (req, res) => {
    const parse = SaveArgoCdConfigSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({
        error: "Validation failed",
        issues: parse.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }

    const { serverUrl, token, verifySsl, enabled } = parse.data;

    // SSRF check
    if (isSsrfUrl(serverUrl)) {
      return res.status(400).json({ error: "serverUrl must point to a publicly reachable ArgoCD instance" });
    }

    try {
      // Get existing row to preserve token if not provided
      const existingRow = await storage.getArgoCdConfig();

      let tokenEnc: string | null = existingRow?.tokenEnc ?? null;
      if (token) {
        tokenEnc = encrypt(token);
      }

      if (!tokenEnc) {
        return res.status(400).json({ error: "token is required for the initial ArgoCD configuration" });
      }

      // Upsert mcp_servers row for ArgoCD
      const decryptedToken = decrypt(tokenEnc);
      let mcpServerId: number | null = existingRow?.mcpServerId ?? null;

      if (mcpServerId !== null) {
        // Update existing MCP server row
        await storage.updateMcpServer(mcpServerId, {
          url: serverUrl,
          env: { ARGOCD_TOKEN: decryptedToken },
          enabled,
          autoConnect: enabled,
        } as Partial<import("@shared/types").McpServerConfig>);
      } else {
        // Create new MCP server row
        const inserted = await storage.createMcpServer({
          name: "argocd",
          transport: "sse",
          url: serverUrl,
          env: { ARGOCD_TOKEN: decryptedToken },
          enabled,
          autoConnect: enabled,
          toolCount: 0,
        });
        mcpServerId = inserted.id;
      }

      // Upsert argocd_config row
      await storage.saveArgoCdConfig({
        id: 1,
        serverUrl,
        tokenEnc,
        verifySsl,
        enabled,
        mcpServerId,
        healthStatus: "unknown",
        healthError: null,
      } as Parameters<typeof storage.saveArgoCdConfig>[0]);

      // Attempt to connect/disconnect based on enabled flag
      let healthStatus: string = "unknown";
      let healthError: string | null = null;

      if (enabled && mcpServerId !== null) {
        const mcpRow = await storage.getMcpServer(mcpServerId);
        if (mcpRow) {
          try {
            await mcpClientManager.connect(mcpRow as import("@shared/types").McpServerConfig);
            healthStatus = "connected";
            await storage.updateMcpServer(mcpServerId, {
              toolCount: mcpClientManager.getTools("argocd").length,
              lastConnectedAt: new Date(),
            } as Partial<import("@shared/types").McpServerConfig>);
          } catch (connectErr) {
            healthStatus = "error";
            healthError = (connectErr as Error).message;
          }
        }
      } else {
        await mcpClientManager.disconnect("argocd");
      }

      // Update health status
      await storage.saveArgoCdConfig({
        id: 1,
        healthStatus,
        healthError,
        lastHealthCheckAt: new Date(),
      } as Parameters<typeof storage.saveArgoCdConfig>[0]);

      const updatedRow = await storage.getArgoCdConfig();
      return res.json(buildPublicConfig(updatedRow, false));
    } catch (e) {
      return res.status(500).json({ error: (e as Error).message });
    }
  });

  /** DELETE /api/settings/argocd */
  router.delete("/api/settings/argocd", async (_req, res) => {
    try {
      const row = await storage.getArgoCdConfig();
      if (!row) return res.status(204).end();

      // Disconnect MCP
      await mcpClientManager.disconnect("argocd");

      // Delete MCP server row if we own it
      if (row.mcpServerId !== null) {
        await storage.deleteMcpServer(row.mcpServerId);
      }

      // Delete config row
      await storage.deleteArgoCdConfig();

      return res.status(204).end();
    } catch (e) {
      return res.status(500).json({ error: (e as Error).message });
    }
  });

  /** POST /api/settings/argocd/test */
  router.post("/api/settings/argocd/test", async (_req, res) => {
    try {
      // Check env override first
      const envToken = getEnvToken();
      const envUrl = getEnvServerUrl();

      if (envToken && envUrl && !mcpClientManager.getStatus()["argocd"]?.connected) {
        // Try to auto-connect from env vars
        try {
          await mcpClientManager.connect({
            id: 0,
            name: "argocd",
            transport: "sse",
            url: envUrl,
            env: { ARGOCD_TOKEN: envToken },
            enabled: true,
            autoConnect: false,
            toolCount: 0,
          });
        } catch {
          // ignore -- test result will reflect failure
        }
      }

      const result = await argoCdService.testConnection();
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e as Error).message, applicationCount: 0, applications: [], latencyMs: 0 });
    }
  });
}

/** Load ArgoCD config from env vars (used on startup if env vars are set). */
export async function autoConnectArgoCdFromEnv(): Promise<void> {
  const envToken = getEnvToken();
  const envUrl = getEnvServerUrl();
  const verifySsl = process.env["ARGOCD_VERIFY_SSL"] !== "false";

  if (!envToken || !envUrl) return;

  console.log("[argocd] Auto-connecting from ARGOCD_SERVER_URL + ARGOCD_TOKEN env vars");
  try {
    await mcpClientManager.connect({
      id: 0,
      name: "argocd",
      transport: "sse",
      url: envUrl,
      env: { ARGOCD_TOKEN: envToken },
      enabled: true,
      autoConnect: true,
      toolCount: 0,
    });
    console.log("[argocd] Connected via env vars");
    void verifySsl; // used in future TLS config
  } catch (err) {
    console.warn("[argocd] Auto-connect from env failed:", (err as Error).message);
  }
}
