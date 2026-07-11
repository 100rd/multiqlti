/**
 * consilium-loops-rerun-route.test.ts — POST /api/consilium-loops/:id/rerun.
 *
 * A `failed` (or any other TERMINAL) loop is a dead end today: `/develop` only
 * re-opens the verdict terminals (converged/stopped_cap/escalated) and `/retry`
 * only resumes `throttled` (non-terminal). Rerun clones the SOURCE loop's config
 * — repoPath / preset (recovered from its group name) / maxRounds / commitPrefix
 * — through the SAME `createConsiliumReview` factory the normal create paths use,
 * and returns the NEW loop id.
 *
 * The factory is mocked (same resolved module the route imports), mirroring
 * consilium-reviews-route.test.ts — we assert the route's refusal/recovery/wiring
 * logic, not the factory internals (covered in review-factory.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../../server/services/consilium/review-factory.js", () => ({
  createConsiliumReview: vi.fn(),
}));

import type { AppConfig } from "../../../server/config/schema.js";
import type { IStorage } from "../../../server/storage.js";
import type { ConsiliumLoopController } from "../../../server/services/consilium/consilium-loop-controller.js";
import { registerConsiliumLoopRoutes } from "../../../server/routes/consilium-loops.js";
import { createConsiliumReview } from "../../../server/services/consilium/review-factory.js";

const mockedCreate = vi.mocked(createConsiliumReview);

const LOOP_ID = "loop-1";
const OWNER = "user-1";
const PROJECT_ID = "project-1";

const FAILED_LOOP = {
  id: LOOP_ID,
  groupId: "grp-1",
  state: "failed",
  round: 2,
  maxRounds: 4,
  createdBy: OWNER,
  repoPath: "/repos/widget",
  commitPrefix: "JIRA-42",
  error: "review run failed",
};

const config = () => ({ pipeline: { consiliumLoop: {} } }) as unknown as AppConfig;

function makeApp(opts: {
  loop?: Record<string, unknown>;
  group?: { name: string } | undefined;
  user?: { id: string; role?: string } | undefined;
  projectId?: string | undefined;
} = {}) {
  const {
    loop = { ...FAILED_LOOP },
    group = { name: "[consilium-review:sdlc-cross-review] widget" },
  } = opts;
  const user = "user" in opts ? opts.user : { id: OWNER };
  // Same pitfall as `user` above: an explicit `projectId: undefined` must NOT
  // be swallowed back to the default by destructuring — distinguish "key
  // absent" (use the default) from "explicitly unset" (simulate a missing
  // x-project-id header).
  const projectId = "projectId" in opts ? opts.projectId : PROJECT_ID;

  const storage = {
    getLoop: vi.fn(async () => loop),
    getTaskGroup: vi.fn(async () => group),
  } as unknown as IStorage;

  const controller = {} as unknown as ConsiliumLoopController;
  const orchestrator = {} as never;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) (req as unknown as { user: typeof user }).user = user;
    if (projectId !== undefined) (req as unknown as { projectId: string }).projectId = projectId;
    next();
  });
  registerConsiliumLoopRoutes(app, storage, controller, config, orchestrator);
  return { app, storage };
}

describe("POST /api/consilium-loops/:id/rerun", () => {
  beforeEach(() => mockedCreate.mockReset());

  it("refuses a NON-terminal loop with 409, createConsiliumReview NOT called", async () => {
    const { app } = makeApp({ loop: { ...FAILED_LOOP, state: "developing" } });
    const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/rerun`).send();
    expect(res.status).toBe(409);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("clones a TERMINAL (failed) loop's config through createConsiliumReview → 201 { id }", async () => {
    mockedCreate.mockResolvedValueOnce({ id: "loop-new" } as never);
    const { app } = makeApp();
    const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/rerun`).send();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "loop-new" });
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedCreate.mock.calls[0][1]).toMatchObject({
      projectId: PROJECT_ID,
      repoPath: "/repos/widget",
      preset: "sdlc-cross-review",
      createdBy: OWNER,
      maxRounds: 4,
      commitPrefix: "JIRA-42",
    });
  });

  it("accepts every OTHER terminal state too (converged / stopped_cap / escalated / cancelled)", async () => {
    for (const state of ["converged", "stopped_cap", "escalated", "cancelled"]) {
      mockedCreate.mockReset();
      mockedCreate.mockResolvedValueOnce({ id: `loop-${state}` } as never);
      const { app } = makeApp({ loop: { ...FAILED_LOOP, state } });
      const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/rerun`).send();
      expect(res.status, `state=${state}`).toBe(201);
      expect(mockedCreate).toHaveBeenCalledTimes(1);
    }
  });

  it("a legacy/unparseable group name falls back to the safe default preset", async () => {
    mockedCreate.mockResolvedValueOnce({ id: "loop-new" } as never);
    const { app } = makeApp({ group: { name: "some legacy group name" } });
    const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/rerun`).send();
    expect(res.status).toBe(201);
    expect(mockedCreate.mock.calls[0][1]).toMatchObject({ preset: "sdlc-cross-review" });
  });

  it("recovers a NON-default preset from the group name (e.g. diff-pr-review)", async () => {
    mockedCreate.mockResolvedValueOnce({ id: "loop-new" } as never);
    const { app } = makeApp({ group: { name: "[consilium-review:diff-pr-review] widget" } });
    const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/rerun`).send();
    expect(res.status).toBe(201);
    expect(mockedCreate.mock.calls[0][1]).toMatchObject({ preset: "diff-pr-review" });
  });

  it("a foreign loop → 404 (owner-or-admin, no existence oracle), createConsiliumReview NOT called", async () => {
    const { app } = makeApp({ user: { id: "intruder" } });
    const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/rerun`).send();
    expect(res.status).toBe(404);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated", async () => {
    const { app } = makeApp({ user: undefined });
    const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/rerun`).send();
    expect(res.status).toBe(401);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("400 when x-project-id is missing", async () => {
    const { app } = makeApp({ projectId: undefined });
    const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/rerun`).send();
    expect(res.status).toBe(400);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("maps a repoPath-no-longer-allowlisted factory error to an actionable 400", async () => {
    mockedCreate.mockRejectedValueOnce(
      new Error(`[repo-allowlist] Path "/repos/widget" is outside every allowed repo root`),
    );
    const { app } = makeApp();
    const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/rerun`).send();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no longer in the allowed repo paths/i);
  });

  it("maps a repoPath-no-longer-a-workspace factory error to an actionable 400", async () => {
    mockedCreate.mockRejectedValueOnce(
      new Error(`[project-workspace] repoPath "/repos/widget" is not a workspace of this project`),
    );
    const { app } = makeApp();
    const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/rerun`).send();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no longer a registered workspace/i);
  });

  it("an unexpected factory error → 500", async () => {
    mockedCreate.mockRejectedValueOnce(new Error("boom"));
    const { app } = makeApp();
    const res = await request(app).post(`/api/consilium-loops/${LOOP_ID}/rerun`).send();
    expect(res.status).toBe(500);
  });
});
