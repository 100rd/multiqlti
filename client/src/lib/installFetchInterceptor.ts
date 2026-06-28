/**
 * Global `x-project-id` fetch interceptor (project-isolation safety net).
 *
 * The shared transport helpers (lib/queryClient.ts, hooks/use-pipeline.ts,
 * hooks/use-task-groups.ts, pages/Costs.tsx, …) attach `x-project-id` via the
 * canonical `buildAuthHeaders` in projectHeaders.ts. But a number of legacy hooks
 * and pages still build their own headers inline and would 400 on project-scoped
 * routes. Rather than edit each of them, this module monkeypatches `window.fetch`
 * exactly once so EVERY same-origin `/api/*` request that targets a project-scoped
 * route carries `x-project-id` — unless the caller already set it.
 *
 * Design constraints (intentionally conservative — this is a safety net, not a
 * policy layer):
 *  - Only touches SAME-ORIGIN requests whose path starts with `/api/`. Cross-origin
 *    and non-API requests pass through untouched.
 *  - Public / project-agnostic routes (auth, health, projects, teams, sandbox,
 *    federation) are exempt — see PUBLIC_PATH_PREFIXES in projectHeaders.ts.
 *  - NEVER overwrites a header the caller explicitly provided.
 *  - NEVER sets an empty `x-project-id` — when no project is selected the request
 *    is sent as-is, so the server returns its normal 400 (the friendly "select a
 *    project" guard lives in the shared helpers, not here). The interceptor never
 *    throws.
 *  - Idempotent: installing more than once is a no-op.
 */
import { getProjectId, isPublicPath } from "./projectHeaders";

const HEADER = "x-project-id";
const INSTALLED_FLAG = "__projectIdFetchInterceptorInstalled__";

/** True only for same-origin requests under `/api/`. */
function isSameOriginApi(url: string): boolean {
  try {
    const origin = window.location.origin;
    const u = new URL(url, origin);
    return u.origin === origin && u.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  // Request
  return (input as Request).url;
}

/**
 * Install the interceptor. Safe to call multiple times; only the first call
 * patches `window.fetch`. Call once, as early as possible, before the app issues
 * any requests.
 */
export function installFetchInterceptor(): void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;

  const flagHost = window as unknown as Record<string, unknown>;
  if (flagHost[INSTALLED_FLAG]) return;

  const originalFetch = window.fetch.bind(window);

  const patched: typeof window.fetch = (input, init) => {
    try {
      const url = urlOf(input);

      // Out of scope: cross-origin, non-/api, or public routes pass through.
      if (!isSameOriginApi(url) || isPublicPath(url)) {
        return originalFetch(input, init);
      }

      // No project selected → send as-is; let the server reply with its 400.
      const projectId = getProjectId();
      if (!projectId) {
        return originalFetch(input, init);
      }

      // Effective caller headers: an explicit `init.headers` overrides the
      // Request's own headers (matching fetch semantics); otherwise use the
      // Request's headers when the input is a Request.
      const inputIsRequest =
        typeof Request !== "undefined" && input instanceof Request;
      const headerSource: HeadersInit | undefined =
        init?.headers ??
        (inputIsRequest ? (input as Request).headers : undefined);
      const headers = new Headers(headerSource);

      // Respect a header the caller explicitly set — never overwrite it.
      if (headers.has(HEADER)) {
        return originalFetch(input, init);
      }

      headers.set(HEADER, projectId);

      // Rebuild preserving body/method/credentials/etc.
      if (inputIsRequest && init === undefined) {
        return originalFetch(new Request(input as Request, { headers }));
      }
      return originalFetch(input, { ...init, headers });
    } catch {
      // Never let the interceptor break a request.
      return originalFetch(input, init);
    }
  };

  window.fetch = patched;
  flagHost[INSTALLED_FLAG] = true;
}
