/**
 * consilium-loop-detail.spec.ts — E2E coverage that a consilium loop's recorded
 * rounds render on the loop detail page (design §7): the convergence badge,
 * the still-open action points with their priority badges, and the "no open
 * action points" empty state.
 *
 * DB dependency: consilium loops/rounds use PgStorage in the full server (same
 * reasoning as knowledge.spec.ts) — SKIPPED when DATABASE_URL is absent.
 *
 * Seeding: a real Judge run needs a live model gateway, which is non-deterministic
 * and slow for E2E. Task group + consilium-loop CREATION goes through the real
 * HTTP API (`page.request`, matching the convention in run-execution.spec.ts /
 * pipeline-crud.spec.ts); fast-forwarding the loop's FSM state and inserting the
 * two round rows goes through a direct `pg` connection, mirroring the seeding
 * precedent in tests/e2e/global-setup.ts (idempotent, scoped to rows this test
 * itself creates — never a broad UPDATE/DELETE).
 *
 * Project scoping: `/api/task-groups` and `/api/consilium-loops` require
 * `x-project-id` (server/middleware/project.ts) — `page.request` bypasses the
 * client's fetch interceptor (client/src/lib/projectHeaders.ts) that normally
 * attaches it, so this file creates its own project via `POST /api/projects`
 * (project-agnostic, requireAuth only) and (a) passes `x-project-id` explicitly
 * on every `page.request` call, and (b) writes `localStorage.project_id` so the
 * loop detail page's OWN fetches (triggered by `page.goto`) resolve it too.
 *
 * Frontend note: `RoundVerdictPanel` (the grouped-by-priority full verdict list,
 * `loop-verdict-ap-list`) is gated on `consilium_loop_rounds.verdict` (migration
 * 0051, Phase 1 items 1-3). Round 1 below seeds that column directly (bypassing
 * `readJudgeVerdict` — the raw-judge-output → `RoundVerdict` transform is unit-
 * tested in tests/unit/orchestrator/convergence.test.ts) to exercise the panel's
 * positive path; round 2 deliberately omits it to prove the panel is omitted
 * (never a crash / hollow shell) when a round has no rich verdict — e.g. a
 * pre-Phase-1 backfilled row. The still-open flat list (`loop-open-ap-list` →
 * `loop-ap-item`) is the OTHER, always-populated surface (what defect A fixed)
 * and is asserted independently of whether `verdict` is present.
 *
 * Playwright discovers this file via testDir: "./tests/e2e" in
 * playwright.config.ts. No other file imports this module.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { loginPage } from "./helpers/auth";

const HAS_DATABASE = !!process.env.DATABASE_URL;

test.describe("Consilium loop detail — recorded rounds surface", () => {
  test.skip(!HAS_DATABASE, "Requires DATABASE_URL (consilium loops use PgStorage in the full server)");

  test.beforeEach(async ({ page }, testInfo) => {
    await loginPage(page, testInfo.project.use.baseURL ?? "http://localhost:3099");
  });

  test("two recorded rounds render: convergence badges, priority-badged action points, and the empty-round message", async ({ page }) => {
    // ── Project (required for x-project-id on the task-group/loop routes) ────
    const projectRes = await page.request.post("/api/projects", {
      data: { name: `E2E Consilium Loop ${Date.now()}`, description: "e2e seed project" },
    });
    expect(projectRes.status()).toBe(201);
    const project = (await projectRes.json()) as { id: string };
    await page.evaluate((pid) => localStorage.setItem("project_id", pid), project.id);

    const projectHeaders = { "x-project-id": project.id };

    // ── Task group (the loop's groupId FK; never started — the round data is
    //    seeded directly, so no real debate/model call runs). ──────────────────
    const groupRes = await page.request.post("/api/task-groups", {
      headers: projectHeaders,
      data: {
        name: "[consilium-review:sdlc-cross-review] e2e-seed",
        description: "e2e seed group",
        input: "objective",
        tasks: [{ name: "Reviewer", description: "seed task", executionMode: "direct_llm", modelSlug: "mock" }],
      },
    });
    expect(groupRes.status()).toBe(201);
    const group = (await groupRes.json()) as { id: string };

    // ── Consilium loop (created via the real route; repoPath must be inside
    //    consiliumLoop.allowedRepoPaths — config.yaml allowlists the whole
    //    `.../project` parent, which covers process.cwd() here). ────────────────
    const loopRes = await page.request.post("/api/consilium-loops", {
      headers: projectHeaders,
      data: { groupId: group.id, repoPath: process.cwd() },
    });
    expect(loopRes.status()).toBe(201);
    const loop = (await loopRes.json()) as { id: string };

    // ── Fast-forward the FSM state + seed two rounds directly (no HTTP surface
    //    exists to insert a round or jump FSM state — see file header). ───────
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await pool.query(
        `UPDATE consilium_loops SET state = 'converged', round = 2, current_iteration_number = 2, completed_at = now() WHERE id = $1`,
        [loop.id],
      );
      // Round 1 — not yet converged, 2 P0 + 1 P1 still open, PLUS a full rich
      // verdict (prose + pros/cons + the FULL ranked action-point list, all
      // priorities) to exercise RoundVerdictPanel's positive path.
      await pool.query(
        `INSERT INTO consilium_loop_rounds (loop_id, round, iteration_number, converged, open_p0, open_action_points, verdict, baseline_commit, head_commit)
         VALUES ($1, 1, 1, false, 2, $2::jsonb, $3::jsonb, 'aaaaaaa', 'bbbbbbb')`,
        [
          loop.id,
          JSON.stringify([
            { title: "Fix null check", priority: "P0" },
            { title: "Add missing test", priority: "P0" },
            { title: "Rename confusing var", priority: "P1" },
          ]),
          JSON.stringify({
            verdict: "Solid overall, one blocking issue.",
            pros: ["Good test coverage", "Clear naming"],
            cons: ["Missing null check"],
            actionPoints: [
              { title: "Fix null check", priority: "P0" },
              { title: "Add missing test", priority: "P0" },
              { title: "Rename confusing var", priority: "P1" },
              { title: "Add a doc note", priority: "P2" },
            ],
          }),
        ],
      );
      // Round 2 — converged clean, nothing left open.
      await pool.query(
        `INSERT INTO consilium_loop_rounds (loop_id, round, iteration_number, converged, open_p0, open_action_points, baseline_commit, head_commit)
         VALUES ($1, 2, 2, true, 0, '[]'::jsonb, 'bbbbbbb', 'ccccccc')`,
        [loop.id],
      );
    } finally {
      await pool.end();
    }

    // ── Navigate + assert ──────────────────────────────────────────────────────
    await page.goto(`/consilium-loops/${loop.id}`);
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");

    const rows = page.getByTestId("loop-round-row");
    await expect(rows).toHaveCount(2);

    // Round 2 (latest, rendered last — rounds are sorted ascending) converged
    // clean → green check; the loop is terminal (converged) so round 1's mark
    // (not converged) renders red, not amber.
    await expect(rows.nth(1).getByTestId("loop-convergence-mark")).toHaveClass(/text-green-600/);
    await expect(rows.nth(0).getByTestId("loop-convergence-mark")).toHaveClass(/text-red-500/);

    // The Result panel shows the LATEST round (2) — 0 open action points.
    await expect(page.getByText("No open action points recorded for this round.")).toBeVisible();

    // Round 1's still-open action points are behind its expandable row.
    await rows.nth(0).click();
    const openApList = page.getByTestId("loop-open-ap-list");
    // data-priority lives on the loop-ap-item element itself — filter on the attribute directly.
    await expect(openApList.getByTestId("loop-ap-item")).toHaveCount(3);
    await expect(openApList.locator('[data-testid="loop-ap-item"][data-priority="P0"]')).toHaveCount(2);
    await expect(openApList.locator('[data-testid="loop-ap-item"][data-priority="P1"]')).toHaveCount(1);
    await expect(openApList.getByText("Fix null check")).toBeVisible();
    await expect(openApList.getByText("Rename confusing var")).toBeVisible();

    // RoundVerdictPanel — round 1 carries a rich verdict, so it renders: prose,
    // pros/cons, and the FULL ranked action-point list GROUPED by priority
    // (distinct from loop-open-ap-list above, which is the flat still-open subset).
    const verdictPanel = page.getByTestId("loop-verdict-panel");
    await expect(verdictPanel).toHaveCount(1);
    await expect(verdictPanel.getByText("Solid overall, one blocking issue.")).toBeVisible();
    await expect(verdictPanel.getByText("Good test coverage")).toBeVisible();
    await expect(verdictPanel.getByText("Missing null check")).toBeVisible();
    const verdictApList = verdictPanel.getByTestId("loop-verdict-ap-list");
    // 4 action points across P0(2)/P1(1)/P2(1) — the FULL list, not just the 3
    // still-open ones in loop-open-ap-list above.
    await expect(verdictApList.getByTestId("loop-ap-item")).toHaveCount(4);
    await expect(verdictApList.locator('[data-testid="loop-ap-item"][data-priority="P0"]')).toHaveCount(2);
    await expect(verdictApList.locator('[data-testid="loop-ap-item"][data-priority="P1"]')).toHaveCount(1);
    await expect(verdictApList.locator('[data-testid="loop-ap-item"][data-priority="P2"]')).toHaveCount(1);
    await expect(verdictApList.getByText("Add a doc note")).toBeVisible();

    // Round 2 has NO verdict (omitted from its seed) — expanding it must NOT add a
    // second panel: the omission is silent (no crash, no hollow shell), not merely
    // "we didn't check". Still only the ONE panel from round 1 above.
    await rows.nth(1).click();
    await expect(page.getByTestId("loop-verdict-panel")).toHaveCount(1);
  });

  test("a loop whose round failed to persist surfaces loop.error instead of rendering blank", async ({ page }) => {
    // Regression-adjacent: seeds the FRONTEND side of defect C directly (no
    // rounds recorded, `error` set) to prove the existing plumbing
    // (ResultPanel / LoopStatusCallout) renders it — the backend fix (recordRound
    // no longer swallowing non-unique failures) is covered at the unit/integration
    // level in tests/unit/consilium/loop-round-persist-failure.test.ts.
    const projectRes = await page.request.post("/api/projects", {
      data: { name: `E2E Consilium Loop Error ${Date.now()}`, description: "e2e seed project" },
    });
    const project = (await projectRes.json()) as { id: string };
    await page.evaluate((pid) => localStorage.setItem("project_id", pid), project.id);
    const projectHeaders = { "x-project-id": project.id };

    const groupRes = await page.request.post("/api/task-groups", {
      headers: projectHeaders,
      data: {
        name: "[consilium-review:sdlc-cross-review] e2e-seed-error",
        description: "e2e seed group",
        input: "objective",
        tasks: [{ name: "Reviewer", description: "seed task", executionMode: "direct_llm", modelSlug: "mock" }],
      },
    });
    const group = (await groupRes.json()) as { id: string };
    const loopRes = await page.request.post("/api/consilium-loops", {
      headers: projectHeaders,
      data: { groupId: group.id, repoPath: process.cwd() },
    });
    const loop = (await loopRes.json()) as { id: string };

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await pool.query(
        `UPDATE consilium_loops SET state = 'converged', round = 1, current_iteration_number = 1, completed_at = now(),
                error = 'round 1 audit write failed: connection terminated unexpectedly'
         WHERE id = $1`,
        [loop.id],
      );
      // Deliberately NO consilium_loop_rounds row — this is exactly the pre-fix
      // symptom (round persist failed, nothing recorded).
    } finally {
      await pool.end();
    }

    await page.goto(`/consilium-loops/${loop.id}`);
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").textContent();
    expect(body).not.toContain("Something went wrong");
    await expect(page.getByText("No rounds recorded yet.")).toBeVisible();
    await expect(page.getByText(/round 1 audit write failed/i)).toBeVisible();
  });
});
