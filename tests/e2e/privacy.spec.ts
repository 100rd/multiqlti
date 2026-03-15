/**
 * E2E tests for the Privacy page and API.
 */
import { test, expect } from "@playwright/test";
import { loginPage } from "./helpers/auth";

test.describe("Privacy", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? "http://localhost:3099");
  });

  // Privacy page rendering ───────────────────────────────────────────────────

  test("privacy page renders at /privacy", async ({ page }) => {
    await page.goto("/privacy");
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain("/privacy");
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body).not.toContain("Something went wrong");
  });

  test("privacy page does not show a 404 error", async ({ page }) => {
    await page.goto("/privacy");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Page Not Found");
    expect(body).not.toContain("404");
  });

  // Privacy API ─────────────────────────────────────────────────────────────

  test("GET /api/privacy/patterns returns array", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";
    const res = await page.request.get(`${baseURL}/api/privacy/patterns`);
    expect(res.status()).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  test("POST /api/privacy/test level=off returns unchanged text", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";
    const text = "my secret api_key=sk-test123";

    const res = await page.request.post(`${baseURL}/api/privacy/test`, {
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

  test("privacy page body contains privacy-related content", async ({ page }) => {
    await page.goto("/privacy");
    await page.waitForLoadState("networkidle");

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
