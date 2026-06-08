/**
 * E2E tests for the Active Knowledge Base feature.
 *
 * Three journeys:
 *   A. Review queue: ingest → verify (different actor) → review accept → active,
 *      and reject removes the card from the queue.
 *   B. Refresh "Run now": POST /refresh → 202 → run report visible with diff buckets.
 *   C. Compliance panel: renders gracefully including the disabled/empty-graph case
 *      (the infra graph.json is 30 MB and exceeds the 25 MiB cap, so compliance
 *      returns all-empty lists — assert graceful rendering, not populated data).
 *
 * DB dependency: All three journeys require DATABASE_URL (workspace + practice-card
 * routes use PgStorage in the full server). Tests are SKIPPED when DATABASE_URL is
 * absent so the suite remains green in CI environments without Postgres.
 *
 * Embedder dependency: The ingest endpoint calls the configured embedding provider
 * (default: Ollama) to project cards into the vector store. When Ollama is not
 * running, ingest returns 500/503. Tests that require seeded cards are individually
 * guarded with an `ingestOk` flag set by each describe block's seeder function.
 * Tests that only need a workspace (nav, tab rendering, refresh/compliance panel
 * frame) are NOT gated on ingestOk — they run regardless.
 *
 * Auth: reuses loginPage() / getAuthToken() from tests/e2e/helpers/auth.ts.
 * All seeding calls use `page.request` (inherits the auth cookie set by loginPage)
 * rather than a separate playwrightRequest.newContext, matching the convention used
 * in workspaces.spec.ts and ensuring the same auth session throughout.
 *
 * Adversarial gate: the ingest/verify gate requires verifiedBy != ingestedBy AND
 * req.user.id != card.ingestedByUserId. With a single logged-in user, attempting
 * to verify a card you ingested returns 409. To seed cards in pending_review, we
 * register a second "verifier" user. If registration is locked (server allows only
 * the first user to self-register), affected tests self-skip.
 *
 * Playwright discovers this file via testDir: "./tests/e2e" in playwright.config.ts.
 * No other file imports this module.
 */
import { test, expect, request as playwrightRequest } from "@playwright/test";
import { loginPage, getAuthToken } from "./helpers/auth";

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_URL_FALLBACK = "http://localhost:3099";
const HAS_DATABASE = !!process.env.DATABASE_URL;

// A valid practice card payload that passes all server-side validation.
const SEED_CARD = {
  statement: "Pin all Terraform module source versions to avoid drift.",
  rationale:
    "Unpinned module sources fetch the latest version on each run, which breaks plan reproducibility and can introduce breaking changes silently. Pin to a specific tag or commit SHA.",
  appliesTo: {
    tool: "terraform",
    resourceKinds: ["module"],
    tags: ["versioning", "reproducibility"],
  },
  sources: [
    {
      url: "https://developer.hashicorp.com/terraform/language/modules/sources",
      sourceVersion: "v1.9",
      fetchedAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  confidence: 0.92,
};

// ─── Seed helpers (all use page.request so auth cookie is inherited) ───────────

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
      url: "https://github.com/example/e2e-kb-workspace",
      name: "E2E Knowledge Base Workspace",
      branch: "main",
    },
  });
  expect([200, 201]).toContain(res.status());
  const body = (await res.json()) as { id: string };
  expect(typeof body.id).toBe("string");
  return body.id;
}

/**
 * POST ingest using the page's authenticated request context.
 * Returns accepted cardIds, or an EMPTY ARRAY when the embedding service is
 * unavailable (HTTP 503/500). Callers must gate card-dependent assertions on
 * a non-empty result.
 */
