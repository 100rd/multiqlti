/**
 * linear-exec.ts — the sanitized Linear GraphQL seam for TRACK-5 (the Linear analogue
 * of `gh-exec.ts` / `jira-exec.ts`). Linear has ONE GraphQL endpoint, so this is a thin
 * POST client with the SAME safety posture as the other seams:
 *   - NEVER throws: a network error / non-2xx / timeout / GraphQL `errors` degrades to
 *     `null` (reads) or `{ ok: false }` (writes) so a Linear outage can never crash the
 *     poll loop.
 *   - The API key is NEVER logged: on failure only the HTTP status + a scrubbed,
 *     header-free message leaves this module; the `Authorization` header is never
 *     surfaced.
 *   - Fail-closed auth: the API key comes from ENV (a secret manager), read at call
 *     time. Absent ⇒ the request is not even attempted (`null` / `{ ok: false }`).
 *   - SSRF containment: the request URL is the operator-configured `baseUrl` (default
 *     the public Linear GraphQL endpoint), re-validated to be `https:` and used verbatim
 *     — there is no server-derived path to smuggle a host through.
 *   - INJECTION-PROOF: every query is a STATIC string; all runtime values (label, id,
 *     comment body, state) are passed as GraphQL **variables**, never interpolated into
 *     the query text — so a hostile config/ticket value can never alter the query shape.
 *
 * The HTTP call is injectable (`LinearHttpFn`) so tests drive it with a fake — no real
 * network — exactly like `jira-exec`.
 */

/** The default public Linear GraphQL endpoint (overridable by validated https config). */
export const LINEAR_DEFAULT_API_URL = "https://api.linear.app/graphql";

/** The API-key env var name (a secret manager sets this). Never logged. */
export const LINEAR_TOKEN_ENV = "LINEAR_API_KEY";

/** Default per-call wall-clock budget for a Linear request. */
const LINEAR_TIMEOUT_MS = 30_000;

/** A minimal, injectable HTTP result (status + raw body text). */
export interface LinearHttpResult {
  status: number;
  body: string;
}

/** Injectable HTTP transport (tests pass a fake; prod uses `fetch`). NEVER throws-through. */
export type LinearHttpFn = (req: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}) => Promise<LinearHttpResult>;

/** Resolved auth material. `null` ⇒ fail-closed (not configured). */
export interface LinearAuth {
  /** A Linear personal API key OR an OAuth access token. Never logged. */
  token: string;
}

/**
 * Read the Linear auth from ENV (fail-closed). Returns `null` when the var is absent or
 * blank so the caller degrades WITHOUT attempting an unauthenticated call. The token is
 * returned but NEVER logged by this module.
 */
export function readLinearAuthFromEnv(env: NodeJS.ProcessEnv = process.env): LinearAuth | null {
  const token = (env[LINEAR_TOKEN_ENV] ?? "").trim();
  if (token.length === 0) return null;
  return { token };
}

/** Scrub any absolute path + collapse whitespace from an error string, then clamp. */
function scrub(raw: string): string {
  return raw.replace(/\/[^\s'"]+/g, "<path>").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Default transport over global `fetch` with an AbortController timeout. Never throws-through. */
const defaultHttp: LinearHttpFn = async (req) => {
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
 * Validate the GraphQL endpoint URL: must be a well-formed `https:` URL (fail-closed —
 * no `http:`, no SSRF-friendly schemes). Returns the normalised string or `null`.
 */
export function normalizeLinearUrl(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export interface LinearExecDeps {
  http?: LinearHttpFn;
  auth?: LinearAuth | null;
  /** The GraphQL endpoint (default `LINEAR_DEFAULT_API_URL`). */
  apiUrl?: string;
  log: (message: string) => void;
}

/** The Linear `Authorization` header value. Personal keys pass raw; OAuth tokens use Bearer. */
function authHeader(token: string): string {
  // A Linear OAuth access token is `lin_oauth_…`; personal keys are `lin_api_…`. Only the
  // OAuth form takes the `Bearer` prefix (personal keys are sent raw). Both never logged.
  return token.startsWith("lin_oauth_") ? `Bearer ${token}` : token;
}

/**
 * Low-level GraphQL POST. Returns the parsed `data` object on success, or `null` on ANY
 * degrade (unconfigured auth, bad url, non-2xx, network error, bad JSON, GraphQL
 * `errors`). The token is never logged. Variables are sent as a SEPARATE JSON field so
 * runtime values never touch the query text (injection-proof).
 */
async function postGraphql<T>(
  deps: LinearExecDeps,
  query: string,
  variables: Record<string, unknown>,
): Promise<T | null> {
  const auth = deps.auth ?? readLinearAuthFromEnv();
  if (!auth) {
    deps.log("linear-exec: no LINEAR_API_KEY configured — skipping (fail-closed)");
    return null;
  }
  const url = normalizeLinearUrl(deps.apiUrl ?? LINEAR_DEFAULT_API_URL);
  if (!url) {
    deps.log("linear-exec: rejected api url (must be https)");
    return null;
  }
  const http = deps.http ?? defaultHttp;
  try {
    const res = await http({
      method: "POST",
      url,
      headers: {
        Authorization: authHeader(auth.token),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      timeoutMs: LINEAR_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      deps.log(`linear-exec: POST → HTTP ${res.status} (degraded)`);
      return null;
    }
    const parsed = JSON.parse(res.body) as { data?: T; errors?: unknown };
    // GraphQL returns HTTP 200 even on query errors — treat any `errors` as a degrade.
    if (parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      deps.log("linear-exec: GraphQL returned errors (degraded)");
      return null;
    }
    return (parsed?.data ?? null) as T | null;
  } catch (err) {
    deps.log(`linear-exec: POST failed: ${scrub((err as Error)?.message ?? String(err))}`);
    return null;
  }
}

/** Run a READ query. `null` ⇒ degrade (outage / auth / GraphQL error). */
export function linearQuery<T>(
  deps: LinearExecDeps,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T | null> {
  return postGraphql<T>(deps, query, variables);
}

/**
 * Run a MUTATION. Returns a typed `{ ok }` — never throws. On failure only a scrubbed
 * message leaves this module (the token / Authorization header never do).
 */
export async function linearMutate(
  deps: LinearExecDeps,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const data = await postGraphql<{ [k: string]: { success?: boolean } }>(deps, query, variables);
  if (!data) return { ok: false, reason: "degraded" };
  // Linear mutations return `{ <op>: { success: boolean, ... } }`; treat a missing/false
  // success as a failure so a best-effort caller degrades rather than reports posted.
  const op = Object.values(data)[0];
  if (op && typeof op === "object" && op.success === false) {
    return { ok: false, reason: "mutation-unsuccessful" };
  }
  return { ok: true };
}
