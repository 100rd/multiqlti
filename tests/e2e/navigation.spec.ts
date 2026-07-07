import { test, expect } from "@playwright/test";
import { loginPage } from "./helpers/auth";

test.describe("Navigation", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? "http://localhost:3099");
  });

  test("root path renders the dashboard or redirects to a main page", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Should not be redirected to /login (user is authenticated)
    expect(page.url()).not.toContain("/login");
  });

  test("/settings renders the settings page", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain("/settings");

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });
});
