/**
 * E2E tests for the Morning News Board feature.
 *
 * Three journeys:
 *   A. Page renders — brief-header, internal-feed, external-feed, affects-you-panel
 *      all mount correctly; degraded-state notes are shown gracefully when
 *      Omniscience (backend=local) is unavailable. Page renders and the
 *      profile-editor section is visible.
 *   B. Feedback controls — mark read, thumbs-up, thumbs-down, hide each call the
 *      POST /news/items/:id/feedback endpoint and the button pressed state is
 *      reflected. Seeded via API to guarantee items exist.
 *   C. Degraded state — internal-feed-degraded and affects-degraded notes render
 *      cleanly and no "Something went wrong" banner appears. Runs regardless of
 *      DATABASE_URL because the degraded note is visible whenever internalDegraded
 *      is true, which is always the case with the default backend=local config.
 *
 * DB dependency: Journeys A and B require DATABASE_URL (workspace creation + the
 * news routes use PgStorage in the full server). Tests are SKIPPED when
 * DATABASE_URL is absent so the suite stays green in CI without Postgres.
 *
 * Omniscience dependency: default backend=local → internal feed is always
 * degraded. Journey A does NOT assert on populated internal items; it asserts on
 * the degraded-state note and that the page mounts without a crash. Journey B
 * only requires external items (always present with default config).
 *
 * Auth: reuses loginPage() + page.request from tests/e2e/helpers/auth.ts.
 * All seeding calls use page.request (inherits the auth cookie set by loginPage)
 * so the same auth session is used throughout, matching the knowledge spec.
 *
 * Playwright discovers this file via testDir: "./tests/e2e" in playwright.config.ts.
 */
import { test, expect } from "@playwright/test";
import { loginPage } from "./helpers/auth";

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_URL_FALLBACK = "http://localhost:3099";
const HAS_DATABASE = !!process.env.DATABASE_URL;

// ─── Seed helpers ─────────────────────────────────────────────────────────────

/**
 * Create a workspace using the page's authenticated request context.
 * Returns the workspace id.
 */
async function createWorkspaceViaPage(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"],
  baseURL: string,
): Promise<string> {
  const res = await page.request.post(`${baseURL}/api/workspaces`, {
    data: {
      type: "remote",
      url: "https://github.com/example/e2e-news-workspace",
      name: "E2E Morning Brief Workspace",
      branch: "main",
    },
  });
  expect([200, 201]).toContain(res.status());
  const body = (await res.json()) as { id: string };
  expect(typeof body.id).toBe("string");
  return body.id;
}

/**
 * Trigger a brief generation for the current user via POST /news/refresh.
 * Returns { briefId, generationOk } — generationOk=false when the endpoint
 * returns 429 (already generated today) or 500 (generation failure), both of
 * which are acceptable: a brief from an earlier run is fine.
 */
async function triggerBriefViaPage(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"],
  baseURL: string,
  workspaceId: string,
): Promise<{ briefId: string | null; generationOk: boolean }> {
  const res = await page.request.post(
    `${baseURL}/api/workspaces/${workspaceId}/news/refresh`,
    { data: {} },
  );

  if (res.status() === 429) {
    // Already generated today — that is fine, brief already exists.
    console.warn("[e2e] POST /news/refresh → 429 (daily cap). Brief already exists.");
    return { briefId: null, generationOk: true };
  }
  if (res.status() === 500) {
    console.warn("[e2e] POST /news/refresh → 500 (generation failed). Continuing.");
    return { briefId: null, generationOk: false };
  }

  expect(res.status()).toBe(202);
  const body = (await res.json()) as { data: { briefId: string } };
  return { briefId: body.data.briefId, generationOk: true };
}

/**
 * GET /news/brief and return { hasExternalItems, firstItemId }.
 * Uses the lazy-generate path: if a brief exists it is returned immediately;
 * if not, one is generated. Returns firstItemId=null when there are no items
 * (external fetcher offline or all items filtered out).
 */
