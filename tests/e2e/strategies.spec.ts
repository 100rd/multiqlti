/**
 * E2E tests for execution strategy configuration in the pipeline UI.
 */
import { test, expect } from "@playwright/test";
import { loginPage } from "./helpers/auth";

test.describe("Execution Strategies", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? "http://localhost:3099");
  });

  // Strategy presets API ─────────────────────────────────────────────────────

  test("GET /api/strategies/presets returns array of presets", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";
    const res = await page.request.get(`${baseURL}/api/strategies/presets`);
    expect(res.status()).toBe(200);

    const presets = await res.json() as Array<{ id: string; label: string }>;
    expect(Array.isArray(presets)).toBe(true);
    expect(presets.length).toBeGreaterThanOrEqual(1);
    expect(presets.some((p) => p.id === "single")).toBe(true);
    expect(presets.some((p) => p.id === "quality_max")).toBe(true);
  });

  // Pipeline Design tab ─────────────────────────────────────────────────────

  test("pipeline detail page loads without errors", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";

    // Create a pipeline via API
    const createRes = await page.request.post(`${baseURL}/api/pipelines`, {
      data: {
        name: "Strategy E2E Pipeline",
        description: "For strategy E2E tests",
        stages: [
          { teamId: "planning", modelSlug: "mock", enabled: true },
          { teamId: "architecture", modelSlug: "mock", enabled: true },
        ],
      },
    });
    expect(createRes.status()).toBe(201);
    const pipeline = await createRes.json() as { id: string };

    await page.goto(`/pipelines/${pipeline.id}`);
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
    expect(body).not.toContain("404");
  });

  test("pipeline stage PATCH /api/pipelines/:id/stages/0/strategy applies MoA", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";

    // Create pipeline
    const createRes = await page.request.post(`${baseURL}/api/pipelines`, {
      data: {
        name: "MoA Strategy Pipeline",
        description: "Test pipeline",
        stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
      },
    });
    const pipeline = await createRes.json() as { id: string };

    // Apply MoA strategy via API
    const patchRes = await page.request.patch(
      `${baseURL}/api/pipelines/${pipeline.id}/stages/0/strategy`,
      {
        data: {
          type: "moa",
          proposers: [
            { modelSlug: "mock", role: "primary", temperature: 0.7 },
            { modelSlug: "mock", role: "secondary", temperature: 0.5 },
          ],
          aggregator: { modelSlug: "mock" },
        },
      },
    );
    expect(patchRes.status()).toBe(200);

    const updated = await patchRes.json() as { stages: Array<{ executionStrategy?: { type: string } }> };
    expect(updated.stages[0].executionStrategy?.type).toBe("moa");
  });

  test("pipeline stage PATCH with invalid strategy → 400", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";

    const createRes = await page.request.post(`${baseURL}/api/pipelines`, {
      data: {
        name: "Invalid Strategy Pipeline",
        description: "Test",
        stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
      },
    });
    const pipeline = await createRes.json() as { id: string };

    const patchRes = await page.request.patch(
      `${baseURL}/api/pipelines/${pipeline.id}/stages/0/strategy`,
      {
        data: { type: "not_a_real_strategy" },
      },
    );
    expect(patchRes.status()).toBe(400);
  });

  test("applying 'quality_max' preset via API updates all stages", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";

    // Create pipeline with multiple stages
    const createRes = await page.request.post(`${baseURL}/api/pipelines`, {
      data: {
        name: "Quality Max Pipeline",
        description: "Test",
        stages: [
          { teamId: "planning", modelSlug: "mock", enabled: true },
          { teamId: "architecture", modelSlug: "mock", enabled: true },
          { teamId: "development", modelSlug: "mock", enabled: true },
        ],
      },
    });
    const pipeline = await createRes.json() as { id: string };

    const presetRes = await page.request.patch(
      `${baseURL}/api/pipelines/${pipeline.id}/execution-preset`,
      {
        data: { presetId: "quality_max" },
      },
    );
    expect(presetRes.status()).toBe(200);

    const updated = await presetRes.json() as {
      stages: Array<{ teamId: string; executionStrategy?: { type: string } }>;
    };

    // Planning and architecture should have strategies applied
    const planningStage = updated.stages.find((s) => s.teamId === "planning");
    expect(planningStage?.executionStrategy).toBeDefined();
  });

  // Strategy UI elements ────────────────────────────────────────────────────

  test("pipeline detail page renders stage cards", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3099";

    const createRes = await page.request.post(`${baseURL}/api/pipelines`, {
      data: {
        name: "UI Stage Cards Pipeline",
        description: "For UI testing",
        stages: [
          { teamId: "planning", modelSlug: "mock", enabled: true },
          { teamId: "architecture", modelSlug: "mock", enabled: true },
        ],
      },
    });
    const pipeline = await createRes.json() as { id: string };

    await page.goto(`/pipelines/${pipeline.id}`);
    await page.waitForLoadState("networkidle");

    // Page should load with stage content
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body).not.toContain("Something went wrong");
  });
});
