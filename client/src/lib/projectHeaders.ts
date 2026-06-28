/**
 * Canonical auth + project-isolation header builder for the React client.
 *
 * Every project-scoped API request must carry `x-project-id`; the server returns
 * 400 "x-project-id header is required" without it. Historically each hook built
 * its own headers and attached the project id inconsistently — most omitted it
 * silently, a few sent it as an empty string, some sent nothing at all. This
 * module is the SINGLE SOURCE OF TRUTH so callers (and the shared transport
 * helpers) stay consistent.
 *
 * Rules enforced here:
 *  - `Authorization: Bearer <token>` is attached whenever a token exists.
 *  - `x-project-id` is attached ONLY when a project is actually selected, and
 *    NEVER as an empty string.
 *  - Public / project-agnostic endpoints (auth, health, projects, sandbox,
 *    federation) never receive `x-project-id` and are exempt from the guard.
 */

const AUTH_TOKEN_KEY = "auth_token";
const PROJECT_ID_KEY = "project_id";

export function getAuthToken(): string | null {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

/**
 * The selected project id, or `null`. An empty/whitespace value in storage is
 * treated as "no project selected" so we never emit an empty `x-project-id`.
 */
export function getProjectId(): string | null {
  const pid = localStorage.getItem(PROJECT_ID_KEY);
  return pid && pid.trim() !== "" ? pid : null;
}

/**
 * Public / project-agnostic endpoints. The server does NOT enforce `x-project-id`
 * on these, so they are exempt from the "select a project" guard (a stray header
 * is harmless and simply ignored). Kept in sync with the server's public router
 * list — see tests/integration/require-project-middleware.test.ts. Matched by
 * pathname prefix.
 */
const PUBLIC_PATH_PREFIXES = [
  "/api/auth",
  "/api/health",
  "/api/projects",
  "/api/teams",
  "/api/sandbox",
  "/api/federation",
];

/** Normalise an absolute-or-relative request URL to its pathname. */
function pathOf(url: string): string {
  try {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "http://localhost";
    return new URL(url, origin).pathname;
  } catch {
    return url.split("?")[0];
  }
}

export function isPublicPath(url: string): boolean {
  const path = pathOf(url);
  return PUBLIC_PATH_PREFIXES.some(
    (p) => path === p || path.startsWith(`${p}/`),
  );
}

/**
 * Build auth + project-isolation headers.
 *
 * @param hasBody when true, also sets `Content-Type: application/json`.
 */
export function buildAuthHeaders(hasBody = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (hasBody) headers["Content-Type"] = "application/json";

  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const projectId = getProjectId();
  if (projectId) headers["x-project-id"] = projectId;

  return headers;
}

/**
 * Thrown when a project-scoped request is attempted with no project selected.
 * Lets the UI render a friendly "select a project" state instead of surfacing a
 * raw 400 from a doomed request.
 */
export class ProjectRequiredError extends Error {
  readonly isProjectRequired = true;
  constructor(message = "Select a project to continue.") {
    super(message);
    this.name = "ProjectRequiredError";
  }
}

export function isProjectRequiredError(e: unknown): e is ProjectRequiredError {
  return (
    e instanceof ProjectRequiredError ||
    (typeof e === "object" && e !== null && "isProjectRequired" in e)
  );
}

/**
 * Guard a project-scoped request: throw a friendly typed error instead of firing
 * a request the server will reject with 400. Public paths are exempt. Call this
 * at the top of shared transport helpers before `fetch`.
 */
export function assertProjectSelected(url: string): void {
  if (isPublicPath(url)) return;
  if (getProjectId() === null) {
    throw new ProjectRequiredError();
  }
}