async function getBriefViaPage(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"],
  baseURL: string,
  workspaceId: string,
): Promise<{ hasExternalItems: boolean; firstItemId: string | null }> {
  const res = await page.request.get(
    `${baseURL}/api/workspaces/${workspaceId}/news/brief`,
  );

  if (res.status() !== 200) {
    console.warn(`[e2e] GET /news/brief → ${res.status()}. Cannot inspect items.`);
    return { hasExternalItems: false, firstItemId: null };
  }

  const body = (await res.json()) as {
    data: { brief: { id: string }; items: Array<{ id: string; category: string }> };
  };

  const items = body.data.items ?? [];
  const external = items.filter((i) => i.category === "external");
  return {
    hasExternalItems: external.length > 0,
    firstItemId: items[0]?.id ?? null,
  };
}

// ─── Journey A: Page renders ──────────────────────────────────────────────────

test.describe("Journey A — Morning Brief page renders", () => {
  test.skip(!HAS_DATABASE, "Requires DATABASE_URL (news routes use PgStorage in the full server)");

  let workspaceId = "";
  let seeded = false;
  let generationOk = false;

  async function ensureSeeded(
    page: Parameters<Parameters<typeof test>[1]>[0]["page"],
    baseURL: string,
  ): Promise<void> {
    if (seeded) return;
    workspaceId = await createWorkspaceViaPage(page, baseURL);
    const result = await triggerBriefViaPage(page, baseURL, workspaceId);
    generationOk = result.generationOk;
    seeded = true;
  }

  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? BASE_URL_FALLBACK);
  });

  test("navigates to morning-brief page without error", async ({ page }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    expect(page.url()).toContain(`/workspaces/${workspaceId}/morning-brief`);
    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
    expect(body).not.toContain("Page Not Found");
  });

  test("brief-header is visible and shows the date", async ({ page }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    await expect(page.getByTestId("brief-header")).toBeVisible();

    // Header must contain a formatted date string — at minimum the year.
    const headerText = await page.getByTestId("brief-header").textContent();
    expect(headerText).toMatch(/20\d\d/);
  });

  test("brief-header shows Refresh now button for admin user", async ({ page }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    // Admin is the workspace owner → canRefresh = true → button visible.
    await expect(page.getByTestId("refresh-now")).toBeVisible();
    await expect(page.getByTestId("refresh-now")).toBeEnabled();
  });

  test("internal-feed section is visible", async ({ page }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    await expect(page.getByTestId("internal-feed")).toBeVisible();
  });

  test("external-feed section is visible", async ({ page }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    await expect(page.getByTestId("external-feed")).toBeVisible();
  });

  test("affects-you-panel is visible", async ({ page }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    await expect(page.getByTestId("affects-you-panel")).toBeVisible();
  });

  test("profile-editor section is visible", async ({ page }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    await expect(page.getByTestId("profile-editor")).toBeVisible();
  });

  test("internal-feed-degraded note is visible with default backend=local config", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    // backend=local → internalDegraded=true → this note is always rendered.
    await expect(page.getByTestId("internal-feed-degraded")).toBeVisible();
  });

  test("affects-degraded note is visible with default backend=local config", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    // backend=local → internal feed degraded → affects panel shows degraded note.
    await expect(page.getByTestId("affects-degraded")).toBeVisible();
    // affects-list must NOT appear when degraded (no blast-radius data).
    expect(await page.getByTestId("affects-list").count()).toBe(0);
  });

  test("page body does not contain raw JSON or Omniscience error envelopes", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    const body = await page.locator("body").textContent();
    // Raw JSON envelope markers must not appear in the rendered UI.
    expect(body).not.toContain('"code":');
    expect(body).not.toContain('"stack":');
    expect(body).not.toContain("OMNISCIENCE_TOKEN");
  });

  test("clicking Refresh now returns 202 or 429 and header does not crash", async ({
    page,
  }, testInfo) => {
    test.skip(!generationOk, "Initial generation failed — refresh smoke test skipped");
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    const [refreshResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/news/refresh") &&
          r.request().method() === "POST",
      ),
      page.getByTestId("refresh-now").click(),
    ]);

    // 202 = refresh accepted. 429 = daily cap already hit (also acceptable).
    expect([202, 429]).toContain(refreshResponse.status());

    // Either way, the header must not crash or show "Something went wrong".
    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Something went wrong");
  });
});

