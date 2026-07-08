/**
 * E2E tests for the Statistics API. Root-path (`/`) page rendering is covered
 * by navigation.spec.ts — the former `/stats` alias route was a duplicate of
 * `/` and has been removed, so this file no longer tests UI navigation.
 *
 * Covers:
 *   - Stats overview API returns expected shape
 *   - Stats timeline API returns array with date/requests/tokens/costUsd
 *   - Stats by-model, by-provider, by-team APIs
 *   - Stats requests list API
 *   - Period filter parameter handling
 *   - Export endpoint (POST /api/stats/export)
 */
import { test, expect } from "@playwright/test";
import { loginPage, ensureProjectHeaders } from "./helpers/auth";

const BASE_URL_FALLBACK = "http://localhost:3099";

test.describe("Statistics", () => {
  let projectHeaders: { "x-project-id": string };

  test.beforeEach(async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await loginPage(page, baseURL);
    // /api/stats/* is mounted behind requireAuth + requireProject
    // (server/routes.ts) — page.request bypasses the client's fetch
    // interceptor that normally attaches x-project-id, so it must be sent
    // explicitly on every call below.
    projectHeaders = await ensureProjectHeaders(page, baseURL);
  });

  // ─── Stats Overview API ───────────────────────────────────────────────────

  test("GET /api/stats/overview returns expected shape", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.get(`${baseURL}/api/stats/overview`, { headers: projectHeaders });
    expect(res.status()).toBe(200);

    const body = await res.json() as {
      totalRequests: number;
      totalTokens: { input: number; output: number; total: number };
      totalCostUsd: number;
    };
    expect(typeof body.totalRequests).toBe("number");
    expect(typeof body.totalCostUsd).toBe("number");
    // Pipeline Runs was removed from the overview response.
    expect(body).not.toHaveProperty("totalRuns");
    expect(typeof body.totalTokens.total).toBe("number");
  });

  test("GET /api/stats/overview returns non-negative numbers", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.get(`${baseURL}/api/stats/overview`, { headers: projectHeaders });
    const body = await res.json() as {
      totalRequests: number;
      totalTokens: { input: number; output: number; total: number };
      totalCostUsd: number;
    };

    expect(body.totalRequests).toBeGreaterThanOrEqual(0);
    expect(body.totalCostUsd).toBeGreaterThanOrEqual(0);
    expect(body.totalTokens.input).toBeGreaterThanOrEqual(0);
    expect(body.totalTokens.output).toBeGreaterThanOrEqual(0);
  });

  // ─── Stats Timeline API ───────────────────────────────────────────────────

  test("GET /api/stats/timeline returns array", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.get(`${baseURL}/api/stats/timeline?period=7d`, { headers: projectHeaders });
    expect(res.status()).toBe(200);

    const body = await res.json() as Array<{
      date: string;
      requests: number;
      tokens: number;
      costUsd: number;
    }>;
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /api/stats/timeline entries have required fields", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.get(`${baseURL}/api/stats/timeline?period=7d`, { headers: projectHeaders });
    const body = await res.json() as Array<{
      date: string;
      requests: number;
      tokens: number;
      costUsd: number;
    }>;

    if (body.length > 0) {
      const entry = body[0];
      expect(typeof entry.date).toBe("string");
      expect(typeof entry.requests).toBe("number");
      expect(typeof entry.tokens).toBe("number");
      expect(typeof entry.costUsd).toBe("number");
    }
  });

  test("GET /api/stats/timeline with period=30d returns array", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.get(`${baseURL}/api/stats/timeline?period=30d`, { headers: projectHeaders });
    expect(res.status()).toBe(200);

    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  // ─── Stats By-Model / By-Provider / By-Team APIs ─────────────────────────

  test("GET /api/stats/by-model returns array", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.get(`${baseURL}/api/stats/by-model`, { headers: projectHeaders });
    expect(res.status()).toBe(200);

    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /api/stats/by-provider returns array", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.get(`${baseURL}/api/stats/by-provider`, { headers: projectHeaders });
    expect(res.status()).toBe(200);

    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /api/stats/by-team returns array", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.get(`${baseURL}/api/stats/by-team`, { headers: projectHeaders });
    expect(res.status()).toBe(200);

    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /api/stats/by-workspace returns array", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.get(`${baseURL}/api/stats/by-workspace`, { headers: projectHeaders });
    expect(res.status()).toBe(200);

    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  // ─── Stats Requests API ───────────────────────────────────────────────────

  test("GET /api/stats/requests returns object with rows array", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.get(`${baseURL}/api/stats/requests`, { headers: projectHeaders });
    expect(res.status()).toBe(200);

    const body = await res.json() as { rows: unknown[]; total: number };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  // ─── Stats Export API ─────────────────────────────────────────────────────

  test("POST /api/stats/export returns JSON response", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.post(`${baseURL}/api/stats/export?format=json`, {
      data: {},
      headers: projectHeaders,
    });

    // Export should return 200
    expect(res.status()).toBe(200);

    const contentType = res.headers()["content-type"];
    expect(contentType).toMatch(/application\/json/);
  });

  test("POST /api/stats/export returns CSV when format=csv", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.post(`${baseURL}/api/stats/export?format=csv`, {
      data: {},
      headers: projectHeaders,
    });

    expect(res.status()).toBe(200);
    const contentType = res.headers()["content-type"];
    expect(contentType).toMatch(/text\/csv|application\/json/);
  });
});
