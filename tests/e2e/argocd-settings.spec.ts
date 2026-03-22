/**
 * E2E tests for ArgoCD Settings — Phase 6.10.
 *
 * Covers:
 *   - Settings page renders the ArgoCD card
 *   - API: GET /api/settings/argocd returns configured state
 *   - API: PUT /api/settings/argocd SSRF protection (localhost → 400)
 *   - API: PUT /api/settings/argocd SSRF protection (private IP → 400)
 *   - API: PUT /api/settings/argocd with invalid URL → 400
 *   - API: PUT /api/settings/argocd with missing serverUrl → 400
 *   - API: PUT /api/settings/argocd missing token on first config → 400 (DB required)
 *   - API: DELETE /api/settings/argocd idempotent 204 (DB required)
 *   - API: POST /api/settings/argocd/test returns JSON
 *   - UI: ArgoCD card renders server URL + token fields
 *   - UI: ArgoCD card renders SSL toggle and Enabled toggle
 *   - UI: Test Connection button disabled when no config and no URL
 *   - UI: Test Connection button enables when URL is typed
 *   - UI: SSL disabled warning badge appears when SSL toggled off
 *   - UI: status badge shows "Not configured" initially
 *
 * Note: The ArgoCD section on the Settings page is inside a collapsed
 * SettingsSection (defaultOpen=false). UI tests must expand it first.
 *
 * DB-dependent API tests use the Playwright webServer (port 3099) which
 * has DATABASE_URL set in CI. They are skipped when DATABASE_URL is absent.
 */
import { test, expect, request as playwrightRequest } from "@playwright/test";
import { loginPage, getAuthToken } from "./helpers/auth";

const BASE_URL_FALLBACK = "http://localhost:3099";
const HAS_DATABASE = !!process.env.DATABASE_URL;

/**
 * Navigate to Settings and expand the ArgoCD collapsible section.
 */
async function openArgoCdSection(page: import("@playwright/test").Page) {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");

  // The ArgoCD section is a collapsed SettingsSection — click its trigger to expand
  const sectionTrigger = page.locator("button", { hasText: "ArgoCD" }).first();
  // Only expand if it's currently collapsed
  const expanded = await sectionTrigger.getAttribute("aria-expanded");
  if (expanded !== "true") {
    await sectionTrigger.click();
  }
  // Wait for the collapsible content to become visible
  await page.waitForTimeout(300);
}

