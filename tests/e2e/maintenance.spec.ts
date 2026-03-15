import { test, expect } from "@playwright/test";
import { loginPage } from "./helpers/auth";

test.describe("Maintenance Autopilot page", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? "http://localhost:3099");
  });

  test("navigates to /maintenance without error", async ({ page }) => {
    await page.goto("/maintenance");
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain("/maintenance");
  });

  test("renders the Maintenance Autopilot heading", async ({ page }) => {
    await page.goto("/maintenance");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body).not.toContain("Something went wrong");
    expect(body).toContain("Maintenance Autopilot");
  });

  test("renders the three tab buttons (Overview, Policies, Scans)", async ({ page }) => {
    await page.goto("/maintenance");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").textContent();
    expect(body).toContain("Overview");
    expect(body).toContain("Policies");
    expect(body).toContain("Scans");
  });

  test("clicking Policies tab shows policies content", async ({ page }) => {
    await page.goto("/maintenance");
    await page.waitForLoadState("networkidle");

    // Click the Policies tab
    await page.getByRole("button", { name: /Policies/i }).click();
    await page.waitForLoadState("networkidle");

    // Should show New Policy button or policies list
    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
    // Either "New Policy" (empty state) or scan results are shown
    expect(body).toMatch(/New Policy|No policies configured/);
  });

  test("clicking Scans tab shows scans content", async ({ page }) => {
    await page.goto("/maintenance");
    await page.waitForLoadState("networkidle");

    // Click the Scans tab
    await page.getByRole("button", { name: /Scans/i }).click();
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });

  test("sidebar navigation item for Maintenance is present", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Sidebar should have a Maintenance link
    const maintenanceLink = page.locator("nav a[href='/maintenance'], nav [href='/maintenance']");
    // Fallback: look for 'Maintenance' text in the sidebar
    const sidebarText = await page.locator("aside").textContent();
    expect(sidebarText).toContain("Maintenance");
  });
});
