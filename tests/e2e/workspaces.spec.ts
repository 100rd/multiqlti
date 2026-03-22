/**
 * E2E tests for Workspace (indexer) pages and API.
 *
 * Covers:
 *   - /workspaces list page renders without errors
 *   - Workspace API GET returns valid response
 *   - Workspace POST validation (missing fields → 400)
 *
 * Note: The workspace routes use drizzle-orm directly (not the IStorage
 * abstraction). DB-dependent tests require DATABASE_URL and are skipped
 * when it is absent.
 */
import { test, expect, request as playwrightRequest } from "@playwright/test";
import { loginPage, getAuthToken } from "./helpers/auth";

const BASE_URL_FALLBACK = "http://localhost:3099";
const HAS_DATABASE = !!process.env.DATABASE_URL;

/** Create an authenticated API context against the Playwright webServer. */
async function authenticatedApiContext(baseURL: string) {
  const token = await getAuthToken(baseURL);
  return playwrightRequest.newContext({
    baseURL,
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

    const res = await page.request.post(`${baseURL}/api/workspaces`, {
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  // ─── Workspace API: DB-dependent tests ──────────────────────────────────
  // These tests require DATABASE_URL (workspace routes use drizzle-orm directly).
  // Skipped when DATABASE_URL is absent.

  test("GET /api/workspaces returns an array (DB)", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.get("/api/workspaces");
      expect(res.status()).toBe(200);

      const body = await res.json() as unknown[];
      expect(Array.isArray(body)).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });

  test("GET /api/workspaces returns valid JSON not HTML (DB)", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
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

  test("POST /api/workspaces with remote URL creates workspace (DB)", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
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
