/**
 * jira-exec.ts — the sanitized Jira Cloud REST seam for TRACK-3 (the Jira analogue of
 * `gh-exec.ts`). Jira has no CLI, so this is a thin HTTP client with the SAME safety
 * posture as the `gh` seam:
 *   - NEVER throws: a network error / non-2xx / timeout degrades to `null` (reads) or
 *     `{ ok: false }` (writes) so a Jira outage can never crash the poll loop.
 *   - The API token is NEVER logged: on failure only the HTTP status + a scrubbed,
 *     header-free message leaves this module; the `Authorization` header is never
 *     surfaced.
 *   - Fail-closed auth: the email + API token come from ENV (a secret manager), read
 *     at call time. Absent ⇒ the request is not even attempted (`null`/`{ok:false}`).
 *   - SSRF containment: the request URL is built from the operator-configured
 *     `baseUrl` and a SERVER-DERIVED path, then re-checked to share `baseUrl`'s origin
 *     — a crafted path can never redirect the token to another host.
 *
 * WHY A CUSTOM SEAM (not a Jira SDK): zero new deps, and the same auditable
 * arg/URL/secret discipline the rest of the tracker code already uses. The HTTP call
 * is injectable (`JiraHttpFn`) so tests drive it with a fake — no real network.
 */

/** The token/email env var names (a secret manager sets these). Never logged. */
export const JIRA_EMAIL_ENV = "JIRA_EMAIL";
export const JIRA_TOKEN_ENV = "JIRA_API_TOKEN";

/** Default per-call wall-clock budget for a Jira request. */
const JIRA_TIMEOUT_MS = 30_000;

/** A minimal, injectable HTTP result (status + raw body text). */
export interface JiraHttpResult {
  status: number;
  body: string;
}

/** Injectable HTTP transport (tests pass a fake; prod uses `fetch`). NEVER throws-through. */
export type JiraHttpFn = (req: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}) => Promise<JiraHttpResult>;

/** Resolved auth material (basic email:token). `null` ⇒ fail-closed (not configured). */
export interface JiraAuth {
  email: string;
  token: string;
}

/**
 * Read the Jira auth from ENV (fail-closed). Returns `null` when either var is absent
 * or blank so the caller degrades WITHOUT attempting an unauthenticated call. The
 * token value is returned but NEVER logged by this module.
 */
export function readJiraAuthFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): JiraAuth | null {
  const email = (env[JIRA_EMAIL_ENV] ?? "").trim();
  const token = (env[JIRA_TOKEN_ENV] ?? "").trim();
  if (email.length === 0 || token.length === 0) return null;
  return { email, token };
}

/** Scrub any absolute path + collapse whitespace from an error string, then clamp. */
function scrub(raw: string): string {
  return raw.replace(/\/[^\s'"]+/g, "<path>").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Default transport over global `fetch` with an AbortController timeout. Never throws-through. */
const defaultHttp: JiraHttpFn = async (req) => {
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

/** Build the `Authorization: Basic <base64(email:token)>` header value. */
function basicAuthHeader(auth: JiraAuth): string {
  return "Basic " + Buffer.from(`${auth.email}:${auth.token}`, "utf8").toString("base64");
}

/**
 * Normalise `baseUrl` to an `https://host` origin. Returns `null` for anything that is
 * not a well-formed `https:` URL (fail-closed — no `http:`, no SSRF-friendly schemes).
 */
export function normalizeBaseUrl(baseUrl: string): { origin: string; base: string } | null {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "https:") return null;
    // Keep any path prefix (some Jira DC installs live under a context path) but drop
    // a trailing slash so we can join a server-derived path cleanly.
    const base = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
    return { origin: u.origin, base };
  } catch {
    return null;
  }
}

/**
 * Build + validate the absolute request URL for a SERVER-DERIVED api path + optional
 * query. Returns `null` if the resulting URL would leave `baseUrl`'s origin (SSRF
 * containment) — a crafted `path` can never redirect the token elsewhere.
 */
function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string>,
): string | null {
  const norm = normalizeBaseUrl(baseUrl);
  if (!norm) return null;
  // `path` is always server-derived (`/rest/api/3/...` with a shape-validated key),
  // but we still strip leading slashes and reject a scheme/`//host` escape before join.
  const cleanPath = path.replace(/^\/+/, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleanPath) || cleanPath.startsWith("/")) return null;
  const url = new URL(`${norm.base}/${cleanPath}`);
  if (url.origin !== norm.origin) return null; // origin escape ⇒ fail-closed.
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }
  return url.toString();
}

export interface JiraExecDeps {
  http?: JiraHttpFn;
  auth?: JiraAuth | null;
  log: (message: string) => void;
}

/**
 * GET a Jira REST resource and parse JSON. Returns `null` on ANY degrade (unconfigured
 * auth, non-2xx, network error, bad JSON, origin escape). The token is never logged.
 */
export async function jiraGetJson<T>(
  deps: JiraExecDeps,
  baseUrl: string,
  path: string,
  query?: Record<string, string>,
): Promise<T | null> {
  const auth = deps.auth ?? readJiraAuthFromEnv();
  if (!auth) {
    deps.log("jira-exec: no JIRA_EMAIL/JIRA_API_TOKEN configured — skipping (fail-closed)");
    return null;
  }
  const url = buildUrl(baseUrl, path, query);
  if (!url) {
    deps.log("jira-exec: rejected request URL (bad baseUrl / origin escape)");
    return null;
  }
  const http = deps.http ?? defaultHttp;
  try {
    const res = await http({
      method: "GET",
      url,
      headers: { Authorization: basicAuthHeader(auth), Accept: "application/json" },
      timeoutMs: JIRA_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      deps.log(`jira-exec: GET ${scrubUrl(url)} → HTTP ${res.status} (degraded)`);
      return null;
    }
    return JSON.parse(res.body) as T;
  } catch (err) {
    deps.log(`jira-exec: GET failed: ${scrub((err as Error)?.message ?? String(err))}`);
    return null;
  }
}

/**
 * POST a JSON body to a Jira REST resource (comment / transition / remote link).
 * Returns a typed `{ ok }` — never throws. On failure only the HTTP status + a scrubbed
 * message leave this module (the token / Authorization header never do).
 */
export async function jiraPostJson(
  deps: JiraExecDeps,
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ ok: true; body: string } | { ok: false; status?: number; reason: string }> {
  const auth = deps.auth ?? readJiraAuthFromEnv();
  if (!auth) {
    deps.log("jira-exec: no JIRA_EMAIL/JIRA_API_TOKEN configured — skipping (fail-closed)");
    return { ok: false, reason: "no-auth" };
  }
  const url = buildUrl(baseUrl, path);
  if (!url) {
    deps.log("jira-exec: rejected request URL (bad baseUrl / origin escape)");
    return { ok: false, reason: "bad-url" };
  }
  const http = deps.http ?? defaultHttp;
  try {
    const res = await http({
      method: "POST",
      url,
      headers: {
        Authorization: basicAuthHeader(auth),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
      timeoutMs: JIRA_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      deps.log(`jira-exec: POST ${scrubUrl(url)} → HTTP ${res.status} (degraded)`);
      return { ok: false, status: res.status, reason: `http-${res.status}` };
    }
    return { ok: true, body: res.body };
  } catch (err) {
    deps.log(`jira-exec: POST failed: ${scrub((err as Error)?.message ?? String(err))}`);
    return { ok: false, reason: "exception" };
  }
}

/** Log a URL without its query string (a JQL/label may echo the label; keep it terse). */
function scrubUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<url>";
  }
}
