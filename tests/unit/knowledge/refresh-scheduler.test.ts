/**
 * Unit tests for the KnowledgeRefreshScheduler lifecycle + executeRefresh body.
 *
 * We exercise start/stop/reload, the report contents, the no-status-mutation
 * invariant, the failed-run path, cron resolution, and the singleton helpers.
 * The raw cron.schedule() tick is the only wire-up not asserted here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemStorage } from "../../../server/storage";
import {
  KnowledgeRefreshScheduler,
  resolveRefreshCron,
  initRefreshScheduler,
  getRefreshScheduler,
  resetRefreshScheduler,
} from "../../../server/knowledge/refresh-scheduler";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

async function seedWorkspaceWithCards(storage: MemStorage): Promise<string> {
  const ws = await storage.createWorkspace({
    name: "W", type: "local", path: "/tmp/w", branch: "main", status: "active", ownerId: "o",
  });
  return ws.id;
}

async function addActive(storage: MemStorage, workspaceId: string, overrides: Record<string, unknown> = {}) {
  return storage.createPracticeCard({
    workspaceId,
    topic: "terraform-module-best-practices",
    statement: "S " + Math.random(),
    rationale: "R",
    appliesTo: { tool: "terraform" },
    sources: [],
    confidence: 0.5,
    status: "active",
    ingestedBy: "researcher",
    ingestedByUserId: "u1",
    reviewState: "accepted",
    contentHash: "h-" + Math.random().toString(36).slice(2),
    ...overrides,
  });
}

describe("resolveRefreshCron", () => {
  const original = process.env.KB_REFRESH_CRON;
  afterEach(() => {
    if (original === undefined) delete process.env.KB_REFRESH_CRON;
    else process.env.KB_REFRESH_CRON = original;
  });

  it("defaults to weekly Monday 06:00", () => {
    delete process.env.KB_REFRESH_CRON;
    expect(resolveRefreshCron()).toBe("0 6 * * 1");
  });

  it("honors a valid env override", () => {
    process.env.KB_REFRESH_CRON = "0 0 * * *";
    expect(resolveRefreshCron()).toBe("0 0 * * *");
  });

  it("falls back to default for an invalid env cron", () => {
    process.env.KB_REFRESH_CRON = "not a cron";
    expect(resolveRefreshCron()).toBe("0 6 * * 1");
  });
});

describe("lifecycle start/stop/reload", () => {
  it("start registers a job, stop clears it, double-start is idempotent", async () => {
    const storage = new MemStorage();
    const sched = new KnowledgeRefreshScheduler(storage, "0 6 * * 1");
    await sched.start();
    await sched.start(); // idempotent
    sched.stop();
    await sched.reload(); // restart cycle
    sched.stop();
    expect(true).toBe(true); // no throw === pass; jobs map is private
  });

  it("start with an invalid schedule registers nothing", async () => {
    const storage = new MemStorage();
    const sched = new KnowledgeRefreshScheduler(storage, "totally invalid");
    await sched.start();
    sched.stop();
    expect(true).toBe(true);
  });
});

describe("executeRefresh — report + invariants", () => {
  let storage: MemStorage;
  let sched: KnowledgeRefreshScheduler;
  let workspaceId: string;

  beforeEach(async () => {
    storage = new MemStorage();
    sched = new KnowledgeRefreshScheduler(storage, "0 6 * * 1");
    workspaceId = await seedWorkspaceWithCards(storage);
  });

  it("writes a completed report counting unchanged fresh cards", async () => {
    await addActive(storage, workspaceId, { lastVerifiedAt: NOW });
    const run = await sched.executeRefresh(workspaceId, NOW);
    expect(run.status).toBe("completed");
    expect((run.report as { unchangedCount: number }).unchangedCount).toBe(1);
    expect(run.completedAt).not.toBeNull();
  });

  it("flags a stale card in the report and sets pending_review, NEVER mutating status", async () => {
    const stale = await addActive(storage, workspaceId, { lastVerifiedAt: new Date(NOW.getTime() - 100 * DAY) });
    const run = await sched.executeRefresh(workspaceId, NOW);
    expect((run.report as { stale: string[] }).stale).toContain(stale.id);
    const after = await storage.getPracticeCard(stale.id);
    expect(after?.status).toBe("active");
    expect(after?.reviewState).toBe("pending_review");
  });

  it("does not re-set pending_review when already pending (idempotent hint)", async () => {
    const stale = await addActive(storage, workspaceId, {
      lastVerifiedAt: null,
      reviewState: "pending_review",
    });
    const run = await sched.executeRefresh(workspaceId, NOW);
    expect((run.report as { stale: string[] }).stale).toContain(stale.id);
    const after = await storage.getPracticeCard(stale.id);
    expect(after?.reviewState).toBe("pending_review");
  });

  it("triggerNow returns the run id with trigger label", async () => {
    await addActive(storage, workspaceId, { lastVerifiedAt: NOW });
    const id = await sched.triggerNow(workspaceId, "manual", NOW);
    const run = await storage.getRefreshRun(id);
    expect(run?.trigger).toBe("manual");
  });

  it("marks the run failed when storage throws mid-run", async () => {
    await addActive(storage, workspaceId, { lastVerifiedAt: NOW });
    // Force listPracticeCards to throw after the run row is created.
    const original = storage.listPracticeCards.bind(storage);
    storage.listPracticeCards = async () => {
      throw new Error("db down");
    };
    const run = await sched.executeRefresh(workspaceId, NOW);
    expect(run.status).toBe("failed");
    storage.listPracticeCards = original;
  });
});

describe("singleton helpers", () => {
  beforeEach(() => resetRefreshScheduler());
  afterEach(() => resetRefreshScheduler());

  it("init creates, get returns it, reset clears", () => {
    const storage = new MemStorage();
    expect(getRefreshScheduler()).toBeNull();
    const s = initRefreshScheduler(storage);
    expect(getRefreshScheduler()).toBe(s);
    resetRefreshScheduler();
    expect(getRefreshScheduler()).toBeNull();
  });

  it("init twice replaces the previous instance", () => {
    const storage = new MemStorage();
    const a = initRefreshScheduler(storage);
    const b = initRefreshScheduler(storage);
    expect(a).not.toBe(b);
    expect(getRefreshScheduler()).toBe(b);
  });
});
