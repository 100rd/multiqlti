/**
 * azure-exec.ts — the sanitized Azure DevOps REST seam for TRACK-5 (the Azure analogue of
 * `gh-exec.ts` / `jira-exec.ts`). A thin HTTP client with the SAME safety posture:
 *   - NEVER throws: a network error / non-2xx / timeout degrades to `null` (reads) or
 *     `{ ok: false }` (writes) so an Azure outage can never crash the poll loop.
 *   - The PAT is NEVER logged: on failure only the HTTP status + a scrubbed, header-free
 *     message leaves this module; the `Authorization` header is never surfaced.
 *   - Fail-closed auth: the PAT comes from ENV (a secret manager), read at call time.
 *     Absent ⇒ the request is not even attempted (`null` / `{ ok: false }`).
 *   - SSRF containment: the request URL is built from the operator-configured `baseUrl`
 *     (default `https://dev.azure.com`) + a SERVER-DERIVED path (`<org>/<project>/_apis/…`
 *     with shape-validated org/project/id), then re-checked to share `baseUrl`'s origin —
 *     a crafted path can never redirect the PAT to another host.
 *
 * Azure PAT auth is HTTP Basic with an EMPTY username and the PAT as the password. The
 * HTTP call is injectable (`AzureHttpFn`) so tests drive it with a fake — no real network.
 */

/** The PAT env var name (a secret manager sets this). Never logged. */
export const AZURE_PAT_ENV = "AZURE_DEVOPS_PAT";

/** The default Azure DevOps host (overridable by validated https config, e.g. a server install). */
export const AZURE_DEFAULT_BASE_URL = "https://dev.azure.com";

/** Default per-call wall-clock budget for an Azure request. */
const AZURE_TIMEOUT_MS = 30_000;

/** A minimal, injectable HTTP result (status + raw body text). */
export interface AzureHttpResult {
  status: number;
  body: string;
}

/** Injectable HTTP transport (tests pass a fake; prod uses `fetch`). NEVER throws-through. */
export type AzureHttpFn = (req: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}) => Promise<AzureHttpResult>;

/** Resolved auth material (a PAT). `null` ⇒ fail-closed (not configured). */
export interface AzureAuth {
  pat: string;
}

/**
 * Read the Azure auth from ENV (fail-closed). Returns `null` when the var is absent or
 * blank so the caller degrades WITHOUT attempting an unauthenticated call. The PAT is
 * returned but NEVER logged by this module.
 */
export function readAzureAuthFromEnv(env: NodeJS.ProcessEnv = process.env): AzureAuth | null {
  const pat = (env[AZURE_PAT_ENV] ?? "").trim();
  if (pat.length === 0) return null;
  return { pat };
}

/** Scrub any absolute path + collapse whitespace from an error string, then clamp. */
function scrub(raw: string): string {
  return raw.replace(/\/[^\s'"]+/g, "<path>").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Default transport over global `fetch` with an AbortController timeout. Never throws-through. */
const defaultHttp: AzureHttpFn = async (req) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
    const body = await res.text().catch(() => "");
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
};

/** The `Authorization: Basic <base64(:PAT)>` header (empty user, PAT as password). */
function basicAuthHeader(auth: AzureAuth): string {
  return "Basic " + Buffer.from(`:${auth.pat}`, "utf8").toString("base64");
}

/** Normalise `baseUrl` to an `https://host[/path]` origin. `null` for non-https / malformed. */
export function normalizeBaseUrl(baseUrl: string): { origin: string; base: string } | null {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "https:") return null;
    const base = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
    return { origin: u.origin, base };
  } catch {
    return null;
  }
}

/**
 * Build + validate the absolute request URL for a SERVER-DERIVED api path + optional
 * query. `null` if the URL would leave `baseUrl`'s origin (SSRF containment).
 */