async function ingestCardsViaPage(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"],
  baseURL: string,
  workspaceId: string,
  cards: (typeof SEED_CARD)[],
): Promise<string[]> {
  const res = await page.request.post(
    `${baseURL}/api/workspaces/${workspaceId}/knowledge/practice-cards/ingest`,
    {
      data: {
        topic: "terraform-module-best-practices",
        ingestedBy: "e2e-researcher-agent",
        cards,
      },
    },
  );

  // 503 = embedding provider unavailable (Ollama not running).
  // 500 = embed() call threw (provider configured but connection refused).
  // Both are infrastructure misses, not feature bugs.
  // Returning [] lets each describe block set ingestOk=false and skip
  // card-dependent assertions while keeping workspace-only tests runnable.
  if (res.status() === 503 || res.status() === 500) {
    console.warn(
      `[e2e] ingest returned ${res.status()} — embedding service unavailable. ` +
        "Card-dependent tests will be skipped.",
    );
    return [];
  }

  expect(res.status()).toBe(201);
  const body = (await res.json()) as { data: { cardIds: string[] } };
  return body.data.cardIds;
}

/**
 * Attempt to register a second user and return their auth token, or null if
 * registration is unavailable (server locks registration after first user).
 */
async function getVerifierToken(baseURL: string): Promise<string | null> {
  const ctx = await playwrightRequest.newContext({ baseURL });
  try {
    const email = "e2e-verifier@multiqlti.test";
    const regRes = await ctx.post("/api/auth/register", {
      data: {
        email,
        name: "E2E Verifier",
        password: "e2e-verifier-password-secure",
      },
    });
    // Accept 200 or 201 (created); any other status means registration is locked.
    if (regRes.status() !== 201 && regRes.status() !== 200) {
      // Try login in case the user was already registered.
      const loginRes = await ctx.post("/api/auth/login", {
        data: { email, password: "e2e-verifier-password-secure" },
      });
      if (loginRes.status() !== 200) return null;
      const { token } = (await loginRes.json()) as { token: string };
      return token;
    }
    const loginRes = await ctx.post("/api/auth/login", {
      data: { email, password: "e2e-verifier-password-secure" },
    });
    if (loginRes.status() !== 200) return null;
    const { token } = (await loginRes.json()) as { token: string };
    return token;
  } catch {
    return null;
  } finally {
    await ctx.dispose();
  }
}

/**
 * Verify a card using a DIFFERENT auth token (different user id → gate satisfied).
 * Returns the updated card's reviewState, or null on 409 (gate fired).
 */