/** Create an authenticated API context against the Playwright webServer. */
async function authenticatedApiContext(baseURL: string) {
  const token = await getAuthToken(baseURL);
  return playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe("ArgoCD Settings", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? BASE_URL_FALLBACK);
  });

  // ─── Settings page renders ArgoCD section ─────────────────────────────────

  test("settings page renders without error", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain("/settings");
    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
    expect(body).not.toContain("Page Not Found");
  });

  test("settings page contains ArgoCD section", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").textContent();
    expect(body).toMatch(/ArgoCD/);
    expect(body).toMatch(/GitOps deployment integration/);
  });

  test("ArgoCD card renders server URL input field", async ({ page }) => {
    await openArgoCdSection(page);

    const serverUrlInput = page.locator("#argocd-server-url");
    await expect(serverUrlInput).toBeVisible();
  });

  test("ArgoCD card renders authentication token input field", async ({ page }) => {
    await openArgoCdSection(page);

    const tokenInput = page.locator("#argocd-token");
    await expect(tokenInput).toBeVisible();
    await expect(tokenInput).toHaveAttribute("type", "password");
  });

  test("ArgoCD token field has show/hide toggle button", async ({ page }) => {
    await openArgoCdSection(page);

    const tokenInput = page.locator("#argocd-token");
    await expect(tokenInput).toHaveAttribute("type", "password");

    // Click the eye toggle button next to the token field
    const tokenWrapper = page.locator("#argocd-token").locator("..");
    const toggleBtn = tokenWrapper.locator("button");
    await toggleBtn.click();

    await expect(tokenInput).toHaveAttribute("type", "text");
  });

  test("ArgoCD card renders SSL toggle", async ({ page }) => {
    await openArgoCdSection(page);

    const sslSwitch = page.locator("#argocd-verify-ssl");
    await expect(sslSwitch).toBeVisible();
  });

  test("ArgoCD card renders Enabled toggle", async ({ page }) => {
    await openArgoCdSection(page);

    const enabledSwitch = page.locator("#argocd-enabled");
    await expect(enabledSwitch).toBeVisible();
  });

  test("ArgoCD card status badge shows Not configured when unconfigured", async ({ page }) => {
    await openArgoCdSection(page);

    const sectionContent = page.locator("[id^='settings-section-content-']").filter({ hasText: "ArgoCD" });
    const text = await sectionContent.textContent();
    expect(text).toMatch(/Not configured/);
  });

  test("ArgoCD Test Connection button exists", async ({ page }) => {
    await openArgoCdSection(page);

    const testBtn = page.getByRole("button", { name: /Test Connection/i });
    await expect(testBtn).toBeVisible();
  });

  test("ArgoCD Test Connection button is disabled when no URL or config", async ({ page }) => {
    await openArgoCdSection(page);

    const testBtn = page.getByRole("button", { name: /Test Connection/i });
    await expect(testBtn).toBeDisabled();
  });

  test("ArgoCD Test Connection button enables when URL is typed", async ({ page }) => {
    await openArgoCdSection(page);

    const serverUrlInput = page.locator("#argocd-server-url");
    await serverUrlInput.fill("https://argocd.example.com");

    const testBtn = page.getByRole("button", { name: /Test Connection/i });
    await expect(testBtn).toBeEnabled();
  });

  test("ArgoCD SSL warning badge appears when SSL is toggled off", async ({ page }) => {
    await openArgoCdSection(page);

    const sslSwitch = page.locator("#argocd-verify-ssl");
    await sslSwitch.click();

    const sectionContent = page.locator("[id^='settings-section-content-']").filter({ hasText: "ArgoCD" });
    const text = await sectionContent.textContent();
    expect(text).toMatch(/SSL disabled/i);
  });

  test("ArgoCD card describes token encryption method", async ({ page }) => {
    await openArgoCdSection(page);

    const sectionContent = page.locator("[id^='settings-section-content-']").filter({ hasText: "ArgoCD" });
    const text = await sectionContent.textContent();
    expect(text).toMatch(/AES-256-GCM|encrypted/i);
  });

  // ─── API: PUT /api/settings/argocd validation ─────────────────────────────
  // These validation checks (SSRF, bad URL) fire before any DB query, so they
  // work against the in-process Playwright webServer too.

  test("PUT /api/settings/argocd with SSRF URL (localhost) → 400", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.put(`${baseURL}/api/settings/argocd`, {
      data: {
        serverUrl: "http://localhost:8080",
        token: "some-token",
        verifySsl: true,
        enabled: true,
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/publicly reachable|SSRF/i);
  });

  test("PUT /api/settings/argocd with private IP 10.x.x.x → 400", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.put(`${baseURL}/api/settings/argocd`, {
      data: {
        serverUrl: "https://10.0.0.1:8080",
        token: "some-token",
        verifySsl: true,
        enabled: true,
      },
    });
    expect(res.status()).toBe(400);
  });

  test("PUT /api/settings/argocd with private IP 192.168.x.x → 400", async ({
    page,
  }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.put(`${baseURL}/api/settings/argocd`, {
      data: {
        serverUrl: "https://192.168.1.50",
        token: "some-token",
        verifySsl: true,
        enabled: true,
      },
    });
    expect(res.status()).toBe(400);
  });

  test("PUT /api/settings/argocd with invalid URL → 400", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.put(`${baseURL}/api/settings/argocd`, {
      data: {
        serverUrl: "not-a-url",
        token: "some-token",
        verifySsl: true,
        enabled: true,
      },
    });
    expect(res.status()).toBe(400);
  });

  test("PUT /api/settings/argocd missing serverUrl → 400", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.put(`${baseURL}/api/settings/argocd`, {
      data: {
        token: "some-token",
        verifySsl: true,
        enabled: true,
      },
    });
    expect(res.status()).toBe(400);
  });

  // ─── API: DB-dependent tests ──────────────────────────────────────────────
  // These tests require DATABASE_URL (argocd routes use drizzle-orm directly).
  // Skipped when DATABASE_URL is absent (e.g. local dev without Postgres).

  test("GET /api/settings/argocd returns configured field (DB)", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.get("/api/settings/argocd");
      expect(res.status()).toBe(200);

      const body = await res.json() as { configured: boolean };
      expect(typeof body.configured).toBe("boolean");
    } finally {
      await ctx.dispose();
    }
  });

  test("GET /api/settings/argocd response is valid JSON not HTML (DB)", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.get("/api/settings/argocd");
      expect(res.status()).toBe(200);

      const contentType = res.headers()["content-type"];
      expect(contentType).toMatch(/application\/json/);

      const text = await res.text();
      expect(text.trim()).not.toMatch(/^<!DOCTYPE/i);
    } finally {
      await ctx.dispose();
    }
  });

  test("PUT /api/settings/argocd missing token on first config → 400 (DB)", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      await ctx.delete("/api/settings/argocd");

      const res = await ctx.put("/api/settings/argocd", {
        data: {
          serverUrl: "https://argocd.example.com",
          verifySsl: true,
          enabled: true,
        },
      });
      expect(res.status()).toBe(400);
    } finally {
      await ctx.dispose();
    }
  });

  test("DELETE /api/settings/argocd returns 204 when no config exists (DB)", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      await ctx.delete("/api/settings/argocd");
      const res = await ctx.delete("/api/settings/argocd");
      expect(res.status()).toBe(204);
    } finally {
      await ctx.dispose();
    }
  });

  test("POST /api/settings/argocd/test returns JSON response (DB)", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      const res = await ctx.post("/api/settings/argocd/test");

      expect(res.status()).not.toBe(404);
      const contentType = res.headers()["content-type"];
      expect(contentType).toMatch(/application\/json/);
    } finally {
      await ctx.dispose();
    }
  });

  test("POST /api/settings/argocd/test when not configured returns ok:false (DB)", async ({}, testInfo) => {
    test.skip(!HAS_DATABASE, "Requires DATABASE_URL");
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const ctx = await authenticatedApiContext(baseURL);
    try {
      await ctx.delete("/api/settings/argocd");

      const res = await ctx.post("/api/settings/argocd/test");
      const body = await res.json() as {
        ok: boolean;
        error?: string;
        applicationCount: number;
        applications: string[];
        latencyMs: number;
      };
      expect(body.ok).toBe(false);
      expect(typeof body.applicationCount).toBe("number");
      expect(Array.isArray(body.applications)).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });
});