function buildUrl(baseUrl: string, path: string, query?: Record<string, string>): string | null {
  const norm = normalizeBaseUrl(baseUrl);
  if (!norm) return null;
  const cleanPath = path.replace(/^\/+/, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleanPath) || cleanPath.startsWith("/")) return null;
  const url = new URL(`${norm.base}/${cleanPath}`);
  if (url.origin !== norm.origin) return null; // origin escape ⇒ fail-closed.
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }
  return url.toString();
}

export interface AzureExecDeps {
  http?: AzureHttpFn;
  auth?: AzureAuth | null;
  /** The Azure host base (default `AZURE_DEFAULT_BASE_URL`). */
  baseUrl?: string;
  log: (message: string) => void;
}

/** Log a URL without its query string (a WIQL/tag might echo in a query param). */
function scrubUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<url>";
  }
}

function resolveBase(deps: AzureExecDeps): string {
  return deps.baseUrl && deps.baseUrl.trim().length > 0 ? deps.baseUrl : AZURE_DEFAULT_BASE_URL;
}

/**
 * GET an Azure REST resource and parse JSON. Returns `null` on ANY degrade (unconfigured
 * auth, non-2xx, network error, bad JSON, origin escape). The PAT is never logged.
 */
export async function azureGetJson<T>(
  deps: AzureExecDeps,
  path: string,
  query?: Record<string, string>,
): Promise<T | null> {
  const auth = deps.auth ?? readAzureAuthFromEnv();
  if (!auth) {
    deps.log("azure-exec: no AZURE_DEVOPS_PAT configured — skipping (fail-closed)");
    return null;
  }
  const url = buildUrl(resolveBase(deps), path, query);
  if (!url) {
    deps.log("azure-exec: rejected request URL (bad baseUrl / origin escape)");
    return null;
  }
  const http = deps.http ?? defaultHttp;
  try {
    const res = await http({
      method: "GET",
      url,
      headers: { Authorization: basicAuthHeader(auth), Accept: "application/json" },
      timeoutMs: AZURE_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      deps.log(`azure-exec: GET ${scrubUrl(url)} → HTTP ${res.status} (degraded)`);
      return null;
    }
    return JSON.parse(res.body) as T;
  } catch (err) {
    deps.log(`azure-exec: GET failed: ${scrub((err as Error)?.message ?? String(err))}`);
    return null;
  }
}

/**
 * Send a JSON body (POST for WIQL / comments; PATCH for JSON-patch field updates) to an
 * Azure REST resource. `contentType` lets the caller pass `application/json-patch+json`
 * for work-item field patches. Returns a typed `{ ok }` — never throws; the PAT never
 * leaves this module.
 */
export async function azureSendJson(
  deps: AzureExecDeps,
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
  opts?: { query?: Record<string, string>; contentType?: string },
): Promise<{ ok: true; body: string } | { ok: false; status?: number; reason: string }> {
  const auth = deps.auth ?? readAzureAuthFromEnv();
  if (!auth) {
    deps.log("azure-exec: no AZURE_DEVOPS_PAT configured — skipping (fail-closed)");
    return { ok: false, reason: "no-auth" };
  }
  const url = buildUrl(resolveBase(deps), path, opts?.query);
  if (!url) {
    deps.log("azure-exec: rejected request URL (bad baseUrl / origin escape)");
    return { ok: false, reason: "bad-url" };
  }
  const http = deps.http ?? defaultHttp;
  try {
    const res = await http({
      method,
      url,
      headers: {
        Authorization: basicAuthHeader(auth),
        Accept: "application/json",
        "Content-Type": opts?.contentType ?? "application/json",
      },
      body: JSON.stringify(body ?? {}),
      timeoutMs: AZURE_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      deps.log(`azure-exec: ${method} ${scrubUrl(url)} → HTTP ${res.status} (degraded)`);
      return { ok: false, status: res.status, reason: `http-${res.status}` };
    }
    return { ok: true, body: res.body };
  } catch (err) {
    deps.log(`azure-exec: ${method} failed: ${scrub((err as Error)?.message ?? String(err))}`);
    return { ok: false, reason: "exception" };
  }
}
