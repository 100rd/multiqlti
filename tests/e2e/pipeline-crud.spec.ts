import { test, expect } from "@playwright/test";
import { loginPage } from "./helpers/auth";

test.describe("Pipeline CRUD", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? "http://localhost:3099");
  });

  test("pipeline list page renders without errors", async ({ page }) => {
    await page.goto("/pipelines");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body).not.toContain("Something went wrong");
  });

  test("navigating to a pipeline detail page works", async ({ page }) => {
    const response = await page.request.get("/api/pipelines");
    expect(response.status()).toBe(200);

    const pipelines = (await response.json()) as Array<{ id: string; name: string }>;

    if (pipelines.length > 0) {
      const pipeline = pipelines[0];
      await page.goto(`/pipelines/${pipeline.id}`);
      await page.waitForLoadState("networkidle");

      expect(page.url()).toContain(`/pipelines/${pipeline.id}`);

      const body = await page.locator("body").textContent();
      expect(body).not.toContain("Something went wrong");
    } else {
      test.skip(pipelines.length === 0, "No pipelines available to test");
    }
  });

  test("creating a pipeline via API and then navigating to it", async ({ page }) => {
    const createRes = await page.request.post("/api/pipelines", {
      data: {
        name: "E2E Test Pipeline",
        description: "Created by E2E test",
        stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
      },
    });
    expect(createRes.status()).toBe(201);

    const pipeline = (await createRes.json()) as { id: string; name: string };
    expect(pipeline.id).toBeTruthy();
    expect(pipeline.name).toBe("E2E Test Pipeline");

    await page.goto(`/pipelines/${pipeline.id}`);
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain(`/pipelines/${pipeline.id}`);

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });

  test("pipeline API returns 400 for invalid data", async ({ page }) => {
    const res = await page.request.post("/api/pipelines", {
      data: { name: "" },
    });
    expect(res.status()).toBe(400);
  });
});
