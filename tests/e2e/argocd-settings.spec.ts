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
 *   - API: PUT /api/settings/argocd missing token on first config → 400 (live DB only)
 *   - API: DELETE /api/settings/argocd idempotent 204 (live DB only)
 *   - API: POST /api/settings/argocd/test returns JSON
 *   - UI: ArgoCD card renders server URL + token fields
 *   - UI: ArgoCD card renders SSL toggle and Enabled toggle
 *   - UI: Test Connection button disabled when no config and no URL
 *   - UI: Test Connection button enables when URL is typed
 *   - UI: SSL disabled warning badge appears when SSL toggled off
 *   - UI: status badge shows "Not configured" initially
 *
 * Note: Tests marked "live DB only" use https://localhost (the Docker-hosted app
 * backed by PostgreSQL) because the ArgoCD settings routes query the database
 * directly via drizzle-orm and do not go through the IStorage abstraction used
 * by the Playwright webServer's in-memory MemStorage fallback.
 *
 * Bug documented: argocd-settings routes use `db` (drizzle PG) directly, bypassing
 * IStorage — so they fail with 500 when DATABASE_URL is unset (test environment).
 */
import { test, expect, request as playwrightRequest } from "@playwright/test";
import { loginPage } from "./helpers/auth";

const BASE_URL_FALLBACK = "http://localhost:3099";
/** Live Docker app — always has PostgreSQL available. */
const LIVE_BASE = "https://localhost";

const LIVE_EMAIL = "e2e@multiqlti.test";
const LIVE_PASSWORD = "e2e-test-password-secure";

/** Authenticate against the live Docker app and return an API context. */
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
    throw new Error(`Live auth failed: HTTP ${loginRes.status()} — ${await loginRes.text()}`);
  }

  const { token } = (await loginRes.json()) as { token: string };
  await ctx.dispose();

  return playwrightRequest.newContext({
    baseURL: LIVE_BASE,
    ignoreHTTPSErrors: true,
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

  test("settings page contains Infrastructure ArgoCD section", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").textContent();
    expect(body).toMatch(/ArgoCD/);
    expect(body).toMatch(/Infrastructure/);
  });

  test("ArgoCD card renders server URL input field", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const serverUrlInput = page.locator("#argocd-server-url");
    await expect(serverUrlInput).toBeVisible();
  });

  test("ArgoCD card renders authentication token input field", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const tokenInput = page.locator("#argocd-token");
    await expect(tokenInput).toBeVisible();
    // Token field should be type=password by default
    await expect(tokenInput).toHaveAttribute("type", "password");
  });

  test("ArgoCD token field has show/hide toggle button", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const tokenInput = page.locator("#argocd-token");
    await expect(tokenInput).toHaveAttribute("type", "password");

    // Click the eye toggle button next to the token field
    const tokenWrapper = page.locator("#argocd-token").locator("..");
    const toggleBtn = tokenWrapper.locator("button");
    await toggleBtn.click();

    await expect(tokenInput).toHaveAttribute("type", "text");
  });

  test("ArgoCD card renders SSL toggle", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const sslSwitch = page.locator("#argocd-verify-ssl");
    await expect(sslSwitch).toBeVisible();
  });

  test("ArgoCD card renders Enabled toggle", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const enabledSwitch = page.locator("#argocd-enabled");
    await expect(enabledSwitch).toBeVisible();
  });

  test("ArgoCD card status badge shows Not configured when unconfigured", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").textContent();
    // Status badge shows "Not configured" when no ArgoCD config exists
    expect(body).toMatch(/Not configured/);
  });

  test("ArgoCD Test Connection button exists", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const testBtn = page.getByRole("button", { name: /Test Connection/i });
    await expect(testBtn).toBeVisible();
  });

  test("ArgoCD Test Connection button is disabled when no URL or config", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // When not configured and no URL entered, the button should be disabled
    const testBtn = page.getByRole("button", { name: /Test Connection/i });
    await expect(testBtn).toBeDisabled();
  });

  test("ArgoCD Test Connection button enables when URL is typed", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const serverUrlInput = page.locator("#argocd-server-url");
    await serverUrlInput.fill("https://argocd.example.com");

    const testBtn = page.getByRole("button", { name: /Test Connection/i });
    await expect(testBtn).toBeEnabled();
  });

  test("ArgoCD SSL warning badge appears when SSL is toggled off", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const sslSwitch = page.locator("#argocd-verify-ssl");
    await sslSwitch.click();

    const body = await page.locator("body").textContent();
    expect(body).toMatch(/SSL disabled/i);
  });

  test("ArgoCD card describes token encryption method", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").textContent();
    expect(body).toMatch(/AES-256-GCM|encrypted/i);
  });

  // ─── API: PUT /api/settings/argocd validation ─────────────────────────────
  // These validation checks (SSRF, bad URL) fire before any DB query, so they
  // work against the in-process playwright webServer too.

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
        // serverUrl missing
      },
    });
    expect(res.status()).toBe(400);
  });

  // ─── API: DB-dependent tests (live Docker app) ────────────────────────────
  // These tests target https://localhost (Docker + PostgreSQL) directly because
  // the ArgoCD route uses drizzle-orm directly and fails without a real DB.

  test("GET /api/settings/argocd returns configured field (live DB)", async () => {
    const ctx = await authenticatedLiveContext();
    try {
      const res = await ctx.get("/api/settings/argocd");
      expect(res.status()).toBe(200);

      const body = await res.json() as { configured: boolean };
      expect(typeof body.configured).toBe("boolean");
    } finally {
      await ctx.dispose();
    }
  });

  test("GET /api/settings/argocd response is valid JSON not HTML (live DB)", async () => {
    const ctx = await authenticatedLiveContext();
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

  test("PUT /api/settings/argocd missing token on first config → 400 (live DB)", async () => {
    const ctx = await authenticatedLiveContext();
    try {
      // Ensure no config exists first
      await ctx.delete("/api/settings/argocd");

      const res = await ctx.put("/api/settings/argocd", {
        data: {
          serverUrl: "https://argocd.example.com",
          verifySsl: true,
          enabled: true,
          // token omitted — required on first setup
        },
      });
      expect(res.status()).toBe(400);
    } finally {
      await ctx.dispose();
    }
  });

  test("DELETE /api/settings/argocd returns 204 when no config exists (live DB)", async () => {
    const ctx = await authenticatedLiveContext();
    try {
      // First delete to ensure clean state
      await ctx.delete("/api/settings/argocd");

      // Second delete — nothing to delete, still 204
      const res = await ctx.delete("/api/settings/argocd");
      expect(res.status()).toBe(204);
    } finally {
      await ctx.dispose();
    }
  });

  test("POST /api/settings/argocd/test returns JSON response (live DB)", async () => {
    const ctx = await authenticatedLiveContext();
    try {
      const res = await ctx.post("/api/settings/argocd/test");

      // Never 404
      expect(res.status()).not.toBe(404);
      const contentType = res.headers()["content-type"];
      expect(contentType).toMatch(/application\/json/);
    } finally {
      await ctx.dispose();
    }
  });

  test("POST /api/settings/argocd/test when not configured returns ok:false (live DB)", async () => {
    const ctx = await authenticatedLiveContext();
    try {
      // Ensure no config
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
