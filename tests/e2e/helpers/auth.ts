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
 * - Sets `auth_token` in localStorage so the React app considers the session active.
 * - Sets `Authorization` header on all future page.request calls.
 */
export async function loginPage(page: Page, baseURL: string): Promise<void> {
  const token = await getAuthToken(baseURL);

  // Set extra HTTP header on the page context so page.request calls include auth.
  await page.setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });

  // Navigate to login page first so the origin is available for localStorage.
  await page.goto("/login");
  await page.waitForLoadState("networkidle");

  // Set token in localStorage so React auth context considers user logged in.
  await page.evaluate((t) => localStorage.setItem("auth_token", t), token);
}
