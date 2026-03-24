/**
 * E2E tests for the Skill Market (Phase 9.9).
 *
 * Two categories:
 *   1. API tests  -- hit /api/skill-market/* via the Playwright webServer.
 *      The server is started with the registered adapters (MCP at minimum).
 *      Even if adapters fail to reach external services, the endpoints should
 *      still return valid shapes (empty results / 503 / etc.).
 *   2. Page tests -- navigate to /skills/market and verify the page renders.
 *
 * Closes #211
 */
import { test, expect, request as playwrightRequest } from "@playwright/test";
import { getAuthToken, loginPage } from "./helpers/auth";

const BASE_URL_FALLBACK = "http://localhost:3099";
const HAS_DATABASE = !!process.env.DATABASE_URL;

// ─── Helper: authenticated API context ───────────────────────────────────────

async function authenticatedApiContext(baseURL: string) {
  const token = await getAuthToken(baseURL);
  return playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

// =============================================================================
// API Tests
// =============================================================================

test.describe("Skill Market API — E2E", () => {
  test("GET /api/skill-market/search returns results or empty array", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.get("/api/skill-market/search");
      // The endpoint may return 200 (with results) or 503 if adapters are
      // not configured. Both are acceptable in E2E depending on environment.
      expect([200, 503]).toContain(res.status());
      if (res.status() === 200) {
        const body = await res.json();
        expect(body.results).toBeInstanceOf(Array);
        expect(typeof body.total).toBe("number");
        expect(body.sources).toBeDefined();
      }
    } finally {
      await ctx.dispose();
    }
  });

  test("GET /api/skill-market/search with query param", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.get("/api/skill-market/search?q=kubernetes&limit=5");
      expect([200, 503]).toContain(res.status());
      if (res.status() === 200) {
        const body = await res.json();
        expect(body.results).toBeInstanceOf(Array);
      }
    } finally {
      await ctx.dispose();
    }
  });

  test("GET /api/skill-market/sources returns adapter list", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.get("/api/skill-market/sources");
      expect([200, 503]).toContain(res.status());
      if (res.status() === 200) {
        const body = await res.json();
        expect(body.sources).toBeInstanceOf(Array);
        // Each source should have id, name, enabled, health
        for (const source of body.sources) {
          expect(typeof source.id).toBe("string");
          expect(typeof source.name).toBe("string");
          expect(typeof source.enabled).toBe("boolean");
        }
      }
    } finally {
      await ctx.dispose();
    }
  });

  test("GET /api/skill-market/categories returns array", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.get("/api/skill-market/categories");
      expect([200, 503]).toContain(res.status());
      if (res.status() === 200) {
        const body = await res.json();
        expect(body.categories).toBeInstanceOf(Array);
        expect(body.categories.length).toBeGreaterThan(0);
      }
    } finally {
      await ctx.dispose();
    }
  });

  test("POST /api/skill-market/install with invalid body returns 400", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.post("/api/skill-market/install", {
        data: {},
      });
      // 400 for validation error, or 503 if market not available
      expect([400, 503]).toContain(res.status());
      if (res.status() === 400) {
        const body = await res.json();
        expect(body.error).toBeDefined();
      }
    } finally {
      await ctx.dispose();
    }
  });

  test("POST /api/skill-market/install with empty externalId returns 400", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.post("/api/skill-market/install", {
        data: { externalId: "" },
      });
      expect([400, 503]).toContain(res.status());
    } finally {
      await ctx.dispose();
    }
  });

  test("GET /api/skill-market/updates returns updates object", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.get("/api/skill-market/updates");
      // 200 if update checker is running, 503 if not available
      expect([200, 503]).toContain(res.status());
      if (res.status() === 200) {
        const body = await res.json();
        expect(body.pending).toBeInstanceOf(Array);
        expect(typeof body.count).toBe("number");
        expect(typeof body.running).toBe("boolean");
      }
    } finally {
      await ctx.dispose();
    }
  });

  test("GET /api/skill-market/installed returns installed list", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.get("/api/skill-market/installed");
      expect([200, 503]).toContain(res.status());
      if (res.status() === 200) {
        const body = await res.json();
        expect(body.installed).toBeInstanceOf(Array);
      }
    } finally {
      await ctx.dispose();
    }
  });

  test("DELETE /api/skill-market/installed/:id returns 204 or 503", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.delete("/api/skill-market/installed/nonexistent-id");
      expect([204, 503]).toContain(res.status());
    } finally {
      await ctx.dispose();
    }
  });

  test("GET /api/skill-market/search validates bad params", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.get("/api/skill-market/search?limit=0");
      // 400 for validation or 503 if market not available
      expect([400, 503]).toContain(res.status());
    } finally {
      await ctx.dispose();
    }
  });
});

// =============================================================================
// Page Tests
// =============================================================================

test.describe("Skill Market Page — E2E", () => {
  test("Skill Market page loads without error", async ({ page }, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await loginPage(page, baseURL);

    // Navigate to the Skill Market page
    await page.goto("/skills/market");
    await page.waitForLoadState("networkidle");

    // The page should contain the skill market heading or search input
    const heading = page.locator("h1, h2, [data-testid='skill-market-title']");
    const searchInput = page.locator(
      "input[placeholder*='search' i], input[placeholder*='skill' i], input[type='search']",
    );

    // At least one of heading or search input should be visible
    const headingVisible = await heading.first().isVisible().catch(() => false);
    const searchVisible = await searchInput.first().isVisible().catch(() => false);

    expect(headingVisible || searchVisible).toBe(true);
  });

  test("Skill Market page does not show uncaught error", async ({ page }, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    await loginPage(page, baseURL);
    await page.goto("/skills/market");
    await page.waitForLoadState("networkidle");

    // No uncaught page errors should occur
    expect(pageErrors).toHaveLength(0);
  });
});
