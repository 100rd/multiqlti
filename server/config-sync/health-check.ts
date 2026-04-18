/**
 * health-check.ts — Post-apply health verification.
 *
 * Issue #319: Config sync safety layer
 *
 * After a successful apply, hit /api/health to confirm the instance is
 * still responding.  This catches catastrophic config changes that crash the
 * server.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type HealthStatus = "ok" | "degraded" | "unreachable" | "error";

export interface HealthCheckResult {
  status: HealthStatus;
  responseMs: number;
  httpStatus?: number;
  error?: string;
}

/** Default timeout for the health check request. */
const DEFAULT_TIMEOUT_MS = 5_000;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Perform a quick GET /api/health against the given instance URL.
 *
 * @param instanceUrl  Base URL of the running instance, e.g. `http://localhost:5000`.
 *                     Defaults to `http://localhost:5000`.
 * @param timeoutMs    Request timeout in milliseconds (default 5 000).
 */
export async function checkInstanceHealth(
  instanceUrl = "http://localhost:5000",
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HealthCheckResult> {
  const url = `${instanceUrl.replace(/\/$/, "")}/api/health`;
  const start = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    const responseMs = Date.now() - start;

    if (response.status === 503) {
      return { status: "degraded", responseMs, httpStatus: response.status };
    }

    if (!response.ok) {
      return {
        status: "error",
        responseMs,
        httpStatus: response.status,
        error: `HTTP ${response.status}`,
      };
    }

    // Try to read status from body — fall back to "ok" on parse error
    let bodyStatus: string | undefined;
    try {
      const body = (await response.json()) as Record<string, unknown>;
      bodyStatus = typeof body["status"] === "string" ? body["status"] : undefined;
    } catch {
      bodyStatus = undefined;
    }

    const status: HealthStatus =
      bodyStatus === "ok" || bodyStatus === undefined
        ? "ok"
        : bodyStatus === "degraded"
          ? "degraded"
          : "error";

    return { status, responseMs, httpStatus: response.status };
  } catch (err: unknown) {
    const responseMs = Date.now() - start;
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      status: "unreachable",
      responseMs,
      error: isAbort ? `timeout after ${timeoutMs}ms` : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
