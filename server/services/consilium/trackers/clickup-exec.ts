/**
 * clickup-exec.ts — the sanitized ClickUp REST seam for TRACK-5 (the ClickUp analogue of
 * `gh-exec.ts` / `jira-exec.ts`). A thin HTTP client with the SAME safety posture:
 *   - NEVER throws: a network error / non-2xx / timeout degrades to `null` (reads) or
 *     `{ ok: false }` (writes) so a ClickUp outage can never crash the poll loop.
 *   - The API token is NEVER logged: on failure only the HTTP status + a scrubbed,
 *     header-free message leaves this module; the `Authorization` header is never
 *     surfaced.
 *   - Fail-closed auth: the token comes from ENV (a secret manager), read at call time.
 *     Absent ⇒ the request is not even attempted (`null` / `{ ok: false }`).
 *   - SSRF containment: the request URL is built from the operator-configured `baseUrl`
 *     (default the public ClickUp v2 API) + a SERVER-DERIVED path (`/list/{id}/task`,
 *     `/task/{id}` with a shape-validated id), then re-checked to share `baseUrl`'s origin.
 *
 * ClickUp personal tokens are sent RAW in the `Authorization` header (no `Bearer`). The
 * HTTP call is injectable (`ClickUpHttpFn`) so tests drive it with a fake — no real network.
 * (The inbound webhook `X-Signature` HMAC path, #494, is a documented follow-up.)
 */

/** The API token env var name (a secret manager sets this). Never logged. */
export const CLICKUP_TOKEN_ENV = "CLICKUP_API_TOKEN";

/** The default public ClickUp v2 API base (overridable by validated https config). */
export const CLICKUP_DEFAULT_BASE_URL = "https://api.clickup.com/api/v2";

/** Default per-call wall-clock budget for a ClickUp request. */
const CLICKUP_TIMEOUT_MS = 30_000;

/** A minimal, injectable HTTP result (status + raw body text). */
export interface ClickUpHttpResult {
  status: number;
  body: string;
}

/** Injectable HTTP transport (tests pass a fake; prod uses `fetch`). NEVER throws-through. */
export type ClickUpHttpFn = (req: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}) => Promise<ClickUpHttpResult>;

/** Resolved auth material (a personal API token or OAuth access token). `null` ⇒ fail-closed. */
export interface ClickUpAuth {
  token: string;
}

/**
 * Read the ClickUp auth from ENV (fail-closed). Returns `null` when the var is absent or
 * blank so the caller degrades WITHOUT attempting an unauthenticated call. The token is
 * returned but NEVER logged by this module.
 */
export function readClickUpAuthFromEnv(env: NodeJS.ProcessEnv = process.env): ClickUpAuth | null {
  const token = (env[CLICKUP_TOKEN_ENV] ?? "").trim();
  if (token.length === 0) return null;
  return { token };
}

/** Scrub any absolute path + collapse whitespace from an error string, then clamp. */
function scrub(raw: string): string {
  return raw.replace(/\/[^\s'"]+/g, "<path>").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Default transport over global `fetch` with an AbortController timeout. Never throws-through. */
const defaultHttp: ClickUpHttpFn = async (req) => {
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
 * query. `null` if the URL would leave `baseUrl`'s origin (SSRF containment). `query`
 * values are set via `URLSearchParams` so a value can never inject extra params.
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

export interface ClickUpExecDeps {
  http?: ClickUpHttpFn;
  auth?: ClickUpAuth | null;
  /** The ClickUp API base (default `CLICKUP_DEFAULT_BASE_URL`). */
  baseUrl?: string;
  log: (message: string) => void;
}

/** Log a URL without its query string (a tag might echo in a query param). */
function scrubUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<url>";
  }
}

function resolveBase(deps: ClickUpExecDeps): string {
  return deps.baseUrl && deps.baseUrl.trim().length > 0 ? deps.baseUrl : CLICKUP_DEFAULT_BASE_URL;
}

/**
 * GET a ClickUp REST resource and parse JSON. Returns `null` on ANY degrade (unconfigured
 * auth, non-2xx, network error, bad JSON, origin escape). The token is never logged.
 */
export async function clickupGetJson<T>(
  deps: ClickUpExecDeps,
  path: string,
  query?: Record<string, string>,
): Promise<T | null> {
  const auth = deps.auth ?? readClickUpAuthFromEnv();
  if (!auth) {
    deps.log("clickup-exec: no CLICKUP_API_TOKEN configured — skipping (fail-closed)");
    return null;
  }
  const url = buildUrl(resolveBase(deps), path, query);
  if (!url) {
    deps.log("clickup-exec: rejected request URL (bad baseUrl / origin escape)");
    return null;
  }
  const http = deps.http ?? defaultHttp;
  try {
    const res = await http({
      method: "GET",
      url,
      headers: { Authorization: auth.token, Accept: "application/json" },
      timeoutMs: CLICKUP_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      deps.log(`clickup-exec: GET ${scrubUrl(url)} → HTTP ${res.status} (degraded)`);
      return null;
    }
    return JSON.parse(res.body) as T;
  } catch (err) {
    deps.log(`clickup-exec: GET failed: ${scrub((err as Error)?.message ?? String(err))}`);
    return null;
  }
}

/**
 * Send a JSON body (POST for a comment; PUT for a status update) to a ClickUp REST
 * resource. Returns a typed `{ ok }` — never throws; the token never leaves this module.
 */
export async function clickupSendJson(
  deps: ClickUpExecDeps,
  method: "POST" | "PUT",
  path: string,
  body: unknown,
): Promise<{ ok: true; body: string } | { ok: false; status?: number; reason: string }> {
  const auth = deps.auth ?? readClickUpAuthFromEnv();
  if (!auth) {
    deps.log("clickup-exec: no CLICKUP_API_TOKEN configured — skipping (fail-closed)");
    return { ok: false, reason: "no-auth" };
  }
  const url = buildUrl(resolveBase(deps), path);
  if (!url) {
    deps.log("clickup-exec: rejected request URL (bad baseUrl / origin escape)");
    return { ok: false, reason: "bad-url" };
  }
  const http = deps.http ?? defaultHttp;
  try {
    const res = await http({
      method,
      url,
      headers: {
        Authorization: auth.token,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
      timeoutMs: CLICKUP_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      deps.log(`clickup-exec: ${method} ${scrubUrl(url)} → HTTP ${res.status} (degraded)`);
      return { ok: false, status: res.status, reason: `http-${res.status}` };
    }
    return { ok: true, body: res.body };
  } catch (err) {
    deps.log(`clickup-exec: ${method} failed: ${scrub((err as Error)?.message ?? String(err))}`);
    return { ok: false, reason: "exception" };
  }
}
