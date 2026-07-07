/**
 * loop-review-result-surface.test.ts — integration coverage that a completed
 * consilium review surfaces on `GET /api/consilium-loops/:id` (design §7) via
 * the REAL `MemStorage` + `ConsiliumLoopController` + HTTP router, mirroring
 * the harness in `tests/integration/consilium/loop-routes.test.ts`.
 *
 * Scope note (per team-lead direction): this file asserts the OBSERVABLE
 * contract — the round persists and GET returns it self-sufficiently, with no
 * task-group-shaped field on the round row — rather than pinning to how the
 * review round is dispatched internally. Full removal of the task-group
 * EXECUTION mechanism (`taskOrchestrator.startGroupAsync`) is a separate,
 * larger refactor pending the Architect's blueprint; the "no task_group
 * created for this round" spy assertion is deliberately deferred until that
 * lands, per the team-lead's explicit scope split (defects C+A ship first).
 *
 * These tests drive the FSM past `building_context`/`reviewing` by seeding
 * state directly via `storage.updateLoop` (same convention as the existing
 * merge-approved tests in loop-routes.test.ts, which seed `awaiting_merge`
 * directly) and injecting `readIterationVerdict` — so no real git/task-group
 * dispatch is exercised, only the deciding→{developing} round-recording path
 * and the GET surface.
 */
process.env.NO_PROXY = ["127.0.0.1", "localhost", process.env.NO_PROXY].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.http_proxy;
delete process.env.HTTPS_PROXY;
delete process.env.https_proxy;

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User, ConvergenceVerdict } from "../../../shared/types.js";
import { MemStorage } from "../../../server/storage.js";
import { ConsiliumLoopController } from "../../../server/services/consilium/consilium-loop-controller.js";
import { registerConsiliumLoopRoutes } from "../../../server/routes/consilium-loops.js";

const REPO_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "loop-review-result-surface-")));
afterAll(() => {
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

const OWNER_USER: User = { id: "owner-1", email: "o@x.io", name: "Owner", isActive: true, role: "user", lastLoginAt: null, createdAt: new Date(0) };

const fakeConfig = () =>
  ({
    pipeline: {
      consiliumLoop: {
        enabled: true,
        maxRounds: 6,
        pollIntervalMs: 5000,
        maxDiffBytes: 200000,
        allowedRepoPaths: [REPO_ROOT],
        implement: {
          enabled: true,
          verification: { enabled: false },
          maxFixIterations: 3,
          testCommand: null,
          testRunTimeoutMs: 300000,
          research: { enabled: true, maxResearchIterations: 3, model: "claude-sonnet" },
        },
      },
      taskGroups: { taskTimeoutMs: 60000 },
    },
    providers: { tavily: { apiKey: "test-tavily-key" } },
  }) as never;

const flush = () => new Promise((r) => setTimeout(r, 0));

interface ControllerDeps {
  readIterationVerdict?: (loop: never) => Promise<ConvergenceVerdict | null>;
  runCloseout?: () => Promise<{ prRef: string | null; headCommit: string; report?: unknown }>;
  runResearch?: (...args: unknown[]) => Promise<{ prRef: string | null; headCommit: string; report?: unknown }>;
  gateway?: unknown;
}

async function setup() {
  const storage = new MemStorage();
  const app: Express = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = OWNER_USER;
    next();
  });

  const makeController = (deps: ControllerDeps = {}) =>
    new ConsiliumLoopController({
      storage,
      taskOrchestrator: {
        startGroup: async () => ({ group: {}, iteration: { iterationNumber: 1 } }),
        startGroupAsync: async () => ({ group: {}, iteration: { iterationNumber: 1 } }),
        createTaskGroup: async () => ({ group: { id: "devgrp" }, tasks: [] }),
        cancelGroup: async () => undefined,
      } as never,
      config: fakeConfig,
      readRepoHead: async () => "cafefeed",
      ...deps,
    } as never);

  const controller = makeController();
  registerConsiliumLoopRoutes(app, storage, controller, fakeConfig);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: "bad request", detail: (err as Error)?.message });
  });

  const isProxyArtifact = (res: request.Response): boolean =>
    res.status === 400 && typeof res.text === "string" && res.text.includes("explicit proxy server");
  async function send(make: () => request.Test): Promise<request.Response> {
    let res = await make();
    for (let i = 0; i < 5 && isProxyArtifact(res); i++) res = await make();
    return res;
  }
  const post = (path: string, body?: unknown): Promise<request.Response> =>
    send(() => {
      const r = request(app).post(path);
      return body === undefined ? r : r.send(body as object);
    });
  const get = (path: string): Promise<request.Response> => send(() => request(app).get(path));

  return { app, storage, post, get, makeController };
}

