import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { registerTriggerRoutes } from "../../server/routes/triggers";
import type { TriggerService } from "../../server/services/trigger-service";
import type { IStorage } from "../../server/storage";
import type { ConsiliumLoopRow } from "../../shared/schema";
import type { Trigger, TriggerProvenance } from "../../shared/types";
import { TRIGGER_FIRED_LOOPS_LIMIT } from "../../shared/types";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TRIGGER_ID = "trig-1";

/** A project-scoped (pipeline-less) trigger — assertTriggerAccess passes without a pipeline owner lookup. */
function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: TRIGGER_ID,
    pipelineId: null,
    type: "github_event",
    config: { repository: "owner/repo", events: ["pull_request"] } as never,
    hasSecret: false,
    enabled: true,
    lastTriggeredAt: new Date("2026-07-01T10:00:00Z"),
    suppressedCount: 3,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

/** Minimal loop row — the route reads only id/state/prRef/createdAt/triggerProvenance. */
function makeLoop(
  id: string,
  provenance: TriggerProvenance | null,
  extra: Partial<ConsiliumLoopRow> = {},
): ConsiliumLoopRow {
  return {
    id,
    state: "reviewing",
    prRef: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    triggerProvenance: provenance,
    ...extra,
  } as unknown as ConsiliumLoopRow;
}

function prov(overrides: Partial<TriggerProvenance> = {}): TriggerProvenance {
  return {
    triggerId: TRIGGER_ID,
    triggerType: "github_event",
    eventDigest: "abc1234",
    firedAt: "2026-07-01T12:00:00Z",
    ...overrides,
  };
}

function makeStorage(loops: ConsiliumLoopRow[]): IStorage {
  return {
    getLoops: vi.fn(async () => loops),
  } as unknown as IStorage;
}

function makeService(trigger: Trigger | null): TriggerService {
  return {
    getTrigger: vi.fn(async (id: string) => (trigger && trigger.id === id ? trigger : null)),
  } as unknown as TriggerService;
}

/**
 * Build the app the way production mounts it: an auth+project gate on the
 * `/api/triggers` PREFIX (routes.ts `app.use("/api/triggers", requireAuth,
 * requireProject)`), so the `:id/loops` sub-route inherits it. `authed=false`
 * simulates a missing token to prove the sub-route is guarded (the /api/pr-queue
 * 401 lesson).
 */
function buildApp(service: TriggerService, storage: IStorage, authed = true): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/triggers", (req, res, next) => {
    if (!authed) return res.status(401).json({ error: "Authentication required" });
    (req as unknown as { user: { id: string; role: string }; projectId: string }).user = {
      id: "user-1",
      role: "admin",
    };
    (req as unknown as { projectId: string }).projectId = "proj-1";
    next();
  });
  registerTriggerRoutes(app, service, storage);
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/triggers/:id/loops", () => {
  let trigger: Trigger;

  beforeEach(() => {
    trigger = makeTrigger();
  });

  it("returns only loops whose provenance.triggerId matches, newest fire first", async () => {
    const loops = [
      makeLoop("loop-old", prov({ firedAt: "2026-07-01T08:00:00Z", eventDigest: "old111", eventSummary: "PR #1: old" }), { prRef: "pr-1" }),
      makeLoop("loop-new", prov({ firedAt: "2026-07-01T20:00:00Z", eventDigest: "new222", eventSummary: "PR #2: new" }), { prRef: "pr-2", state: "done" }),
      // A different trigger's loop — must be excluded.
      makeLoop("loop-other", prov({ triggerId: "trig-OTHER", firedAt: "2026-07-01T23:00:00Z" })),
      // A human/API loop — null provenance, correctly excluded.
      makeLoop("loop-human", null),
    ];
    const app = buildApp(makeService(trigger), makeStorage(loops));

    const res = await request(app).get(`/api/triggers/${TRIGGER_ID}/loops`);

    expect(res.status).toBe(200);
    expect(res.body.triggerId).toBe(TRIGGER_ID);
    expect(res.body.firedCount).toBe(2);
    expect(res.body.loops.map((l: { loopId: string }) => l.loopId)).toEqual(["loop-new", "loop-old"]);
    expect(res.body.loops[0]).toMatchObject({
      loopId: "loop-new",
      state: "done",
      prRef: "pr-2",
      eventSummary: "PR #2: new",
      eventDigest: "new222",
      firedAt: "2026-07-01T20:00:00Z",
    });
  });

  it("fire count is DISTINCT from suppressedCount (independent numbers)", async () => {
    // Trigger says suppressed=3; it fired exactly 1 loop → firedCount must be 1, not 3.
    const loops = [makeLoop("loop-a", prov())];
    const app = buildApp(makeService(makeTrigger({ suppressedCount: 3 })), makeStorage(loops));

    const res = await request(app).get(`/api/triggers/${TRIGGER_ID}/loops`);

    expect(res.status).toBe(200);
    expect(res.body.firedCount).toBe(1);
    // The endpoint never echoes suppressedCount — the card pairs them client-side.
    expect(res.body.suppressedCount).toBeUndefined();
  });

  it("returns an empty list + zero count for a never-fired trigger", async () => {
    const app = buildApp(makeService(trigger), makeStorage([makeLoop("loop-human", null)]));

    const res = await request(app).get(`/api/triggers/${TRIGGER_ID}/loops`);

    expect(res.status).toBe(200);
    expect(res.body.firedCount).toBe(0);
    expect(res.body.loops).toEqual([]);
  });

  it("bounds the returned list but reports the full fired count (hundreds of fires)", async () => {
    const many = Array.from({ length: TRIGGER_FIRED_LOOPS_LIMIT + 25 }, (_, i) =>
      makeLoop(`loop-${i}`, prov({ firedAt: new Date(2026, 6, 1, 0, i).toISOString(), eventDigest: `d${i}` })),
    );
    const app = buildApp(makeService(trigger), makeStorage(many));

    const res = await request(app).get(`/api/triggers/${TRIGGER_ID}/loops`);

    expect(res.status).toBe(200);
    expect(res.body.firedCount).toBe(TRIGGER_FIRED_LOOPS_LIMIT + 25);
    expect(res.body.loops).toHaveLength(TRIGGER_FIRED_LOOPS_LIMIT);
  });

  it("404s when the trigger does not exist / is outside the project", async () => {
    const app = buildApp(makeService(null), makeStorage([]));

    const res = await request(app).get(`/api/triggers/${TRIGGER_ID}/loops`);

    expect(res.status).toBe(404);
  });

  it("is guarded by the /api/triggers auth mount (401 without a token — the pr-queue lesson)", async () => {
    const service = makeService(trigger);
    const storage = makeStorage([makeLoop("loop-a", prov())]);
    const app = buildApp(service, storage, /* authed */ false);

    const res = await request(app).get(`/api/triggers/${TRIGGER_ID}/loops`);

    expect(res.status).toBe(401);
    // The handler never ran — no storage read happened behind the gate.
    expect(storage.getLoops).not.toHaveBeenCalled();
  });
});