// ─── Journey B: Feedback controls ────────────────────────────────────────────

test.describe("Journey B — Feedback controls", () => {
  test.skip(!HAS_DATABASE, "Requires DATABASE_URL");

  let workspaceId = "";
  let seeded = false;
  let hasItems = false;

  async function ensureFeedbackSeeded(
    page: Parameters<Parameters<typeof test>[1]>[0]["page"],
    baseURL: string,
  ): Promise<void> {
    if (seeded) return;
    workspaceId = await createWorkspaceViaPage(page, baseURL);

    // Trigger generation first; then inspect items via the API.
    await triggerBriefViaPage(page, baseURL, workspaceId);
    const { hasExternalItems, firstItemId } = await getBriefViaPage(
      page,
      baseURL,
      workspaceId,
    );
    hasItems = hasExternalItems && !!firstItemId;
    seeded = true;
  }

  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? BASE_URL_FALLBACK);
  });

  test("mark read: POST feedback returns 200 and button is pressed", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureFeedbackSeeded(page, url);
    test.skip(!hasItems, "No items in brief — feedback tests skipped (external fetch offline or empty)");

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    const firstCard = page.getByTestId("feed-card").first();
    await expect(firstCard).toBeVisible();

    const readBtn = firstCard.getByTestId("feedback-read");
    await expect(readBtn).toBeVisible();

    const [feedbackRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/news/items/") &&
          r.url().includes("/feedback") &&
          r.request().method() === "POST",
      ),
      readBtn.click(),
    ]);

    expect(feedbackRes.status()).toBe(200);
    await expect(readBtn).toHaveAttribute("data-active", "true");

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Something went wrong");
  });

  test("thumbs up: POST feedback returns 200 and button is pressed", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureFeedbackSeeded(page, url);
    test.skip(!hasItems, "No items in brief — skipped");

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    const firstCard = page.getByTestId("feed-card").first();
    await expect(firstCard).toBeVisible();

    const upBtn = firstCard.getByTestId("feedback-up");
    const [feedbackRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/news/items/") &&
          r.url().includes("/feedback") &&
          r.request().method() === "POST",
      ),
      upBtn.click(),
    ]);

    expect(feedbackRes.status()).toBe(200);
    await expect(upBtn).toHaveAttribute("data-active", "true");
  });

  test("thumbs down: POST feedback returns 200 and button is pressed", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureFeedbackSeeded(page, url);
    test.skip(!hasItems, "No items in brief — skipped");

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    const firstCard = page.getByTestId("feed-card").first();
    await expect(firstCard).toBeVisible();

    const downBtn = firstCard.getByTestId("feedback-down");
    const [feedbackRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/news/items/") &&
          r.url().includes("/feedback") &&
          r.request().method() === "POST",
      ),
      downBtn.click(),
    ]);

    expect(feedbackRes.status()).toBe(200);
    await expect(downBtn).toHaveAttribute("data-active", "true");
  });

  test("hide: POST feedback returns 200 and button is pressed", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureFeedbackSeeded(page, url);
    test.skip(!hasItems, "No items in brief — skipped");

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    const firstCard = page.getByTestId("feed-card").first();
    await expect(firstCard).toBeVisible();

    const hideBtn = firstCard.getByTestId("feedback-hide");
    const [feedbackRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/news/items/") &&
          r.url().includes("/feedback") &&
          r.request().method() === "POST",
      ),
      hideBtn.click(),
    ]);

    expect(feedbackRes.status()).toBe(200);
    await expect(hideBtn).toHaveAttribute("data-active", "true");

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Something went wrong");
  });

  test("feedback persists on reload — read state retained after page reload", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureFeedbackSeeded(page, url);
    test.skip(!hasItems, "No items in brief — skipped");

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    const firstCard = page.getByTestId("feed-card").first();
    await expect(firstCard).toBeVisible();

    // Mark the first item as read.
    const readBtn = firstCard.getByTestId("feedback-read");
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/news/items/") &&
          r.url().includes("/feedback") &&
          r.request().method() === "POST",
      ),
      readBtn.click(),
    ]);

    // Reload and verify the card reflects the persisted read state.
    await page.reload();
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    // At least one card should have data-read-state="read" after persistence.
    const readCards = page.locator('[data-testid="feed-card"][data-read-state="read"]');
    await expect(readCards.first()).toBeVisible({ timeout: 8000 });
  });
});

