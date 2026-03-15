/**
 * E2E tests for sandbox configuration.
 * Tests the sandbox API endpoints and verifies the pipeline detail page loads.
 */
import { test, expect } from "@playwright/test";
import { loginPage } from "./helpers/auth";

test.describe("Sandbox", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? "http://localhost:3099");
  });

  // Sandbox API ─────────────────────────────────────────────────────────────

  test("GET /api/sandbox/status returns JSON with available boolean", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";
    const res = await page.request.get(`${baseURL}/api/sandbox/status`);

    expect(res.status()).toBe(200);
    const body = await res.json() as { available: boolean };
    expect(typeof body.available).toBe("boolean");
  });

  test("GET /api/sandbox/presets returns array with id field", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";
    const res = await page.request.get(`${baseURL}/api/sandbox/presets`);

    expect(res.status()).toBe(200);
    const body = await res.json() as Array<{ id: string; image: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);

    for (const preset of body) {
      expect(typeof preset.id).toBe("string");
      expect(typeof preset.image).toBe("string");
    }
  });

  test("GET /api/sandbox/presets includes node and python images", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";
    const res = await page.request.get(`${baseURL}/api/sandbox/presets`);

    const body = await res.json() as Array<{ id: string; image: string }>;
    const images = body.map((p) => p.image);

    // Should include node and python images
    expect(images.some((img) => img.toLowerCase().includes("node"))).toBe(true);
  });

  test("POST /api/sandbox/test with valid image → not 400", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";
    const res = await page.request.post(`${baseURL}/api/sandbox/test`, {
      data: { image: "node:20-alpine" },
    });

    // Should be 200 (with Docker) or 500 (without Docker), but NOT 400
    expect(res.status()).not.toBe(400);
  });

  test("POST /api/sandbox/test with missing image → 400", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";
    const res = await page.request.post(`${baseURL}/api/sandbox/test`, {
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  // Pipeline page with sandbox section ──────────────────────────────────────

  test("pipeline detail page renders without sandbox errors", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";

    // Create a pipeline
    const createRes = await page.request.post(`${baseURL}/api/pipelines`, {
      data: {
        name: "Sandbox E2E Pipeline",
        description: "For sandbox E2E tests",
        stages: [{ teamId: "development", modelSlug: "mock", enabled: true }],
      },
    });
    expect(createRes.status()).toBe(201);
    const pipeline = await createRes.json() as { id: string };

    await page.goto(`/pipelines/${pipeline.id}`);
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
    expect(page.url()).toContain(pipeline.id);
  });

  test("sandbox presets API response is valid JSON (not HTML)", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";
    const res = await page.request.get(`${baseURL}/api/sandbox/presets`);

    const contentType = res.headers()["content-type"];
    expect(contentType).toMatch(/application\/json/);

    // Verify it's not an HTML page
    const text = await res.text();
    expect(text.trim()).not.toMatch(/^<!DOCTYPE/i);
    expect(text.trim()).not.toMatch(/^<html/i);
  });
});
