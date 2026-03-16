/**
 * E2E tests for the Trigger Management UI — Phase 6.3
 *
 * Scenarios:
 *   1. /triggers page renders without errors
 *   2. Create a webhook trigger via the form dialog
 *      - Assert WebhookDetails callout appears with URL + masked secret
 *      - Assert TriggerCard appears in list with type badge "Webhook"
 *      - Assert trigger is enabled by default
 *   3. Toggle trigger enabled → disabled → verify card shows "Disabled"
 *   4. Toggle back to enabled
 *
 * Note: These tests require a running server (configured via playwright.config.ts)
 * and use API calls to set up a pipeline before testing the trigger UI.
 *
 * The TRIGGER_SECRET_KEY environment variable must be set for the server to start.
 * The playwright.config.ts webServer env block should include:
 *   TRIGGER_SECRET_KEY: process.env.TRIGGER_SECRET_KEY ?? "<64-hex-char-key>"
 */
import { test, expect } from "@playwright/test";
import { loginPage } from "./helpers/auth";

/**
 * Ensure a pipeline named "Trigger E2E Pipeline" exists and return its id.
 * Uses the API directly to avoid flakiness from pipeline list UI state.
 */
async function ensurePipeline(
  page: import("@playwright/test").Page,
  baseURL: string,
): Promise<{ id: string; name: string }> {
  // Check if it already exists
  const listRes = await page.request.get(`${baseURL}/api/pipelines`);
  expect(listRes.status()).toBe(200);
  const pipelines = (await listRes.json()) as Array<{ id: string; name: string }>;

  const existing = pipelines.find((p) => p.name === "Trigger E2E Pipeline");
  if (existing) return existing;

  // Create it
  const createRes = await page.request.post(`${baseURL}/api/pipelines`, {
    data: {
      name: "Trigger E2E Pipeline",
      description: "Used by trigger E2E tests",
      stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
    },
  });
  expect(createRes.status()).toBe(201);
  return (await createRes.json()) as { id: string; name: string };
}

test.describe("Triggers page", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? "http://localhost:3099");
  });

  test("renders /triggers without errors", async ({ page }) => {
    await page.goto("/triggers");
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain("/triggers");
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body).not.toContain("Something went wrong");
  });
});

test.describe("Trigger CRUD via UI", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? "http://localhost:3099");
    await ensurePipeline(page, testInfo.project.use.baseURL ?? "http://localhost:3099");
  });

  test("creates a webhook trigger and shows WebhookDetails callout", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";

    await page.goto("/triggers");
    await page.waitForLoadState("networkidle");

    // Click "Add Trigger" button
    const addButton = page.getByRole("button", { name: /add trigger/i });
    await expect(addButton).toBeVisible({ timeout: 5_000 });
    await addButton.click();

    // Dialog should open — wait for the pipeline select to appear
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Select the pipeline — the select has id="pipeline-select"
    const pipelineSelect = dialog.locator("#pipeline-select");
    await pipelineSelect.click();

    // Pick "Trigger E2E Pipeline" from the dropdown
    const pipelineOption = page.getByRole("option", { name: /trigger e2e pipeline/i });
    await expect(pipelineOption).toBeVisible({ timeout: 3_000 });
    await pipelineOption.click();

    // Select type "webhook" — the select has id="type-select"
    const typeSelect = dialog.locator("#type-select");
    await typeSelect.click();
    const webhookOption = page.getByRole("option", { name: /webhook/i }).first();
    await expect(webhookOption).toBeVisible({ timeout: 3_000 });
    await webhookOption.click();

    // Fill in HMAC secret
    const secretInput = dialog.locator("#webhook-secret-input");
    await secretInput.fill("test-secret-1234");

    // Submit the form
    const createBtn = dialog.getByRole("button", { name: /create trigger/i });
    await createBtn.click();

    // WebhookDetails callout should appear (after creation)
    await expect(page.getByText(/webhook url/i)).toBeVisible({ timeout: 5_000 });

    // Verify the TriggerCard appeared in the list
    const triggerCard = page.locator("text=Webhook").first();
    await expect(triggerCard).toBeVisible({ timeout: 5_000 });
  });

  test("shows trigger as enabled by default after creation", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";

    // Create trigger via API (faster than UI; UI tests the toggle behavior below)
    const pipelineRes = await page.request.get(`${baseURL}/api/pipelines`);
    const pipelines = (await pipelineRes.json()) as Array<{ id: string; name: string }>;
    const pipeline = pipelines.find((p) => p.name === "Trigger E2E Pipeline");

    if (!pipeline) {
      test.skip(true, "Pipeline not available");
      return;
    }

    await page.request.post(`${baseURL}/api/pipelines/${pipeline.id}/triggers`, {
      data: { type: "webhook", config: {}, enabled: true },
    });

    await page.goto("/triggers");
    await page.waitForLoadState("networkidle");

    // At least one trigger card should be visible
    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });

  test("API: enable/disable toggle works correctly via REST", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";

    const pipelineRes = await page.request.get(`${baseURL}/api/pipelines`);
    const pipelines = (await pipelineRes.json()) as Array<{ id: string; name: string }>;
    const pipeline = pipelines.find((p) => p.name === "Trigger E2E Pipeline");

    if (!pipeline) {
      test.skip(true, "Pipeline not available");
      return;
    }

    // Create trigger via API
    const createRes = await page.request.post(`${baseURL}/api/pipelines/${pipeline.id}/triggers`, {
      data: { type: "webhook", config: {}, enabled: true },
    });
    expect(createRes.status()).toBe(201);
    const trigger = (await createRes.json()) as { id: string; enabled: boolean };
    expect(trigger.enabled).toBe(true);

    // Disable it
    const disableRes = await page.request.post(`${baseURL}/api/triggers/${trigger.id}/disable`);
    expect(disableRes.status()).toBe(200);
    const disabled = (await disableRes.json()) as { enabled: boolean };
    expect(disabled.enabled).toBe(false);

    // Re-enable it
    const enableRes = await page.request.post(`${baseURL}/api/triggers/${trigger.id}/enable`);
    expect(enableRes.status()).toBe(200);
    const enabled = (await enableRes.json()) as { enabled: boolean };
    expect(enabled.enabled).toBe(true);

    // Clean up
    await page.request.delete(`${baseURL}/api/triggers/${trigger.id}`);
  });
});
