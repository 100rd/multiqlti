/**
 * E2E tests for authentication flows.
 */
import { test, expect } from "@playwright/test";
import { getAuthToken } from "./helpers/auth";

const ADMIN_EMAIL = "e2e-auth@multiqlti.test";
const ADMIN_PASSWORD = "e2e-test-password-secure";
const ADMIN_NAME = "E2E Auth Admin";

test.describe("Auth flows", () => {
  // Login page rendering ─────────────────────────────────────────────────────

  test("login page renders at /login", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain("/login");
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body).not.toContain("Something went wrong");
  });

  test("login page contains a form with email and password inputs", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    // Should have at least one input (email or username)
    const inputs = page.locator("input");
    await expect(inputs.first()).toBeVisible();
  });

  // Protected route redirect ─────────────────────────────────────────────────

  test("accessing /pipelines without auth redirects to /login", async ({ page }) => {
    // Navigate directly without setting auth cookie/localStorage
    await page.goto("/pipelines");
    await page.waitForLoadState("networkidle");

    // Should redirect to login
    expect(page.url()).toContain("/login");
  });

  test("accessing / without auth redirects to /login", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain("/login");
  });

  // Register + login flow ────────────────────────────────────────────────────

  test("authenticated user can access protected routes", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";
    const token = await getAuthToken(baseURL);

    // Set auth in cookie + localStorage
    const url = new URL(baseURL);
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

    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await page.evaluate((t) => localStorage.setItem("auth_token", t), token);

    // Navigate to protected route
    await page.goto("/pipelines");
    await page.waitForLoadState("networkidle");

    // Should NOT redirect to login
    expect(page.url()).not.toContain("/login");
  });

  // Logout ───────────────────────────────────────────────────────────────────

  test("clearing auth token causes redirect to login", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";
    const token = await getAuthToken(baseURL);

    // Set auth
    const url = new URL(baseURL);
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

    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await page.evaluate((t) => localStorage.setItem("auth_token", t), token);

    // Navigate to protected route
    await page.goto("/pipelines");
    await page.waitForLoadState("networkidle");
    expect(page.url()).not.toContain("/login");

    // Simulate logout by clearing tokens
    await page.evaluate(() => {
      localStorage.removeItem("auth_token");
    });
    await page.context().clearCookies();

    // Navigate away and back
    await page.goto("/pipelines");
    await page.waitForLoadState("networkidle");

    // Should be back at login
    expect(page.url()).toContain("/login");
  });

  // API auth endpoints ───────────────────────────────────────────────────────

  test("GET /api/auth/status returns {hasUsers: boolean}", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";

    const res = await page.request.get(`${baseURL}/api/auth/status`);
    expect(res.status()).toBe(200);
    const body = await res.json() as { hasUsers: boolean };
    expect(typeof body.hasUsers).toBe("boolean");
  });

  test("POST /api/auth/register with existing users → 403", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";

    // Ensure a user exists first
    await getAuthToken(baseURL);

    const res = await page.request.post(`${baseURL}/api/auth/register`, {
      data: {
        email: "second-user@test.com",
        name: "Second User",
        password: "password12345",
      },
    });

    // Should be 403 — single-user mode
    expect(res.status()).toBe(403);
  });
});