async function verifyCardWithToken(
  baseURL: string,
  workspaceId: string,
  cardId: string,
  verifierToken: string,
): Promise<{ reviewState: string } | null> {
  const ctx = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${verifierToken}` },
  });
  try {
    const res = await ctx.post(
      `/api/workspaces/${workspaceId}/knowledge/practice-cards/${cardId}/verify`,
      {
        data: {
          verifiedBy: "e2e-validator-agent",
          verdict: "pass",
          notes: "Verified by E2E test suite.",
          checkedSources: [
            "https://developer.hashicorp.com/terraform/language/modules/sources",
          ],
        },
      },
    );
    if (res.status() === 409) return null;
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data: { reviewState: string } };
    return body.data;
  } finally {
    await ctx.dispose();
  }
}

/**
 * Accept a card via the page's authenticated request context.
 */
async function acceptCardViaPage(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"],
  baseURL: string,
  workspaceId: string,
  cardId: string,
): Promise<void> {
  const res = await page.request.post(
    `${baseURL}/api/workspaces/${workspaceId}/knowledge/practice-cards/${cardId}/review`,
    { data: { decision: "accept" } },
  );
  expect(res.status()).toBe(200);
}

// ─── Journey A: Review Queue ──────────────────────────────────────────────────

test.describe("Journey A — Review Queue", () => {
  test.skip(!HAS_DATABASE, "Requires DATABASE_URL (practice-cards use PgStorage in the full server)");

  // Shared workspace created once per describe block via the first test's page.
  let workspaceId = "";
  let baseURL = BASE_URL_FALLBACK;
  let canFullyVerify = false;
  let seeded = false;
  // Set to false when ingest returns 500/503 (embedding service unavailable).
  // Card-dependent tests skip when this is false; workspace-only tests still run.
  let ingestOk = false;

  /**
   * Lazy seeder: creates workspace + seeds cards on the first test that needs
   * them, using that test's authenticated page context. Subsequent calls are
   * no-ops (seeded flag).
   */
  async function ensureSeeded(
    page: Parameters<Parameters<typeof test>[1]>[0]["page"],
    testBaseURL: string,
  ): Promise<void> {
    if (seeded) return;
    baseURL = testBaseURL;
    workspaceId = await createWorkspaceViaPage(page, baseURL);

    // Ingest two cards (both land in pending_verification).
    // ingestCardsViaPage soft-fails (returns []) when embedder is unavailable.
    const [cardId1] = await ingestCardsViaPage(page, baseURL, workspaceId, [
      SEED_CARD,
      { ...SEED_CARD, statement: "Store Terraform remote state with backend locking enabled." },
    ]);

    if (cardId1) {
      ingestOk = true;
      // Attempt to advance card1 to pending_review using a second user.
      const verifierToken = await getVerifierToken(baseURL);
      if (verifierToken) {
        const verified = await verifyCardWithToken(baseURL, workspaceId, cardId1, verifierToken);
        canFullyVerify = verified?.reviewState === "pending_review";
      }
    }

    seeded = true;
  }

  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? BASE_URL_FALLBACK);
  });

  test("navigates to knowledge-base without error (after seeding)", async ({ page }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain(`/workspaces/${workspaceId}/knowledge-base`);
    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
    expect(body).not.toContain("Page Not Found");
  });

  test("renders all four tab triggers", async ({ page }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("tab-cards")).toBeVisible();
    await expect(page.getByTestId("tab-review")).toBeVisible();
    await expect(page.getByTestId("tab-refresh")).toBeVisible();
    await expect(page.getByTestId("tab-compliance")).toBeVisible();
  });

  test("Cards tab: ingested cards appear in the card-list", async ({ page }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);
    test.skip(!ingestOk, "Embedding service unavailable — ingested cards were not created");

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    const cardList = page.getByTestId("card-list");
    await expect(cardList).toBeVisible();
    const cards = page.getByTestId("practice-card-item");
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(1);

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });

  test("Review tab: renders the review-queue container without error", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("tab-review").click();
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("review-queue")).toBeVisible();

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });

  test("Review tab: admin user does NOT see the readonly notice", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("tab-review").click();
    await page.waitForLoadState("networkidle");

    // Admin must NOT see the readonly notice.
    expect(await page.getByTestId("review-readonly-notice").count()).toBe(0);
  });

  test("Review tab: pending count badge appears when a card is in pending_review", async ({
    page,
  }, testInfo) => {
    test.skip(!canFullyVerify, "Two-user seeding unavailable — skipping badge assertion");
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    const badge = page.getByTestId("review-pending-count");
    await expect(badge).toBeVisible();
    const countText = await badge.textContent();
    expect(Number(countText)).toBeGreaterThanOrEqual(1);
  });

  test("Review tab: pending_review card shows Accept and Reject buttons", async ({
    page,
  }, testInfo) => {
    test.skip(!canFullyVerify, "Two-user seeding unavailable — skipping queue-item assertion");
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("tab-review").click();
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("review-queue-item").first()).toBeVisible();
    await expect(page.getByTestId("review-accept").first()).toBeVisible();
    await expect(page.getByTestId("review-reject").first()).toBeVisible();
  });

  test("Review tab: accepting a card removes it from the queue", async ({
    page,
  }, testInfo) => {
    test.skip(!canFullyVerify, "Two-user seeding unavailable — skipping accept journey");
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    // Seed a fresh card specifically for this accept test.
    const verifierToken = await getVerifierToken(url);
    test.skip(!verifierToken, "Cannot get independent verifier token");

    const [acceptCardId] = await ingestCardsViaPage(page, url, workspaceId, [
      {
        ...SEED_CARD,
        statement: "Avoid hardcoding credentials in Terraform provider blocks.",
      },
    ]);
    test.skip(!acceptCardId, "Embedding service unavailable — cannot ingest accept-test card");
    const verified = await verifyCardWithToken(url, workspaceId, acceptCardId!, verifierToken!);
    test.skip(
      verified?.reviewState !== "pending_review",
      "Card did not reach pending_review — skipping accept test",
    );

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("tab-review").click();
    await page.waitForLoadState("networkidle");

    const countBefore = await page.getByTestId("review-queue-item").count();
    expect(countBefore).toBeGreaterThanOrEqual(1);

    // Click Accept → dialog opens.
    await page.getByTestId("review-accept").first().click();
    await expect(page.getByTestId("accept-dialog")).toBeVisible();

    // Confirm without selecting supersede candidates.
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/review") && r.request().method() === "POST",
      ),
      page.getByTestId("accept-confirm").click(),
    ]);

    expect(response.status()).toBe(200);

    await page.waitForLoadState("networkidle");
    const countAfter = await page.getByTestId("review-queue-item").count();
    expect(countAfter).toBeLessThan(countBefore);

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });

  test("Review tab: rejecting a card removes it from the queue", async ({
    page,
  }, testInfo) => {
    test.skip(!canFullyVerify, "Two-user seeding unavailable — skipping reject journey");
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureSeeded(page, url);

    const verifierToken = await getVerifierToken(url);
    test.skip(!verifierToken, "Cannot get independent verifier token");

    const [rejectCardId] = await ingestCardsViaPage(page, url, workspaceId, [
      {
        ...SEED_CARD,
        statement: "Use Terraform workspaces to isolate deployment environments.",
      },
    ]);
    test.skip(!rejectCardId, "Embedding service unavailable — cannot ingest reject-test card");
    const verified = await verifyCardWithToken(url, workspaceId, rejectCardId!, verifierToken!);
    test.skip(
      verified?.reviewState !== "pending_review",
      "Card did not reach pending_review — skipping reject test",
    );

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("tab-review").click();
    await page.waitForLoadState("networkidle");

    const countBefore = await page.getByTestId("review-queue-item").count();
    expect(countBefore).toBeGreaterThanOrEqual(1);

    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/review") && r.request().method() === "POST",
      ),
      page.getByTestId("review-reject").first().click(),
    ]);

    expect(response.status()).toBe(200);

    await page.waitForLoadState("networkidle");
    const countAfter = await page.getByTestId("review-queue-item").count();
    expect(countAfter).toBeLessThan(countBefore);

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });
});

// ─── Journey B: Refresh "Run now" ─────────────────────────────────────────────

test.describe("Journey B — Refresh Run Now", () => {
  test.skip(!HAS_DATABASE, "Requires DATABASE_URL (practice-cards use PgStorage in the full server)");

  let workspaceId = "";
  // Set to false when ingest returns 500/503 (embedding service unavailable).
  // The refresh panel tab-render tests do NOT require seeded cards; they only
  // need a workspace. The "run report" tests DO need a card to exist so the
  // scheduler has something to process.
  let ingestOk = false;
  let seeded = false;

  async function ensureRefreshSeeded(
    page: Parameters<Parameters<typeof test>[1]>[0]["page"],
    baseURL: string,
  ): Promise<void> {
    if (seeded) return;
    workspaceId = await createWorkspaceViaPage(page, baseURL);
    const [cardId] = await ingestCardsViaPage(page, baseURL, workspaceId, [SEED_CARD]);
    ingestOk = !!cardId;
    seeded = true;
  }

  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? BASE_URL_FALLBACK);
  });

  test("Refresh tab renders the Run refresh now button without error", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureRefreshSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("tab-refresh").click();
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("run-refresh")).toBeVisible();

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });

  test("Refresh tab: Run now button is enabled for admin user", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureRefreshSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("tab-refresh").click();
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("run-refresh")).toBeEnabled();
    // Admin must NOT see the readonly notice.
    expect(await page.getByTestId("refresh-readonly-notice").count()).toBe(0);
  });

  test("Refresh tab: clicking Run now returns 202 and the run report appears", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureRefreshSeeded(page, url);
    // Run report requires at least one card to have been ingested.
    test.skip(!ingestOk, "Embedding service unavailable — refresh run report test skipped");

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("tab-refresh").click();
    await page.waitForLoadState("networkidle");

    const [refreshResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/practice-cards/refresh") &&
          !r.url().includes("/refresh-runs") &&
          r.request().method() === "POST",
      ),
      page.getByTestId("run-refresh").click(),
    ]);

    expect(refreshResponse.status()).toBe(202);

    const refreshBody = (await refreshResponse.json()) as {
      data: { refreshRunId: string };
    };
    expect(typeof refreshBody.data.refreshRunId).toBe("string");

    // The component polls until status='completed'. Allow 15 s.
    await page.waitForSelector('[data-testid="refresh-run-report"]', {
      timeout: 15_000,
    });

    await expect(page.getByTestId("refresh-run-report")).toBeVisible();

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });

  test("Refresh tab: run report shows all four diff buckets (new/changed/stale/superseded)", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureRefreshSeeded(page, url);
    test.skip(!ingestOk, "Embedding service unavailable — refresh run report test skipped");

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("tab-refresh").click();
    await page.waitForLoadState("networkidle");

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/practice-cards/refresh") &&
          !r.url().includes("/refresh-runs") &&
          r.request().method() === "POST",
      ),
      page.getByTestId("run-refresh").click(),
    ]);

    await page.waitForSelector('[data-testid="refresh-run-report"]', {
      timeout: 15_000,
    });

    // RefreshPanel renders a bucket per label even when count = 0.
    await expect(page.getByTestId("refresh-bucket-new")).toBeVisible();
    await expect(page.getByTestId("refresh-bucket-changed")).toBeVisible();
    await expect(page.getByTestId("refresh-bucket-stale")).toBeVisible();
    await expect(page.getByTestId("refresh-bucket-superseded")).toBeVisible();

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });

  test("Refresh tab: no-auto-commit note is visible in the panel", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureRefreshSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("tab-refresh").click();
    await page.waitForLoadState("networkidle");

    // The static note renders before any run is triggered.
    const body = await page.locator("body").textContent();
    expect(body).toMatch(/nothing is applied automatically/i);
  });
});

// ─── Journey C: Compliance Panel ─────────────────────────────────────────────

test.describe("Journey C — Compliance Panel", () => {
  test.skip(!HAS_DATABASE, "Requires DATABASE_URL (practice-cards use PgStorage in the full server)");

  let workspaceId = "";
  let seeded = false;

  async function ensureComplianceSeeded(
    page: Parameters<Parameters<typeof test>[1]>[0]["page"],
    baseURL: string,
  ): Promise<void> {
    if (seeded) return;
    workspaceId = await createWorkspaceViaPage(page, baseURL);

    // Attempt to seed an active card for the compliance panel.
    // If ingest returns 500/503 (embedder unavailable) the panel still renders
    // gracefully in the empty-cards state — the tests below only assert on the
    // panel frame, not on specific card data, so they run either way.
    const [cardId] = await ingestCardsViaPage(page, baseURL, workspaceId, [SEED_CARD]);
    if (cardId) {
      const verifierToken = await getVerifierToken(baseURL);
      if (verifierToken) {
        const verified = await verifyCardWithToken(baseURL, workspaceId, cardId, verifierToken);
        if (verified?.reviewState === "pending_review") {
          await acceptCardViaPage(page, baseURL, workspaceId, cardId);
        }
      }
    }

    seeded = true;
  }

  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? BASE_URL_FALLBACK);
  });

  test("Compliance tab renders without error", async ({ page }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureComplianceSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("tab-compliance").click();
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });

  test("Compliance tab: renders gracefully when graph is disabled (30 MB > 25 MiB cap)", async ({
    page,
  }, testInfo) => {
    // infra/graphify-out/graph.json is ~30 MB, exceeding the 25 MiB cap in
    // compliance-mapper.ts. loadComplianceGraph() returns null; the mapper
    // returns { followed:[], violated:[], unknown:[] } for every card.
    // The panel must show compliance-results (possibly empty) OR an EmptyState,
    // but never an error banner.
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureComplianceSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("tab-compliance").click();
    await page.waitForLoadState("networkidle");

    const hasResults = (await page.getByTestId("compliance-results").count()) > 0;
    const hasEmpty = (await page.locator('[data-testid="kb-empty"]').count()) > 0;
    // One of the two states must hold; a 500/crash is not acceptable.
    expect(hasResults || hasEmpty).toBe(true);

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });

  test("Compliance tab: when active cards exist, compliance-row elements are rendered", async ({
    page,
  }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureComplianceSeeded(page, url);

    // Check whether any active card exists in this workspace via API.
    const res = await page.request.get(
      `${url}/api/workspaces/${workspaceId}/knowledge/practice-cards?status=active&limit=1`,
    );
    let hasActiveCard = false;
    if (res.status() === 200) {
      const body = (await res.json()) as { data: unknown[]; meta: { total: number } };
      hasActiveCard = body.data.length > 0;
    }

    test.skip(!hasActiveCard, "No active cards in this workspace — compliance-row assertion skipped");

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("tab-compliance").click();
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("compliance-results")).toBeVisible();
    await expect(page.getByTestId("compliance-row").first()).toBeVisible();

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
  });

  test("Compliance tab: honest disclaimer text is always visible", async ({
    page,
  }, testInfo) => {
    // Security G4 condition: the panel must surface the honesty notice — "coarse
    // substring heuristic", over-report caveat, and "unknown" as the default.
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureComplianceSeeded(page, url);

    await page.goto(`/workspaces/${workspaceId}/knowledge-base`);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("tab-compliance").click();
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").textContent();
    expect(body).toMatch(/coarse substring heuristic/i);
    expect(body).toMatch(/unknown/i);
  });
});

// ─── Adversarial gate smoke test ──────────────────────────────────────────────

test.describe("Adversarial gate — server enforces verifier != ingester", () => {
  test.skip(!HAS_DATABASE, "Requires DATABASE_URL");

  let workspaceId = "";
  let cardId = "";
  let seeded = false;
  // Set false when ingest returns 500/503. The adversarial gate test requires
  // a card id to send the verify request against.
  let ingestOk = false;

  async function ensureAdversarialSeeded(
    page: Parameters<Parameters<typeof test>[1]>[0]["page"],
    baseURL: string,
  ): Promise<void> {
    if (seeded) return;
    workspaceId = await createWorkspaceViaPage(page, baseURL);
    const ids = await ingestCardsViaPage(page, baseURL, workspaceId, [SEED_CARD]);
    if (ids[0]) {
      cardId = ids[0];
      ingestOk = true;
    }
    seeded = true;
  }

  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? BASE_URL_FALLBACK);
  });

  test("POST verify with the SAME user id returns 409", async ({ page }, testInfo) => {
    const url = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await ensureAdversarialSeeded(page, url);
    test.skip(!ingestOk, "Embedding service unavailable — adversarial gate test skipped");

    // Use the same admin token that ingested the card — same user id → gate fires.
    // page.request inherits the auth cookie (same user), so same user id.
    const res = await page.request.post(
      `${url}/api/workspaces/${workspaceId}/knowledge/practice-cards/${cardId}/verify`,
      {
        data: {
          // A different label is provided to prove the server checks the user id,
          // not just the label string.
          verifiedBy: "e2e-different-label-same-userid",
          verdict: "pass",
        },
      },
    );
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/verifier must differ/i);
  });
});