const PRESETS = ["sdlc-cross-review", "diff-pr-review", "full-viability"] as const;

describe.each(PRESETS)("preset coverage: %s", (preset) => {
  it("a decided round surfaces via GET self-sufficiently (converged/openP0/action points), no task-group field on the round", async () => {
    const ctx = await setup();
    const group = await ctx.storage.createTaskGroup({
      name: `[consilium-review:${preset}] myrepo`,
      description: "d",
      input: "objective",
      createdBy: OWNER_USER.id,
    } as never);

    const created = await ctx.post("/api/consilium-loops", { groupId: group.id, repoPath: REPO_ROOT });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    // Fast-forward past building_context/reviewing (same seeding convention the
    // existing merge-approved tests in loop-routes.test.ts use for awaiting_merge).
    await ctx.storage.updateLoop(id, { state: "deciding", round: 1, currentIterationNumber: 1 });

    const verdict: ConvergenceVerdict = {
      converged: false,
      openP0: 2,
      openActionPoints: [
        { title: "fix null check", priority: "P0" },
        { title: "add missing test", priority: "P0" },
        { title: "rename confusing var", priority: "P1" },
      ],
    };
    const controller = ctx.makeController({
      readIterationVerdict: async () => verdict,
      runCloseout: async () => ({ prRef: null, headCommit: "" }),
    });
    const tickRes = await controller.tick(id);
    expect(tickRes?.state).toBe("developing"); // open P0s, room left (round 1 < maxRounds 6)

    const res = await ctx.get(`/api/consilium-loops/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.rounds).toHaveLength(1);

    const round = res.body.rounds[0];
    expect(round.converged).toBe(false);
    expect(round.openP0).toBe(2);
    expect(round.openActionPoints).toEqual(verdict.openActionPoints);
    // No task_executions were seeded for this iteration, so the rich judge verdict
    // (Phase 1, items 1-3) has nothing to read and stays null — the RoundVerdictPanel
    // correctly omits itself rather than rendering a hollow shell (see the E2E spec's
    // null-verdict assertion).
    expect(round.verdict ?? null).toBeNull();
    // Self-sufficient payload — no follow-up call to any task-group endpoint needed.
    expect(round).not.toHaveProperty("devGroupId");
    expect(round).not.toHaveProperty("taskGroupId");
  });
});

describe("research archetype — the develop-phase report surfaces on the SAME round", () => {
  it("a research close-out's report attaches to the recorded round and is visible via GET", async () => {
    const ctx = await setup();
    const group = await ctx.storage.createTaskGroup({
      name: "[consilium-review:sdlc-cross-review] myrepo",
      description: "d",
      input: "objective",
      createdBy: OWNER_USER.id,
    } as never);
    const created = await ctx.post("/api/consilium-loops", { groupId: group.id, repoPath: REPO_ROOT });
    const id = created.body.id as string;

    // archetype set directly (this test targets the round/report surfacing
    // contract, not the PATCH .../archetype override route, which has its own
    // coverage elsewhere).
    await ctx.storage.updateLoop(id, {
      state: "deciding",
      round: 1,
      currentIterationNumber: 1,
      archetype: "research",
    });

    const verdict: ConvergenceVerdict = {
      converged: false,
      openP0: 0,
      openActionPoints: [{ title: "investigate migration risk", priority: "P1" }],
    };
    const report = {
      question: "Is the migration safe?",
      recommendation: "Proceed with a canary rollout.",
      claims: [],
      sources: [],
      verdict: "green" as const,
      generatedAt: new Date(0).toISOString(),
    };
    const controller = ctx.makeController({
      readIterationVerdict: async () => verdict,
      gateway: {} as never, // only checked for truthiness before the research branch
      runResearch: async () => ({ prRef: null, headCommit: "", report }),
    });

    const tickRes = await controller.tick(id);
    expect(tickRes?.state).toBe("developing");
    await flush(); // let the fire-and-forget closeout settle + persist the report

    const res = await ctx.get(`/api/consilium-loops/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.rounds).toHaveLength(1);
    expect(res.body.rounds[0].report).toEqual(report);
    expect(res.body.rounds[0].openActionPoints).toEqual(verdict.openActionPoints);
  });
});

