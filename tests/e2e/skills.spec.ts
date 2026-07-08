/**
 * E2E tests for Skills management page and API.
 *
 * Covers:
 *   - /skills page renders without errors
 *   - Skills API returns an array (built-in seeding was retired in 297d62d;
 *     no isBuiltin:true fixture exists anymore — see the array-contract test)
 *   - Skills page shows skill cards
 *   - Skill filtering (all / builtin / custom)
 *   - Custom skill CRUD via API
 *   - Export endpoint returns JSON
 */
import { test, expect } from "@playwright/test";
import { loginPage, ensureProjectHeaders } from "./helpers/auth";

const BASE_URL_FALLBACK = "http://localhost:3099";

test.describe("Skills Management", () => {
  let projectHeaders: { "x-project-id": string };

  test.beforeEach(async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    await loginPage(page, baseURL);
    // /api/skills is mounted behind requireAuth + requireProject (server/routes.ts).
    projectHeaders = await ensureProjectHeaders(page, baseURL);
  });

  // ─── Page rendering ───────────────────────────────────────────────────────

  test("navigates to /skills without error", async ({ page }) => {
    await page.goto("/skills");
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain("/skills");
    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
    expect(body).not.toContain("Page Not Found");
  });

  test("skills page renders skill-related heading or content", async ({ page }) => {
    await page.goto("/skills");
    await page.waitForLoadState("networkidle");

    const body = (await page.locator("body").textContent()) ?? "";
    const hasSkillContent =
      body.toLowerCase().includes("skill") ||
      body.toLowerCase().includes("prompt") ||
      body.toLowerCase().includes("tool");
    expect(hasSkillContent).toBe(true);
  });

  test("skills page does not show 404", async ({ page }) => {
    await page.goto("/skills");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("404");
    expect(body).not.toContain("Page Not Found");
  });

  // ─── Skills API ───────────────────────────────────────────────────────────

  // Built-in skill seeding (BUILTIN_SKILLS / server/skills/builtin.ts) was
  // intentionally retired in "chore: prune skills ecosystem, keep the catalog
  // narrowing hook (Phase 3b)" (297d62d) — migration 0038 deleted the
  // builtin-* seed rows and nothing seeds isBuiltin:true rows anymore.
  // `isBuiltin` on a skill row is still a live, meaningful field (it gates
  // edit/delete/version/rollback for read-only skills — see
  // server/routes/skills.ts and the git-registry-sync collision guard), but a
  // fresh project legitimately has zero skills until one is created via
  // POST /api/skills (always isBuiltin:false) or a registry sync
  // (sourceType:'git', also isBuiltin:false). There is no built-in-skill
  // fixture to assert against, so this test now proves the array contract
  // (200 + array, includes what we create) instead of a nonexistent seed.
  test("GET /api/skills returns an array containing created skills", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;

    const createRes = await page.request.post(`${baseURL}/api/skills`, {
      headers: projectHeaders,
      data: {
        name: "E2E Array Contract Skill",
        description: "Proves GET /api/skills returns an array containing created rows",
        teamId: "planning",
        systemPromptOverride: "You are a test assistant.",
        tools: [],
        tags: ["e2e"],
        sharing: "private",
      },
    });
    expect(createRes.status()).toBe(201);
    const created = await createRes.json() as { id: string };

    const res = await page.request.get(`${baseURL}/api/skills`, { headers: projectHeaders });
    expect(res.status()).toBe(200);

    const skills = await res.json() as Array<{ id: string; name: string; isBuiltin: boolean }>;
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBeGreaterThanOrEqual(1);
    expect(skills.some((s) => s.id === created.id)).toBe(true);
  });

  test("GET /api/skills returns skills with required fields", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;
    const res = await page.request.get(`${baseURL}/api/skills`, { headers: projectHeaders });
    const skills = await res.json() as Array<{ id: string; name: string; description: string; teamId: string }>;

    for (const skill of skills.slice(0, 3)) {
      expect(typeof skill.id).toBe("string");
      expect(typeof skill.name).toBe("string");
      expect(typeof skill.description).toBe("string");
      expect(typeof skill.teamId).toBe("string");
    }
  });

  test("POST /api/skills creates a custom skill", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;

    const res = await page.request.post(`${baseURL}/api/skills`, {
      headers: projectHeaders,
      data: {
        name: "E2E Test Skill",
        description: "Created by E2E test",
        teamId: "planning",
        systemPromptOverride: "You are a test assistant.",
        tools: [],
        tags: ["e2e", "test"],
        isPublic: false,
        sharing: "private",
      },
    });
    expect(res.status()).toBe(201);

    const skill = await res.json() as { id: string; name: string; isBuiltin: boolean };
    expect(skill.id).toBeTruthy();
    expect(skill.name).toBe("E2E Test Skill");
    expect(skill.isBuiltin).toBe(false);
  });

  test("GET /api/skills/:id returns a skill by ID", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;

    // Create a skill first
    const createRes = await page.request.post(`${baseURL}/api/skills`, {
      headers: projectHeaders,
      data: {
        name: "E2E Get Skill",
        description: "Test",
        teamId: "architecture",
        systemPromptOverride: "Test prompt.",
        tools: [],
        tags: [],
        sharing: "private",
      },
    });
    const skill = await createRes.json() as { id: string };

    const getRes = await page.request.get(`${baseURL}/api/skills/${skill.id}`, { headers: projectHeaders });
    expect(getRes.status()).toBe(200);

    const fetched = await getRes.json() as { id: string; name: string };
    expect(fetched.id).toBe(skill.id);
    expect(fetched.name).toBe("E2E Get Skill");
  });

  test("DELETE /api/skills/:id deletes a custom skill", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;

    // Create then delete
    const createRes = await page.request.post(`${baseURL}/api/skills`, {
      headers: projectHeaders,
      data: {
        name: "E2E Delete Skill",
        description: "To be deleted",
        teamId: "development",
        systemPromptOverride: "Delete me.",
        tools: [],
        tags: [],
        sharing: "private",
      },
    });
    const skill = await createRes.json() as { id: string };

    const deleteRes = await page.request.delete(`${baseURL}/api/skills/${skill.id}`, { headers: projectHeaders });
    expect(deleteRes.status()).toBe(204);

    // Verify it's gone
    const getRes = await page.request.get(`${baseURL}/api/skills/${skill.id}`, { headers: projectHeaders });
    expect(getRes.status()).toBe(404);
  });

  test("DELETE /api/skills/:id on built-in skill → 403", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;

    // Get a builtin skill id
    const listRes = await page.request.get(`${baseURL}/api/skills`, { headers: projectHeaders });
    const skills = await listRes.json() as Array<{ id: string; isBuiltin: boolean }>;
    const builtin = skills.find((s) => s.isBuiltin);

    if (!builtin) {
      test.skip(true, "No builtin skills found");
      return;
    }

    const deleteRes = await page.request.delete(`${baseURL}/api/skills/${builtin.id}`, { headers: projectHeaders });
    expect(deleteRes.status()).toBe(403);
  });

  test("POST /api/skills missing required fields → 400", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;

    const res = await page.request.post(`${baseURL}/api/skills`, {
      headers: projectHeaders,
      data: { description: "Missing name" },
    });
    expect(res.status()).toBe(400);
  });

  test("GET /api/skills/export returns a downloadable JSON response", async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? BASE_URL_FALLBACK;

    const res = await page.request.get(`${baseURL}/api/skills/export`, { headers: projectHeaders });
    expect(res.status()).toBe(200);

    const contentType = res.headers()["content-type"];
    expect(contentType).toMatch(/application\/json/);

    const body = await res.json() as { skills: unknown[] };
    expect(Array.isArray(body.skills)).toBe(true);
  });
});
