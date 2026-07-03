/**
 * trust-telemetry-route.test.ts — GET /api/telemetry/trust (Stage D).
 *
 * Wires the REAL `registerTelemetryRoutes` over a fake storage + a requireAuth
 * stand-in. Asserts:
 *   - 200 wire shape (grounding / planner / criteria / honesty / scan);
 *   - the scan is BOUNDED — with `limit=N`, at most N loops' rounds are read
 *     (getLoopRounds called ≤ N), and `windowDays` excludes older loops;
 *   - 401 when unauthenticated (the route's belt-and-suspenders guard);
 *   - REGRESSION GUARD: the `/api/telemetry` auth+project mount actually exists in
 *     routes.ts — the exact bug class that left /api/pr-queue unprotected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import type { IStorage } from "../../../server/storage.js";
import { registerTelemetryRoutes } from "../../../server/routes/telemetry.js";
import type { ExecutionTrace } from "@shared/types";

const OWNER = "user-1";

function traceWith(method: ExecutionTrace["controller"]["workers"][number]["criteria"][number]["method"]): ExecutionTrace {
  return {
    schemaVersion: 1,
    archetype: "repo-assessment",
    controller: {
      kind: "sdlc-executor",
      label: "sdlc",
      green: true,
      workers: [
        {
          index: 1,
          priority: "P0",
          title: "w",
          status: "completed",
          skills: [{ skillName: "coder", capability: "worktree-write", permissionsUsed: ["Edit"], green: true }],
          criteria: [{ criterion: "When X Then Y", method, ran: true, passed: true }],
        },
      ],
    },
  };
}

function loop(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "loop-x",
    groupId: "grp-1",
    archetype: "repo-assessment",
    archetypeSource: "proposed",
    createdBy: OWNER,
    createdAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

function makeApp(opts: {
  loops?: Record<string, unknown>[];
  roundsByLoop?: Record<string, unknown[]>;
  user?: { id: string; role?: string };
} = {}) {
  const { loops = [], roundsByLoop = {} } = opts;
  const user = "user" in opts ? opts.user : { id: OWNER };

  const getLoops = vi.fn(async () => loops);
  const getLoopRounds = vi.fn(async (loopId: string) => roundsByLoop[loopId] ?? []);
  const storage = { getLoops, getLoopRounds } as unknown as IStorage;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) (req as unknown as { user: typeof user }).user = user;
    next();
  });
  registerTelemetryRoutes(app, storage);
  return { app, getLoops, getLoopRounds };
}

describe("GET /api/telemetry/trust", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the aggregated wire shape (200)", async () => {
    const { app, getLoops } = makeApp({
      loops: [loop({ id: "l1", archetypeSource: "override" })],
      roundsByLoop: {
        l1: [
          {
            createdAt: "2026-06-01T00:00:00.000Z",
            openActionPoints: [{ weakCriterion: true }],
            executionTrace: traceWith("test-run"),
          },
        ],
      },
    });
    const res = await request(app).get("/api/telemetry/trust");
    expect(res.status).toBe(200);
    expect(getLoops).toHaveBeenCalledTimes(1);
    expect(res.body.grounding.groundingRatio).toBe(1); // 1 test-run criterion
    expect(res.body.planner.overrideRate).toBe(1); // the one loop was overridden
    expect(res.body.criteria.weakRate).toBe(1);
    expect(res.body.honesty).toContain("100%");
    expect(res.body.scan).toEqual({ limit: 50, windowDays: null });
  });

  it("BOUNDS the scan: limit caps how many loops' rounds are read", async () => {
    const loops = Array.from({ length: 5 }, (_, i) =>
      loop({ id: `l${i}`, createdAt: `2026-06-0${i + 1}T00:00:00.000Z` }),
    );
    const { app, getLoopRounds } = makeApp({ loops });
    const res = await request(app).get("/api/telemetry/trust?limit=2");
    expect(res.status).toBe(200);
    // Only the 2 newest loops' rounds are fetched — the scan is bounded.
    expect(getLoopRounds).toHaveBeenCalledTimes(2);
    expect(res.body.window.loops).toBe(2);
    expect(res.body.scan.limit).toBe(2);
  });

  it("windowDays excludes loops older than the window", async () => {
    const now = Date.now();
    const recent = loop({ id: "recent", createdAt: new Date(now - 1 * 86_400_000).toISOString() });
    const old = loop({ id: "old", createdAt: new Date(now - 100 * 86_400_000).toISOString() });
    const { app, getLoopRounds } = makeApp({ loops: [recent, old] });
    const res = await request(app).get("/api/telemetry/trust?windowDays=7");
    expect(res.status).toBe(200);
    expect(res.body.window.loops).toBe(1);
    expect(getLoopRounds).toHaveBeenCalledTimes(1);
    expect(getLoopRounds).toHaveBeenCalledWith("recent");
  });

  it("rejects an invalid limit (400)", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/api/telemetry/trust?limit=9999");
    expect(res.status).toBe(400);
  });

  it("401 when unauthenticated (belt-and-suspenders guard)", async () => {
    const { app, getLoops } = makeApp({ user: undefined });
    const res = await request(app).get("/api/telemetry/trust");
    expect(res.status).toBe(401);
    expect(getLoops).not.toHaveBeenCalled();
  });
});

describe("routes.ts — /api/telemetry auth mount (pr-queue regression guard)", () => {
  it("mounts /api/telemetry behind requireAuth + requireProject", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../../server/routes.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /app\.use\(\s*["']\/api\/telemetry["']\s*,\s*requireAuth\s*,\s*requireProject\s*\)/,
    );
    // and the route module is actually registered
    expect(src).toContain("registerTelemetryRoutes(app, storage)");
  });
});
