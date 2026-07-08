import type { Page } from "@playwright/test";
import { request } from "@playwright/test";

const ADMIN_EMAIL = "e2e@multiqlti.test";
const ADMIN_PASSWORD = "e2e-test-password-secure";
const ADMIN_NAME = "E2E Admin";

let cachedToken: string | null = null;

/**
 * Ensure the admin user exists and return a valid auth token.
 * Registers on first call (when no users exist), logs in on subsequent calls.
 * Token is cached for the lifetime of the test worker process.
 */
export async function getAuthToken(baseURL: string): Promise<string> {
  if (cachedToken) return cachedToken;

  const ctx = await request.newContext({ baseURL });

  const statusRes = await ctx.get("/api/auth/status");
  const { hasUsers } = (await statusRes.json()) as { hasUsers: boolean };

  if (!hasUsers) {
    await ctx.post("/api/auth/register", {
      data: { email: ADMIN_EMAIL, name: ADMIN_NAME, password: ADMIN_PASSWORD },
    });
  }

  const loginRes = await ctx.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  const { token } = (await loginRes.json()) as { token: string };

  await ctx.dispose();
  cachedToken = token;
  return token;
}

/**
 * Authenticate the Playwright page:
 * - Sets `auth_token` cookie so the server accepts all requests (page.request included).
 * - Sets `auth_token` in localStorage so the React app considers the session active.
 */
export async function loginPage(page: Page, baseURL: string): Promise<void> {
  const token = await getAuthToken(baseURL);
  const url = new URL(baseURL);

  // Add cookie to the browser context — this is sent with page.request calls too.
  await page.context().addCookies([
    {
      name: "auth_token",
      value: token,
      domain: url.hostname,
      path: "/",
      httpOnly: false,
      secure: false,
    },
  ]);

  // Navigate to login page so the origin is available for localStorage writes.
  await page.goto("/login");
  await page.waitForLoadState("networkidle");

  // Set token in localStorage so the React AuthContext considers the user logged in.
  await page.evaluate((t) => localStorage.setItem("auth_token", t), token);
}

let cachedProjectId: string | null = null;

/**
 * Ensure a project exists and return the `x-project-id` header object that
 * every project-scoped `page.request`/API-context call needs (server/
 * middleware/project.ts: `requireProject` returns 400 without it — auth
 * alone is not sufficient). `page.request` and standalone
 * `request.newContext()` calls bypass the browser's client-side fetch
 * interceptor (client/src/lib/projectHeaders.ts) that normally attaches
 * this header automatically for in-app fetches, so e2e specs must send it
 * explicitly. The project id is cached for the worker process (mirrors
 * `getAuthToken`'s caching above) since almost all specs only need a valid
 * project to exist, not an isolated one per test.
 *
 * Call `loginPage(page, baseURL)` first — this reuses the page's own
 * authenticated request context to create the project.
 */
export async function ensureProjectHeaders(
  page: Page,
  baseURL: string,
): Promise<{ "x-project-id": string }> {
  if (!cachedProjectId) {
    const res = await page.request.post(`${baseURL}/api/projects`, {
      data: { name: `E2E Project ${Date.now()}`, description: "e2e seed project" },
    });
    if (res.status() !== 201) {
      throw new Error(
        `ensureProjectHeaders: POST /api/projects failed with ${res.status()}: ${await res.text()}`,
      );
    }
    const project = (await res.json()) as { id: string };
    cachedProjectId = project.id;
  }

  // Written per-call (not just on creation) because each Playwright test
  // gets a fresh page/context — localStorage does not carry over — and the
  // React app's own fetches (triggered by page.goto) read project_id from it.
  await page.evaluate((pid) => localStorage.setItem("project_id", pid), cachedProjectId);

  return { "x-project-id": cachedProjectId };
}

/**
 * Read the already-cached project id synchronously (no page/network access) —
 * for callers that need `x-project-id` on a request context that isn't the
 * test's own `page` (e.g. a second `request.newContext()` authenticated as a
 * different user). Throws if `ensureProjectHeaders` hasn't run yet in this
 * worker — call it via the page first.
 */
export function getCachedProjectHeaders(): { "x-project-id": string } {
  if (!cachedProjectId) {
    throw new Error(
      "getCachedProjectHeaders: no project cached yet — call ensureProjectHeaders(page, baseURL) first.",
    );
  }
  return { "x-project-id": cachedProjectId };
}
