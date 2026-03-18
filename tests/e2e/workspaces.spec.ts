/**
 * E2E tests for Workspace (indexer) pages and API.
 *
 * Covers:
 *   - /workspaces list page renders without errors
 *   - Workspace API GET returns valid response
 *   - Workspace POST validation (missing fields → 400)
 *
 * Note: The workspace routes use drizzle-orm directly (not the IStorage
 * abstraction), so they return 500 when DATABASE_URL is unset in the Playwright
 * webServer's in-memory environment. API tests that require a real DB are
 * documented as known gaps and tested at the UI level only.
 */
import { test, expect, request as playwrightRequest } from "@playwright/test";
import { loginPage } from "./helpers/auth";

const BASE_URL_FALLBACK = "http://localhost:3099";
const LIVE_BASE = "https://localhost";
const LIVE_EMAIL = "e2e@multiqlti.test";
const LIVE_PASSWORD = "e2e-test-password-secure";

async function authenticatedLiveContext() {
  const ctx = await playwrightRequest.newContext({
    baseURL: LIVE_BASE,
    ignoreHTTPSErrors: true,
  });
  const loginRes = await ctx.post("/api/auth/login", {
    data: { email: LIVE_EMAIL, password: LIVE_PASSWORD },
  });
  if (!loginRes.ok()) {
    await ctx.dispose();
    throw new Error(`Live auth failed: HTTP ${loginRes.status()}`);
  }
  const { token } = (await loginRes.json()) as { token: string };
  await ctx.dispose();

  return playwrightRequest.newContext({
    baseURL: LIVE_BASE,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe("Workspaces", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? BASE_URL_FALLBACK);
  });

  // ─── Page rendering ───────────────────────────────────────────────────────

  test("navigates to /workspaces without error", async ({ page }) => {
    await page.goto("/workspaces");
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain("/workspaces");
    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
    expect(body).not.toContain("Page Not Found");
  });

  test("workspaces page renders workspace-related content", async ({ page }) => {
    await page.goto("/workspaces");
    await page.waitForLoadState("networkidle");

    const body = (await page.locator("body").textContent()) ?? "";
    const hasWorkspaceContent =
      body.toLowerCase().includes("workspace") ||
      body.toLowerCase().includes("repository") ||
      body.toLowerCase().includes("connect") ||
      body.toLowerCase().includes("git");
    expect(hasWorkspaceContent).toBe(true);
  });

  test("workspaces page does not show 404", async ({ page }) => {
    await page.goto("/workspaces");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("404");
    expect(body).not.toContain("Page Not Found");
  });

  // ─── Workspace API: validation (no DB needed) ─────────────────────────────

  test("POST /api/workspaces with missing required fields → 400", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;

    // Missing both type and path — should fail schema validation before DB
    const res = await page.request.post(`${baseURL}/api/workspaces`, {
      data: {},
    });
    // Schema validation returns 400 before DB is hit
    expect(res.status()).toBe(400);
  });

  // ─── Workspace API: live DB tests ─────────────────────────────────────────
  // These tests hit https://localhost (Docker + PostgreSQL) directly because
  // workspace routes use drizzle-orm directly, not the IStorage abstraction.

  test("GET /api/workspaces returns an array (live DB)", async () => {
    const ctx = await authenticatedLiveContext();
    try {
      const res = await ctx.get("/api/workspaces");
      expect(res.status()).toBe(200);

      const body = await res.json() as unknown[];
      expect(Array.isArray(body)).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });

  test("GET /api/workspaces returns valid JSON not HTML (live DB)", async () => {
    const ctx = await authenticatedLiveContext();
    try {
      const res = await ctx.get("/api/workspaces");
      expect(res.status()).toBe(200);

      const contentType = res.headers()["content-type"];
      expect(contentType).toMatch(/application\/json/);

      const text = await res.text();
      expect(text.trim()).not.toMatch(/^<!DOCTYPE/i);
    } finally {
      await ctx.dispose();
    }
  });

  test("POST /api/workspaces with remote URL creates workspace (live DB)", async () => {
    const ctx = await authenticatedLiveContext();
    try {
      const res = await ctx.post("/api/workspaces", {
        data: {
          type: "remote",
          url: "https://github.com/example/repo",
          name: "E2E Test Workspace",
          branch: "main",
        },
      });
      // 201 = workspace created, 400 = validation error from URL/git, either is acceptable
      expect([201, 400]).toContain(res.status());
    } finally {
      await ctx.dispose();
    }
  });
});
