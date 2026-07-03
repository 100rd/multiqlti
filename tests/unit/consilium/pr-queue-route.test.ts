/**
 * pr-queue-route.test.ts — GET /api/pr-queue (read-only PR review queue).
 *
 * Wires the REAL `registerConsiliumLoopRoutes` over a fake storage + a requireAuth
 * stand-in. Asserts:
 *   - owner scoping: a non-admin reads getLoopsByOwner; an admin reads getLoops;
 *   - 401 when unauthenticated;
 *   - only PR-bearing loops are returned (non-empty prRef AND a PR-bearing state) —
 *     converged/failed/no-prRef loops are filtered out;
 *   - each item is shaped per the wire contract (loopId/prRef/repoPath/state/round/
 *     archetype/createdAt) and enriched with verdictSummary (clamped) + openRemainder
 *     from the loop's LATEST round;
 *   - the flat list is newest-first;
 *   - the returned flat list, fed through the SAME `clusterPrQueue` the client uses,
 *     produces the expected per-repo duplicate clusters.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { AppConfig } from "../../../server/config/schema.js";
import type { IStorage } from "../../../server/storage.js";
import type { ConsiliumLoopController } from "../../../server/services/consilium/consilium-loop-controller.js";
import type { GithubPrStatus } from "../../../shared/pr-queue.js";

// Mock the LIVE-GitHub cache so the route never spawns a real `gh` — every case
// controls the reconciled status (or its failure) via `getManyMock`.
const { getManyMock } = vi.hoisted(() => ({ getManyMock: vi.fn() }));
vi.mock("../../../server/services/github-status.js", () => ({
  githubStatusCache: { getMany: getManyMock },
}));

import { registerConsiliumLoopRoutes } from "../../../server/routes/consilium-loops.js";
import { clusterPrQueue, type PrQueueItem } from "../../../shared/pr-queue.js";

const OWNER = "user-1";
const config = () => ({ pipeline: { consiliumLoop: {} } }) as unknown as AppConfig;

// A representative loop row (only the fields the route reads). `updatedAt` tracks
// `createdAt` unless explicitly overridden (recency prefers updatedAt).
function loop(over: Record<string, unknown>): Record<string, unknown> {
  const base = {
    id: "loop-x",
    groupId: "grp-1",
    state: "awaiting_merge",
    round: 1,
    repoPath: "/repos/widget",
    prRef: "https://github.com/o/widget/pull/1",
    archetype: null,
    createdBy: OWNER,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
  return { updatedAt: base.createdAt, ...base };
}

function makeApp(opts: {
  loops?: Record<string, unknown>[];
  roundsByLoop?: Record<string, unknown[]>;
  user?: { id: string; role?: string };
} = {}) {
  const { loops = [], roundsByLoop = {} } = opts;
  const user = "user" in opts ? opts.user : { id: OWNER };

  const getLoopsByOwner = vi.fn(async (ownerId: string) =>
    loops.filter((l) => l.createdBy === ownerId),
  );
  const getLoops = vi.fn(async () => loops);
  const getLoopRounds = vi.fn(async (loopId: string) => roundsByLoop[loopId] ?? []);

  const storage = {
    getLoopsByOwner,
    getLoops,
    getLoopRounds,
  } as unknown as IStorage;

  const controller = {} as unknown as ConsiliumLoopController;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) (req as unknown as { user: typeof user }).user = user;
    next();
  });
  registerConsiliumLoopRoutes(app, storage, controller, config);
  return { app, getLoopsByOwner, getLoops, getLoopRounds };
}

describe("GET /api/pr-queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: reconciliation returns "unknown" for every ref (hermetic, no `gh`).
    getManyMock.mockImplementation(async (refs: string[]) =>
      new Map<string, GithubPrStatus>(refs.map((r) => [r, "unknown"])),
    );
  });

  it("401 when unauthenticated", async () => {
    const { app } = makeApp({ user: undefined as never });
    const res = await request(app).get("/api/pr-queue");
    expect(res.status).toBe(401);
  });

  it("owner reads getLoopsByOwner (not the admin-wide getLoops)", async () => {
    const { app, getLoopsByOwner, getLoops } = makeApp({
      loops: [loop({ id: "a" })],
    });
    const res = await request(app).get("/api/pr-queue");
    expect(res.status).toBe(200);
    expect(getLoopsByOwner).toHaveBeenCalledWith(OWNER);
    expect(getLoops).not.toHaveBeenCalled();
  });

  it("admin reads the wide getLoops", async () => {
    const { app, getLoops } = makeApp({
      loops: [loop({ id: "a" })],
      user: { id: "admin-x", role: "admin" },
    });
    await request(app).get("/api/pr-queue");
    expect(getLoops).toHaveBeenCalled();
  });

  it("returns only PR-bearing loops (filters no-prRef / converged / failed)", async () => {
    const { app } = makeApp({
      loops: [
        loop({ id: "keep-awaiting", state: "awaiting_merge" }),
        loop({ id: "keep-stopped", state: "stopped_cap" }),
        loop({ id: "drop-no-pr", prRef: null }),
        loop({ id: "drop-converged", state: "converged" }),
        loop({ id: "drop-failed", state: "failed" }),
        loop({ id: "drop-reviewing", state: "reviewing", prRef: null }),
      ],
    });
    const res = await request(app).get("/api/pr-queue");
    expect(res.status).toBe(200);
    const ids = (res.body as PrQueueItem[]).map((i) => i.loopId).sort();
    expect(ids).toEqual(["keep-awaiting", "keep-stopped"]);
  });

  it("shapes each item and enriches verdictSummary + openRemainder from the LATEST round", async () => {
    const { app } = makeApp({
      loops: [loop({ id: "a", round: 2, archetype: "repo-assessment" })],
      roundsByLoop: {
        a: [
          { round: 1, openActionPoints: [{ title: "old", priority: "P0" }], testSummary: "round1" },
          {
            round: 2,
            openActionPoints: [{ title: "x", priority: "P1" }, { title: "y", priority: "P2" }],
            testSummary: "  final verdict  ",
          },
        ],
      },
    });
    const res = await request(app).get("/api/pr-queue");
    const [it] = res.body as PrQueueItem[];
    expect(it.loopId).toBe("a");
    expect(it.prRef).toBe("https://github.com/o/widget/pull/1");
    expect(it.repoPath).toBe("/repos/widget");
    expect(it.state).toBe("awaiting_merge");
    expect(it.round).toBe(2);
    expect(it.archetype).toBe("repo-assessment");
    expect(typeof it.createdAt).toBe("string");
    expect(it.verdictSummary).toBe("final verdict"); // trimmed, from the highest round
    expect(it.openRemainder).toEqual({ total: 2, byPriority: { P1: 1, P2: 1 } });
    expect(it.triggerProvenance).toBeNull(); // no trigger→loop link in schema
  });

  it("orders the flat list newest-first", async () => {
    const { app } = makeApp({
      loops: [
        loop({ id: "old", repoPath: "/repos/a", createdAt: "2026-01-01T00:00:00.000Z" }),
        loop({ id: "new", repoPath: "/repos/b", createdAt: "2026-06-01T00:00:00.000Z" }),
      ],
    });
    const res = await request(app).get("/api/pr-queue");
    expect((res.body as PrQueueItem[]).map((i) => i.loopId)).toEqual(["new", "old"]);
  });

  it("the returned list clusters into per-repo duplicate groups", async () => {
    const { app } = makeApp({
      loops: [
        loop({ id: "w1", repoPath: "/repos/widget", createdAt: "2026-01-01T00:00:00.000Z" }),
        loop({ id: "w2", repoPath: "/repos/widget/", createdAt: "2026-02-01T00:00:00.000Z" }),
        loop({ id: "solo", repoPath: "/repos/other", createdAt: "2026-03-01T00:00:00.000Z" }),
      ],
    });
    const res = await request(app).get("/api/pr-queue");
    const clusters = clusterPrQueue(res.body as PrQueueItem[]);
    const widget = clusters.find((c) => c.repoPath === "/repos/widget");
    const other = clusters.find((c) => c.repoPath === "/repos/other");
    expect(widget?.duplicate).toBe(true);
    expect(widget?.currentLoopId).toBe("w2"); // newest
    expect(widget?.supersededLoopIds).toEqual(["w1"]);
    expect(other?.duplicate).toBe(false);
  });

  it("enriches each item with the reconciled live GitHub status", async () => {
    const { app } = makeApp({
      loops: [
        loop({ id: "a", prRef: "https://github.com/o/widget/pull/1" }),
        loop({ id: "b", prRef: "https://github.com/o/widget/pull/2", state: "stopped_cap" }),
      ],
    });
    getManyMock.mockImplementation(async () =>
      new Map<string, GithubPrStatus>([
        ["https://github.com/o/widget/pull/1", "OPEN"],
        ["https://github.com/o/widget/pull/2", "MERGED"],
      ]),
    );
    const res = await request(app).get("/api/pr-queue");
    const byId = Object.fromEntries((res.body as PrQueueItem[]).map((i) => [i.loopId, i.githubStatus]));
    expect(byId).toEqual({ a: "OPEN", b: "MERGED" });
    // Reconciliation is called with exactly the queued prRefs.
    expect(getManyMock).toHaveBeenCalledWith([
      "https://github.com/o/widget/pull/1",
      "https://github.com/o/widget/pull/2",
    ]);
  });

  it("degrades every item to 'unknown' when reconciliation REJECTS (GitHub down)", async () => {
    const { app } = makeApp({ loops: [loop({ id: "a" }), loop({ id: "b", prRef: "https://github.com/o/widget/pull/2" })] });
    getManyMock.mockRejectedValue(new Error("gh: API rate limit exceeded"));
    const res = await request(app).get("/api/pr-queue");
    expect(res.status).toBe(200); // the queue is NEVER taken down by GitHub
    for (const it of res.body as PrQueueItem[]) expect(it.githubStatus).toBe("unknown");
  });

  it("defaults a ref missing from the reconciliation map to 'unknown'", async () => {
    const { app } = makeApp({ loops: [loop({ id: "a" })] });
    getManyMock.mockImplementation(async () => new Map<string, GithubPrStatus>()); // empty
    const res = await request(app).get("/api/pr-queue");
    expect((res.body as PrQueueItem[])[0].githubStatus).toBe("unknown");
  });
});
