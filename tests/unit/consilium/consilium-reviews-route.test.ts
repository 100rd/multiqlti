/**
 * consilium-reviews-route.test.ts — the POST /api/consilium-reviews error
 * mapping (MED-3). The route applies TWO confinement boundaries via the factory:
 *   (a) the GLOBAL allowlist (S1) — repo not in consiliumLoop.allowedRepoPaths;
 *   (b) the PER-PROJECT workspace check (S5/MED-3) — repo allowlisted but not a
 *       registered workspace of the selected project.
 * Each must surface a DISTINCT, actionable 400 so the user knows WHICH boundary
 * they hit and how to fix it.
 *
 * The factory is mocked: we only assert the route's error-substring mapping, not
 * the factory internals (covered in review-factory.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock the factory the route delegates to. Same resolved module the route imports
// (`../services/consilium/review-factory.js`), so the mock applies there too.
vi.mock("../../../server/services/consilium/review-factory.js", () => ({
  createConsiliumReview: vi.fn(),
}));

import { registerConsiliumReviewRoutes } from "../../../server/routes/consilium-reviews.js";
import { createConsiliumReview } from "../../../server/services/consilium/review-factory.js";

const mockedCreate = vi.mocked(createConsiliumReview);

function makeApp() {
  const app = express();
  app.use(express.json());
  // Stand in for requireAuth + requireProject (applied at mount in routes.ts).
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: "user-1" };
    (req as unknown as { projectId: string }).projectId = "project-1";
    next();
  });
  // deps are unused — the factory is fully mocked.
  registerConsiliumReviewRoutes(app, {} as never);
  return app;
}

const VALID_BODY = { repoPath: "/repos/widget", preset: "sdlc-cross-review" as const };

describe("POST /api/consilium-reviews — distinct 400s for the two confinement boundaries (MED-3)", () => {
  beforeEach(() => mockedCreate.mockReset());

  it("(a) NOT in the global allowlist → the allowlist message", async () => {
    mockedCreate.mockRejectedValueOnce(
      new Error(`[repo-allowlist] Path "/repos/widget" is outside every allowed repo root`),
    );
    const res = await request(makeApp()).post("/api/consilium-reviews").send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/is not in the allowed repo paths/i);
    expect(res.body.error).toMatch(/allowedRepoPaths in config\.yaml/i);
    // Must NOT use the workspace message.
    expect(res.body.error).not.toMatch(/registered as a workspace/i);
  });

  it("(b) allowlisted but NOT a project workspace → the workspace message", async () => {
    mockedCreate.mockRejectedValueOnce(
      new Error(`[project-workspace] repoPath "/repos/widget" is not a workspace of this project`),
    );
    const res = await request(makeApp()).post("/api/consilium-reviews").send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/is not registered as a workspace of the selected project/i);
    expect(res.body.error).toMatch(/pick one of its workspaces or add it as a workspace/i);
    // Must NOT fall through to the allowlist message.
    expect(res.body.error).not.toMatch(/allowedRepoPaths in config\.yaml/i);
  });

  it("the two messages are DISTINCT (not the same fallthrough)", async () => {
    mockedCreate.mockRejectedValueOnce(
      new Error(`[repo-allowlist] Path "/repos/widget" is outside every allowed repo root`),
    );
    const allowlistRes = await request(makeApp()).post("/api/consilium-reviews").send(VALID_BODY);

    mockedCreate.mockRejectedValueOnce(
      new Error(`[project-workspace] repoPath "/repos/widget" is not a workspace of this project`),
    );
    const workspaceRes = await request(makeApp()).post("/api/consilium-reviews").send(VALID_BODY);

    expect(allowlistRes.body.error).not.toBe(workspaceRes.body.error);
  });

  it("a successful create returns 201 with the loop row", async () => {
    mockedCreate.mockResolvedValueOnce({ id: "loop-1", status: "PENDING" } as never);
    const res = await request(makeApp()).post("/api/consilium-reviews").send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("loop-1");
  });
});


describe("POST /api/consilium-reviews — BRANCH-targeted ref wiring", () => {
  beforeEach(() => mockedCreate.mockReset());

  it("passes a VALID ref through to the factory and returns 201", async () => {
    mockedCreate.mockResolvedValueOnce({ id: "loop-ref", status: "PENDING" } as never);
    const res = await request(makeApp())
      .post("/api/consilium-reviews")
      .send({ ...VALID_BODY, ref: "feature/x" });
    expect(res.status).toBe(201);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedCreate.mock.calls[0][1]).toMatchObject({ ref: "feature/x" });
  });

  it("REJECTS a bad ref with 400 BEFORE the factory is ever called (zod gate)", async () => {
    for (const bad of ["-x", "a..b", "x@{1}", "main; rm -rf /", "a".repeat(256), ""]) {
      mockedCreate.mockClear();
      const res = await request(makeApp())
        .post("/api/consilium-reviews")
        .send({ ...VALID_BODY, ref: bad });
      expect(res.status).toBe(400);
      expect(mockedCreate).not.toHaveBeenCalled();
    }
  });

  it("absent ref is back-compat (factory called with ref === undefined)", async () => {
    mockedCreate.mockResolvedValueOnce({ id: "loop-1", status: "PENDING" } as never);
    const res = await request(makeApp()).post("/api/consilium-reviews").send(VALID_BODY);
    expect(res.status).toBe(201);
    expect((mockedCreate.mock.calls[0][1] as { ref?: string }).ref).toBeUndefined();
  });
});