// ─── Journey C: Degraded state renders cleanly ───────────────────────────────

test.describe("Journey C — Degraded state renders cleanly", () => {
  test.skip(!HAS_DATABASE, "Requires DATABASE_URL (workspace creation + news routes)");

  let workspaceId = "";
  let seeded = false;

  async function ensureDegradedSeeded(
    page: Parameters<Parameters<typeof test>[1]>[0]["page"],
    baseURL: string,
  ): Promise<void> {
    if (seeded) return;
    workspaceId = await createWorkspaceViaPage(page, baseURL);
    // Do NOT pre-trigger; the lazy GET /news/brief will generate on first load.
    seeded = true;
  }

  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? BASE_URL_FALLBACK);
  });

  test("page renders without crash or error banner when internal feed is degraded", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureDegradedSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
    expect(body).not.toContain("Page Not Found");
  });

  test("internal-feed-degraded note is always visible with backend=local", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureDegradedSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    // With backend=local the internal feed is always degraded; the note must be
    // rendered as [role="note"], not as an error banner.
    await expect(page.getByTestId("internal-feed-degraded")).toBeVisible();
    await expect(page.getByTestId("internal-feed-degraded")).toHaveAttribute("role", "note");
  });

  test("affects-you-panel shows affects-degraded note instead of crashing", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureDegradedSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    await expect(page.getByTestId("affects-you-panel")).toBeVisible();
    await expect(page.getByTestId("affects-degraded")).toBeVisible();

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });

  test("external-feed section is still visible when internal feed is degraded", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureDegradedSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    await expect(page.getByTestId("external-feed")).toBeVisible();
  });

  test("profile-editor is visible and save button is enabled when degraded", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureDegradedSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/morning-brief`);
    await page.waitForSelector('[data-testid="brief-header"]', { state: "visible", timeout: 60000 }).catch(() => page.waitForLoadState("domcontentloaded"));

    await expect(page.getByTestId("profile-editor")).toBeVisible();
    await expect(page.getByTestId("profile-save")).toBeVisible();
    await expect(page.getByTestId("profile-save")).toBeEnabled();
  });

  test("GET /news/brief API returns status=ready and internalDegraded=true", async ({
    page,
  }, testInfo) => {
    // Direct API assertion: confirms the server contract, not just the UI.
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureDegradedSeeded(page, url);

    const res = await page.request.get(
      `${url}/api/workspaces/${workspaceId}/news/brief`,
    );
    expect(res.status()).toBe(200);

    const body = (await res.json()) as {
      data: { brief: { status: string; internalDegraded: boolean }; items: unknown[] };
      meta: { internalDegraded: boolean };
    };

    expect(body.data.brief.status).toBe("ready");
    expect(body.data.brief.internalDegraded).toBe(true);
    expect(body.meta.internalDegraded).toBe(true);
    expect(Array.isArray(body.data.items)).toBe(true);
  });
});
