/**
 * bitbucket-exec.ts — the sanitized Bitbucket Cloud REST seam for TRACK-4 (the
 * Bitbucket analogue of `jira-exec.ts`). Same safety posture as the Jira / GitLab seams:
 *   - NEVER throws: a network error / non-2xx / timeout degrades to `null` (reads) or
 *     `{ ok: false }` (writes) so a Bitbucket outage can never crash the poll loop.
 *   - The app password is NEVER logged: on failure only the HTTP status + a scrubbed,
 *     header-free message leaves this module; the `Authorization` header is never
 *     surfaced.
 *   - Fail-closed auth: the username + app password come from ENV (a secret manager),
 *     read at call time. Either absent ⇒ the request is not even attempted.
 *   - SSRF containment: the request URL is built from the `baseUrl`
 *     (`https://api.bitbucket.org` by default) and a SERVER-DERIVED path, then re-checked
 *     to share `baseUrl`'s origin — a crafted path can never redirect the token.
 *
 * SCOPE: Bitbucket CLOUD only (`api.bitbucket.org/2.0`). Bitbucket Server / Data Center
 * has a different API surface and is out of scope for TRACK-4.
 *
 * The HTTP call is injectable (`BitbucketHttpFn`) so tests drive it with a fake — no
 * real network.
 */

/** The username + app-password env var names (a secret manager sets these). Never logged. */
export const BITBUCKET_USERNAME_ENV = "BITBUCKET_USERNAME";
export const BITBUCKET_APP_PASSWORD_ENV = "BITBUCKET_APP_PASSWORD";

/** The default Bitbucket Cloud API origin (no trailing slash). */
export const BITBUCKET_DEFAULT_BASE_URL = "https://api.bitbucket.org";

/** Default per-call wall-clock budget for a Bitbucket request. */
const BITBUCKET_TIMEOUT_MS = 30_000;

/** A minimal, injectable HTTP result (status + raw body text). */
export interface BitbucketHttpResult {
  status: number;
  body: string;
}

/** Injectable HTTP transport (tests pass a fake; prod uses `fetch`). NEVER throws-through. */
export type BitbucketHttpFn = (req: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}) => Promise<BitbucketHttpResult>;

/** Resolved auth material (basic username:app_password). `null` ⇒ fail-closed. */
export interface BitbucketAuth {
  username: string;
  appPassword: string;
}

/**
 * Read the Bitbucket auth from ENV (fail-closed). Returns `null` when either var is
 * absent or blank so the caller degrades WITHOUT attempting an unauthenticated call.
 * The password is returned but NEVER logged by this module.
 */
export function readBitbucketAuthFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BitbucketAuth | null {
  const username = (env[BITBUCKET_USERNAME_ENV] ?? "").trim();
  const appPassword = (env[BITBUCKET_APP_PASSWORD_ENV] ?? "").trim();
  if (username.length === 0 || appPassword.length === 0) return null;
  return { username, appPassword };
}

/** Scrub any absolute path + collapse whitespace from an error string, then clamp. */
function scrub(raw: string): string {
  return raw.replace(/\/[^\s'"]+/g, "<path>").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Default transport over global `fetch` with an AbortController timeout. Never throws-through. */
const defaultHttp: BitbucketHttpFn = async (req) => {
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

/** Build the `Authorization: Basic <base64(user:app_password)>` header value. */
function basicAuthHeader(auth: BitbucketAuth): string {
  return "Basic " + Buffer.from(`${auth.username}:${auth.appPassword}`, "utf8").toString("base64");
}

/**
 * Normalise `baseUrl` to an `https://host` origin. Returns `null` for anything that is
 * not a well-formed `https:` URL (fail-closed — no `http:`, no SSRF-friendly schemes).
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
  const cleanPath = path.replace(/^\/+/, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleanPath) || cleanPath.startsWith("/")) return null;
  const url = new URL(`${norm.base}/${cleanPath}`);
  if (url.origin !== norm.origin) return null; // origin escape ⇒ fail-closed.
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }
  return url.toString();
}

export interface BitbucketExecDeps {
  http?: BitbucketHttpFn;
  auth?: BitbucketAuth | null;
  log: (message: string) => void;
}

/** Log a URL without its query string (a BBQL `q` may echo the label; keep it terse). */
function scrubUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<url>";
  }
}

/**
 * GET a Bitbucket REST resource and parse JSON. Returns `null` on ANY degrade
 * (unconfigured auth, non-2xx, network error, bad JSON, origin escape). Token unlogged.
 */
export async function bitbucketGetJson<T>(
  deps: BitbucketExecDeps,
  baseUrl: string,
  path: string,
  query?: Record<string, string>,
): Promise<T | null> {
  const auth = deps.auth ?? readBitbucketAuthFromEnv();
  if (!auth) {
    deps.log("bitbucket-exec: no BITBUCKET_USERNAME/BITBUCKET_APP_PASSWORD configured — skipping (fail-closed)");
    return null;
  }
  const url = buildUrl(baseUrl, path, query);
  if (!url) {
    deps.log("bitbucket-exec: rejected request URL (bad baseUrl / origin escape)");
    return null;
  }
  const http = deps.http ?? defaultHttp;
  try {
    const res = await http({
      method: "GET",
      url,
      headers: { Authorization: basicAuthHeader(auth), Accept: "application/json" },
      timeoutMs: BITBUCKET_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      deps.log(`bitbucket-exec: GET ${scrubUrl(url)} → HTTP ${res.status} (degraded)`);
      return null;
    }
    return JSON.parse(res.body) as T;
  } catch (err) {
    deps.log(`bitbucket-exec: GET failed: ${scrub((err as Error)?.message ?? String(err))}`);
    return null;
  }
}

/**
 * Send a JSON body to a Bitbucket REST resource (`POST` a comment, `PUT` a state).
 * Returns a typed `{ ok }` — never throws. On failure only the HTTP status + a scrubbed
 * message leave this module (the app password / Authorization header never do).
 */
export async function bitbucketSendJson(
  deps: BitbucketExecDeps,
  method: "POST" | "PUT",
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ ok: true; body: string } | { ok: false; status?: number; reason: string }> {
  const auth = deps.auth ?? readBitbucketAuthFromEnv();
  if (!auth) {
    deps.log("bitbucket-exec: no BITBUCKET_USERNAME/BITBUCKET_APP_PASSWORD configured — skipping (fail-closed)");
    return { ok: false, reason: "no-auth" };
  }
  const url = buildUrl(baseUrl, path);
  if (!url) {
    deps.log("bitbucket-exec: rejected request URL (bad baseUrl / origin escape)");
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
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
      timeoutMs: BITBUCKET_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      deps.log(`bitbucket-exec: ${method} ${scrubUrl(url)} → HTTP ${res.status} (degraded)`);
      return { ok: false, status: res.status, reason: `http-${res.status}` };
    }
    return { ok: true, body: res.body };
  } catch (err) {
    deps.log(`bitbucket-exec: ${method} failed: ${scrub((err as Error)?.message ?? String(err))}`);
    return { ok: false, reason: "exception" };
  }
}
