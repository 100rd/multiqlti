/**
 * E2E tests for the Privacy page and API.
 *
 * The standalone /privacy page was folded into Settings as a "Privacy &
 * Compliance" collapsible section (client/src/App.tsx: "/privacy" now
 * redirects to "/settings" for legacy bookmarks; the actual UI lives in
 * client/src/components/settings/PrivacySection.tsx, rendered inside a
 * SettingsSection with defaultOpen=false — same collapsed-by-default
 * pattern as the ArgoCD section in argocd-settings.spec.ts).
 */
import { test, expect } from "@playwright/test";
import { loginPage, ensureProjectHeaders } from "./helpers/auth";

/** Navigate to Settings and expand the "Privacy & Compliance" collapsible section. */
async function openPrivacySection(page: import("@playwright/test").Page) {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");

  const sectionTrigger = page.locator("button", { hasText: "Privacy & Compliance" }).first();
  const expanded = await sectionTrigger.getAttribute("aria-expanded");
  if (expanded !== "true") {
    await sectionTrigger.click();
  }
  await page.waitForTimeout(300);
}

test.describe("Privacy", () => {
  let projectHeaders: { "x-project-id": string };

  test.beforeEach(async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";
    await loginPage(page, baseURL);
    // /api/privacy is mounted behind requireAuth + requireProject (server/routes.ts).
    projectHeaders = await ensureProjectHeaders(page, baseURL);
  });

  // Privacy page rendering ───────────────────────────────────────────────────

  test("legacy /privacy bookmark redirects to /settings", async ({ page }) => {
    await page.goto("/privacy");
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain("/settings");
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body).not.toContain("Something went wrong");
  });

  test("Privacy & Compliance section renders in Settings without a 404 error", async ({ page }) => {
    await openPrivacySection(page);

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Page Not Found");
    expect(body).not.toContain("404");
  });

  // Privacy API ─────────────────────────────────────────────────────────────

  test("GET /api/privacy/patterns returns array", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";
    const res = await page.request.get(`${baseURL}/api/privacy/patterns`, { headers: projectHeaders });
    expect(res.status()).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  test("POST /api/privacy/test level=off returns unchanged text", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";
    const text = "my secret api_key=sk-test123";

    const res = await page.request.post(`${baseURL}/api/privacy/test`, {
      headers: projectHeaders,
      data: { text, level: "off" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { anonymized: string; entities: unknown[] };
    expect(body.anonymized).toBe(text);
    expect(body.entities).toHaveLength(0);
  });

  test("POST /api/privacy/test level=standard with api key → <REDACTED>", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";
    const text = "OPENAI_KEY=sk-abcdefghijklmnopqrstuvwxyz123456";

    const res = await page.request.post(`${baseURL}/api/privacy/test`, {
      headers: projectHeaders,
      data: { text, level: "standard" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { anonymized: string; entities: Array<{ type: string }> };
    expect(body.anonymized).toContain("<REDACTED>");
    expect(body.entities.length).toBeGreaterThan(0);
  });

  test("POST /api/privacy/test with email → entity badge appears", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";
    const text = "Please contact admin@example.company.io for access";

    const res = await page.request.post(`${baseURL}/api/privacy/test`, {
      headers: projectHeaders,
      data: { text, level: "standard" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { entities: Array<{ type: string }> };
    // Email entity should be detected
    expect(body.entities.some((e) => e.type === "email")).toBe(true);
  });

  test("POST /api/privacy/test with invalid regex → 400", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";

    const res = await page.request.post(`${baseURL}/api/privacy/test`, {
      headers: projectHeaders,
      data: {
        text: "some text",
        level: "standard",
        customPatterns: [
          { name: "bad", pattern: "[invalid-regex", severity: "high" },
        ],
      },
    });
    expect(res.status()).toBe(400);
  });

  // Privacy page content ────────────────────────────────────────────────────

  test("Privacy & Compliance section body contains privacy-related content", async ({ page }) => {
    await openPrivacySection(page);

    const body = (await page.locator("body").textContent()) ?? "";
    // Should mention privacy or anonymization
    const hasPrivacyContent =
      body.toLowerCase().includes("privacy") ||
      body.toLowerCase().includes("anonymiz") ||
      body.toLowerCase().includes("pattern") ||
      body.toLowerCase().includes("level");

    expect(hasPrivacyContent).toBe(true);
  });
});
