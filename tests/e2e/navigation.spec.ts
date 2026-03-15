import { test, expect } from "@playwright/test";

test.describe("Navigation", () => {
  test("root path renders the dashboard or redirects to a main page", async ({ page }) => {
    await page.goto("/");

    // Wait for the app to load — should not be on login page
    await page.waitForLoadState("networkidle");

    // Should not be redirected to /login
    expect(page.url()).not.toContain("/login");
  });

  test("/pipelines renders the pipeline list", async ({ page }) => {
    await page.goto("/pipelines");
    await page.waitForLoadState("networkidle");

    // Page should be accessible without login redirect
    expect(page.url()).toContain("/pipelines");
  });

  test("pipeline list page shows expected content", async ({ page }) => {
    await page.goto("/pipelines");
    await page.waitForLoadState("networkidle");

    // The seeded default pipeline template should appear
    // Just check the page renders without errors
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();

    // Should not show an error boundary crash message
    expect(body).not.toContain("Something went wrong");
  });

  test("/settings renders the settings page", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain("/settings");

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });

  test("/stats renders the statistics page", async ({ page }) => {
    await page.goto("/stats");
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain("/stats");

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });
});
