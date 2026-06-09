/**
 * Unit tests for BriefScheduler (lazy gen + lock + rate-limit) and the curated
 * news-source allowlist gate.
 *
 * Scheduler: ensureBrief generates only on the first miss (lock claim), serves a
 * cached ready brief without regen, polls while another worker is 'generating',
 * and triggerNow enforces MAX_GENERATIONS_PER_DAY (RateLimitError). Sources:
 * allowedNewsSources keeps only URLs that pass the strict isAllowedSource gate.
 */
import { describe, it, expect, vi } from "vitest";
import { MemStorage } from "../../../server/storage";
import {
  BriefScheduler,
  RateLimitError,
  MAX_GENERATIONS_PER_DAY,
} from "../../../server/news/brief-scheduler";
import { allowedNewsSources, NEWS_SOURCES, type NewsSource } from "../../../server/news/news-sources";

const DATE = "2026-06-09";

async function seedWorkspace(storage: MemStorage): Promise<string> {
  const ws = await storage.createWorkspace({
    name: "n", type: "local", path: "/tmp/n", branch: "main", status: "active", ownerId: "u1",
  });
  return ws.id;
}

/** A generator that marks the claimed brief ready (mirrors the real generator). */
function readyGenerator(storage: MemStorage) {
  return vi.fn(async (p: { workspaceId: string; userId: string; briefDate: string }) => {
    const brief = await storage.getMorningBriefByDate(p.workspaceId, p.userId, p.briefDate);
    if (brief) await storage.updateMorningBriefStatus(brief.id, { status: "ready" });
    return { briefId: brief?.id ?? "x", status: "ready" as const, internalDegraded: false };
  });
}

describe("BriefScheduler.ensureBrief — lazy gen + cache", () => {
  it("generates once on the first miss", async () => {
    const storage = new MemStorage();
    const ws = await seedWorkspace(storage);
    const gen = readyGenerator(storage);
    const scheduler = new BriefScheduler(storage, gen, { sleep: () => Promise.resolve() });
    const brief = await scheduler.ensureBrief({ workspaceId: ws, userId: "u1", briefDate: DATE });
    expect(brief.status).toBe("ready");
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it("serves a cached ready brief without regenerating", async () => {
    const storage = new MemStorage();
    const ws = await seedWorkspace(storage);
    const gen = readyGenerator(storage);
    const scheduler = new BriefScheduler(storage, gen, { sleep: () => Promise.resolve() });
    await scheduler.ensureBrief({ workspaceId: ws, userId: "u1", briefDate: DATE });
    await scheduler.ensureBrief({ workspaceId: ws, userId: "u1", briefDate: DATE });
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it("polls (does not regenerate) when a brief is already 'generating'", async () => {
    const storage = new MemStorage();
    const ws = await seedWorkspace(storage);
    // Pre-claim the lock as 'generating' (another worker holds it).
    const { brief } = await storage.createMorningBrief({ workspaceId: ws, userId: "u1", briefDate: DATE, status: "generating" });
    const gen = vi.fn(async () => ({ briefId: brief.id, status: "ready" as const, internalDegraded: false }));
    let polls = 0;
    const scheduler = new BriefScheduler(storage, gen, {
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      sleep: async () => {
        polls += 1;
        if (polls === 2) await storage.updateMorningBriefStatus(brief.id, { status: "ready" });
      },
    });
    const result = await scheduler.ensureBrief({ workspaceId: ws, userId: "u1", briefDate: DATE });
    expect(result.status).toBe("ready");
    expect(gen).not.toHaveBeenCalled(); // waited for the other worker
  });

  it("returns the current row when polling times out", async () => {
    const storage = new MemStorage();
    const ws = await seedWorkspace(storage);
    const { brief } = await storage.createMorningBrief({ workspaceId: ws, userId: "u1", briefDate: DATE, status: "generating" });
    const scheduler = new BriefScheduler(storage, vi.fn(), {
      pollIntervalMs: 0,
      pollTimeoutMs: 0,
      sleep: () => Promise.resolve(),
    });
    const result = await scheduler.ensureBrief({ workspaceId: ws, userId: "u1", briefDate: DATE });
    expect(result.id).toBe(brief.id);
    expect(result.status).toBe("generating");
  });
});

describe("BriefScheduler.triggerNow — rate limit (C1)", () => {
  it("generates on the first manual trigger", async () => {
    const storage = new MemStorage();
    const ws = await seedWorkspace(storage);
    const gen = readyGenerator(storage);
    const scheduler = new BriefScheduler(storage, gen, { sleep: () => Promise.resolve() });
    const id = await scheduler.triggerNow({ workspaceId: ws, userId: "u1", briefDate: DATE });
    expect(typeof id).toBe("string");
  });

  it("throws RateLimitError once the daily cap is reached", async () => {
    const storage = new MemStorage();
    const ws = await seedWorkspace(storage);
    const gen = readyGenerator(storage);
    const scheduler = new BriefScheduler(storage, gen, { sleep: () => Promise.resolve() });
    await scheduler.triggerNow({ workspaceId: ws, userId: "u1", briefDate: DATE }); // genCount=1
    for (let i = 1; i < MAX_GENERATIONS_PER_DAY; i++) {
      await scheduler.triggerNow({ workspaceId: ws, userId: "u1", briefDate: DATE });
    }
    await expect(scheduler.triggerNow({ workspaceId: ws, userId: "u1", briefDate: DATE })).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });
});

describe("allowedNewsSources", () => {
  it("keeps the curated sources (all pass the strict gate)", () => {
    const allowed = allowedNewsSources();
    expect(allowed.length).toBe(NEWS_SOURCES.length);
  });

  it("drops a source that fails the allowlist gate", () => {
    const sources: NewsSource[] = [
      { url: "https://aws.amazon.com/feed", sourceName: "AWS", provider: "aws-whatsnew" },
      { url: "http://evil.example/feed", sourceName: "Evil", provider: "vendor-changelog" },
      { url: "https://evil.example/feed", sourceName: "Evil2", provider: "vendor-changelog" },
    ];
    const allowed = allowedNewsSources(sources);
    expect(allowed.map((s) => s.url)).toEqual(["https://aws.amazon.com/feed"]);
  });
});