describe("verdict column (Phase 1, items 1-3) — the FULL judge verdict surfaces on the round", () => {
  it("a real judge execution's verdict/pros/cons/full action-point list persists to the round and surfaces via GET", async () => {
    const ctx = await setup();
    const group = await ctx.storage.createTaskGroup({
      name: "[consilium-review:sdlc-cross-review] myrepo",
      description: "d",
      input: "objective",
      createdBy: OWNER_USER.id,
    } as never);
    const created = await ctx.post("/api/consilium-loops", { groupId: group.id, repoPath: REPO_ROOT });
    const id = created.body.id as string;

    // Seed a REAL iteration + judge execution (unlike the other tests in this file,
    // no `readIterationVerdict` is injected here — recordRound's `readRoundVerdict`
    // reads the raw judge output via `getExecutionsByIteration` UNCONDITIONALLY,
    // regardless of whether the ConvergenceVerdict summary is injected or resolved
    // the default way, so this exercises both resolution paths against real storage.
    const iteration = await ctx.storage.createIteration({
      groupId: group.id,
      iterationNumber: 1,
      status: "completed",
      input: "objective",
    });
    await ctx.storage.createExecution({
      iterationId: iteration.id,
      groupId: group.id,
      status: "completed",
      output: {
        verdict: "Solid overall, one blocking issue.",
        pros: ["Good test coverage", "Clear naming"],
        cons: ["Missing null check"],
        action_points: [
          { title: "Fix null check", priority: "P0" },
          { title: "Add a doc note", priority: "P2" },
        ],
        convergence: { converged: false, open_p0: 1 },
      },
    });

    await ctx.storage.updateLoop(id, { state: "deciding", round: 1, currentIterationNumber: 1 });

    const controller = ctx.makeController({ runCloseout: async () => ({ prRef: null, headCommit: "" }) });
    const tickRes = await controller.tick(id);
    expect(tickRes?.state).toBe("developing"); // 1 open P0, room left

    const res = await ctx.get(`/api/consilium-loops/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.rounds).toHaveLength(1);
    const round = res.body.rounds[0];

    // Summary fields resolved the DEFAULT way (no readIterationVerdict injected).
    expect(round.converged).toBe(false);
    expect(round.openP0).toBe(1);

    // The rich verdict — prose + pros/cons + the FULL ranked action-point list
    // (both P0 AND P2, not just the still-open subset in openActionPoints).
    expect(round.verdict).toEqual({
      verdict: "Solid overall, one blocking issue.",
      pros: ["Good test coverage", "Clear naming"],
      cons: ["Missing null check"],
      actionPoints: [
        { title: "Fix null check", priority: "P0" },
        { title: "Add a doc note", priority: "P2" },
      ],
    });
  });
});
