import type { Express } from "express";
import { pool } from "../db";
import { configLoader } from "../config/loader";
import { authService } from "../auth/service";

/**
 * GET /api/health
 *
 * Public endpoint (no authentication required). Returns the operational status
 * of the application and its dependencies. Used by Docker healthchecks,
 * load balancers, and monitoring systems.
 *
 * Response shape:
 * {
 *   status: "ok" | "degraded" | "unhealthy",
 *   version: string,
 *   uptime: number,          // process uptime in seconds
 *   db: { status: "ok" | "error", latencyMs?: number, error?: string },
 *   providers: {
 *     vllm:   { status: "ok" | "unreachable" | "disabled" },
 *     ollama: { status: "ok" | "unreachable" | "disabled" },
 *   },
 * }
 *
 * HTTP status codes:
 *   200 — ok or degraded (app is running, some deps may be unavailable)
 *   503 — unhealthy (DB is down; app cannot serve requests)
 */
export function registerHealthRoutes(app: Express): void {
  app.get("/api/health", async (req, res) => {
    // Check if caller is authenticated (optional — unauthenticated gets minimal response)
    let isAuthenticated = false;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        await authService.validateToken(authHeader.slice(7));
        isAuthenticated = true;
      } catch {
        // Not authenticated — serve minimal response
      }
    }

    // ── 1. Database check ───────────────────────────────────────────────────
    let dbStatus: { status: "ok" | "error"; latencyMs?: number; error?: string } = {
      status: "error",
    };
    try {
      const dbStart = Date.now();
      const client = await pool.connect();
      await client.query("SELECT 1");
      client.release();
      dbStatus = { status: "ok", latencyMs: Date.now() - dbStart };
    } catch (err) {
      dbStatus = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // ── 2. Provider checks (best-effort, 3 s timeout, non-blocking) ─────────
    const config = configLoader.get();
    const vllmEndpoint = config.providers.vllm.endpoint;
    const ollamaEndpoint = config.providers.ollama.endpoint;

    const checkUrl = async (
      baseUrl: string | undefined,
      path: string,
    ): Promise<"ok" | "unreachable" | "disabled"> => {
      if (!baseUrl) return "disabled";
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        const resp = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        return resp.ok ? "ok" : "unreachable";
      } catch {
        return "unreachable";
      }
    };

    const lmstudioEndpoint = process.env.LMSTUDIO_ENDPOINT;

    const [vllmStatus, ollamaStatus, lmstudioStatus] = await Promise.all([
      checkUrl(vllmEndpoint, "/health"),
      checkUrl(ollamaEndpoint, "/api/tags"),
      checkUrl(lmstudioEndpoint, "/v1/models"),
    ]);

    // ── 3. Overall status ───────────────────────────────────────────────────
    // unhealthy  → DB is down; app cannot serve requests
    // degraded   → DB is ok but ollama (core local provider) is unreachable
    // ok         → DB and ollama are reachable (vllm/lmstudio are optional)
    const overallStatus =
      dbStatus.status === "error"
        ? "unhealthy"
        : ollamaStatus === "unreachable"
          ? "degraded"
          : "ok";

    const statusCode = overallStatus === "unhealthy" ? 503 : 200;

    if (!isAuthenticated) {
      // Minimal response for unauthenticated callers — no internal topology
      res.status(statusCode).json({ status: overallStatus });
      return;
    }

    // Full response for authenticated users
    const body = {
      status: overallStatus,
      version: process.env.npm_package_version ?? "unknown",
      uptime: Math.floor(process.uptime()),
      db: dbStatus,
      providers: {
        vllm: { status: vllmStatus },
        ollama: { status: ollamaStatus },
        lmstudio: { status: lmstudioStatus },
      },
    };

    res.status(statusCode).json(body);
  });
}
