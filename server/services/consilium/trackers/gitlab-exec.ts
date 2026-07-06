/**
 * gitlab-exec.ts — the sanitized GitLab REST seam for TRACK-4 (the GitLab analogue of
 * `jira-exec.ts` / `gh-exec.ts`). GitLab has a REST API but no first-party CLI we want
 * to shell out to, so this is a thin HTTP client with the SAME safety posture as the
 * Jira seam:
 *   - NEVER throws: a network error / non-2xx / timeout degrades to `null` (reads) or
 *     `{ ok: false }` (writes) so a GitLab outage can never crash the poll loop.
 *   - The PAT is NEVER logged: on failure only the HTTP status + a scrubbed,
 *     header-free message leaves this module; the `PRIVATE-TOKEN` header is never
 *     surfaced.
 *   - Fail-closed auth: the token comes from ENV (a secret manager), read at call time.
 *     Absent ⇒ the request is not even attempted (`null`/`{ok:false}`).
 *   - SSRF containment: the request URL is built from the operator-configured
 *     `baseUrl` and a SERVER-DERIVED path, then re-checked to share `baseUrl`'s origin
 *     — a crafted path can never redirect the token to another host.
 *
 * WHY A CUSTOM SEAM (not a GitLab SDK): zero new deps, and the same auditable
 * arg/URL/secret discipline the rest of the tracker code already uses. The HTTP call
 * is injectable (`GitlabHttpFn`) so tests drive it with a fake — no real network.
 */

/** The PAT / project-token env var name (a secret manager sets it). Never logged. */
export const GITLAB_TOKEN_ENV = "GITLAB_TOKEN";

/** Default per-call wall-clock budget for a GitLab request. */
const GITLAB_TIMEOUT_MS = 30_000;

/** A minimal, injectable HTTP result (status + raw body text). */
export interface GitlabHttpResult {
  status: number;
  body: string;
}

/** Injectable HTTP transport (tests pass a fake; prod uses `fetch`). NEVER throws-through. */
export type GitlabHttpFn = (req: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}) => Promise<GitlabHttpResult>;

/** Resolved auth material (a single PAT / project token). `null` ⇒ fail-closed. */
export interface GitlabAuth {
  token: string;
}

/**
 * Read the GitLab auth from ENV (fail-closed). Returns `null` when the token var is
 * absent or blank so the caller degrades WITHOUT attempting an unauthenticated call.
 * The token value is returned but NEVER logged by this module.
 */
export function readGitlabAuthFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GitlabAuth | null {
  const token = (env[GITLAB_TOKEN_ENV] ?? "").trim();
  if (token.length === 0) return null;
  return { token };
}

/** Scrub any absolute path + collapse whitespace from an error string, then clamp. */
function scrub(raw: string): string {
  return raw.replace(/\/[^\s'"]+/g, "<path>").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Default transport over global `fetch` with an AbortController timeout. Never throws-through. */
const defaultHttp: GitlabHttpFn = async (req) => {
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

/**
 * Normalise `baseUrl` to an `https://host` origin (keeping any context path prefix,
 * dropping a trailing slash). Returns `null` for anything that is not a well-formed
 * `https:` URL (fail-closed — no `http:`, no SSRF-friendly schemes).
 */
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
  // `path` is always server-derived (`api/v4/...` with URL-encoded ids), but we still
  // strip leading slashes and reject a scheme/`//host` escape before join.
  const cleanPath = path.replace(/^\/+/, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleanPath) || cleanPath.startsWith("/")) return null;
  const url = new URL(`${norm.base}/${cleanPath}`);
  if (url.origin !== norm.origin) return null; // origin escape ⇒ fail-closed.
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }
  return url.toString();
}

export interface GitlabExecDeps {
  http?: GitlabHttpFn;
  auth?: GitlabAuth | null;
  log: (message: string) => void;
}

/** The auth + accept headers for a GitLab request. The token is never logged. */
function authHeaders(auth: GitlabAuth, extra?: Record<string, string>): Record<string, string> {
  return { "PRIVATE-TOKEN": auth.token, Accept: "application/json", ...(extra ?? {}) };
}

/** Log a URL without its query string (a label may echo into the query; keep it terse). */
function scrubUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<url>";
  }
}

/**
 * GET a GitLab REST resource and parse JSON. Returns `null` on ANY degrade (unconfigured
 * auth, non-2xx, network error, bad JSON, origin escape). The token is never logged.
 */
export async function gitlabGetJson<T>(
  deps: GitlabExecDeps,
  baseUrl: string,
  path: string,
  query?: Record<string, string>,
): Promise<T | null> {
  const auth = deps.auth ?? readGitlabAuthFromEnv();
  if (!auth) {
    deps.log("gitlab-exec: no GITLAB_TOKEN configured — skipping (fail-closed)");
    return null;
  }
  const url = buildUrl(baseUrl, path, query);
  if (!url) {
    deps.log("gitlab-exec: rejected request URL (bad baseUrl / origin escape)");
    return null;
  }
  const http = deps.http ?? defaultHttp;
  try {
    const res = await http({
      method: "GET",
      url,
      headers: authHeaders(auth),
      timeoutMs: GITLAB_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      deps.log(`gitlab-exec: GET ${scrubUrl(url)} → HTTP ${res.status} (degraded)`);
      return null;
    }
    return JSON.parse(res.body) as T;
  } catch (err) {
    deps.log(`gitlab-exec: GET failed: ${scrub((err as Error)?.message ?? String(err))}`);
    return null;
  }
}

/**
 * Send a JSON body to a GitLab REST resource (`POST` a note, `PUT` a label/state).
 * Returns a typed `{ ok }` — never throws. On failure only the HTTP status + a scrubbed
 * message leave this module (the token / PRIVATE-TOKEN header never do).
 */
export async function gitlabSendJson(
  deps: GitlabExecDeps,
  method: "POST" | "PUT",
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ ok: true; body: string } | { ok: false; status?: number; reason: string }> {
  const auth = deps.auth ?? readGitlabAuthFromEnv();
  if (!auth) {
    deps.log("gitlab-exec: no GITLAB_TOKEN configured — skipping (fail-closed)");
    return { ok: false, reason: "no-auth" };
  }
  const url = buildUrl(baseUrl, path);
  if (!url) {
    deps.log("gitlab-exec: rejected request URL (bad baseUrl / origin escape)");
    return { ok: false, reason: "bad-url" };
  }
  const http = deps.http ?? defaultHttp;
  try {
    const res = await http({
      method,
      url,
      headers: authHeaders(auth, { "Content-Type": "application/json" }),
      body: JSON.stringify(body ?? {}),
      timeoutMs: GITLAB_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      deps.log(`gitlab-exec: ${method} ${scrubUrl(url)} → HTTP ${res.status} (degraded)`);
      return { ok: false, status: res.status, reason: `http-${res.status}` };
    }
    return { ok: true, body: res.body };
  } catch (err) {
    deps.log(`gitlab-exec: ${method} failed: ${scrub((err as Error)?.message ?? String(err))}`);
    return { ok: false, reason: "exception" };
  }
}
