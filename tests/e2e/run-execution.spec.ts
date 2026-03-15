import { test, expect } from "@playwright/test";
import { loginPage } from "./helpers/auth";

test.describe("Run Execution", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? "http://localhost:3099");
  });

  test("starting a run via API returns a run id", async ({ page }) => {
    const pipelineRes = await page.request.post("/api/pipelines", {
      data: {
        name: "E2E Run Test Pipeline",
        stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
      },
    });
    expect(pipelineRes.status()).toBe(201);
    const pipeline = (await pipelineRes.json()) as { id: string };

    const runRes = await page.request.post("/api/runs", {
      data: { pipelineId: pipeline.id, input: "Build a REST API for a blog" },
    });
    expect(runRes.status()).toBe(201);

    const run = (await runRes.json()) as { id: string; status: string };
    expect(run.id).toBeTruthy();
    expect(run.status).toBeTruthy();
  });

  test("run detail is accessible via GET", async ({ page }) => {
    const pipelineRes = await page.request.post("/api/pipelines", {
      data: {
        name: "E2E Run Detail Test",
        stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
      },
    });
    const pipeline = (await pipelineRes.json()) as { id: string };

    const runRes = await page.request.post("/api/runs", {
      data: { pipelineId: pipeline.id, input: "Create a user management system" },
    });
    const run = (await runRes.json()) as { id: string };

    const getRes = await page.request.get(`/api/runs/${run.id}`);
    expect(getRes.status()).toBe(200);

    const runDetail = (await getRes.json()) as { id: string; stages: unknown[] };
    expect(runDetail.id).toBe(run.id);
    expect(Array.isArray(runDetail.stages)).toBe(true);
  });

  test("navigating to a run page works without errors", async ({ page }) => {
    const pipelineRes = await page.request.post("/api/pipelines", {
      data: {
        name: "E2E Run Navigation Test",
        stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
      },
    });
    const pipeline = (await pipelineRes.json()) as { id: string };

    const runRes = await page.request.post("/api/runs", {
      data: { pipelineId: pipeline.id, input: "Design a payment service" },
    });
    const run = (await runRes.json()) as { id: string };

    await page.goto(`/runs/${run.id}`);
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain(`/runs/${run.id}`);

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });
});
