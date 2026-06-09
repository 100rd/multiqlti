/**
 * Unit tests for the brief generator (control flow + security invariants).
 *
 * generateBrief(deps, {workspaceId, userId, briefDate}) =>
 *   - claims/loads the morning_brief lock,
 *   - INTERNAL items via the board provider (affects[] ONLY from
 *     boardProvider.toAffects(blastRadius) — C2; NEVER from the LLM),
 *   - EXTERNAL items via the fetcher,
 *   - summary/whyRelevant via gateway with untrusted-data framing (M4),
 *   - as_of is server-computed UTC ending 'Z' (M3),
 *   - ranks + persists (dedup/idempotent),
 *   - degraded paths: Omniscience disabled/unreachable -> internalDegraded=true,
 *     external still ships, status 'ready' (not throw); gateway failure -> 'failed'.
 */
import { describe, it, expect, vi } from "vitest";
import { MemStorage } from "../../../server/storage";
import { generateBrief, type GenerateBriefDeps } from "../../../server/news/brief-generator";
import type { BlastRadius } from "../../../server/memory/omniscience-board-provider";

const BRIEF_DATE = "2026-06-09";

function blast(entityId: string, score = 0.8): BlastRadius {
  return {
    seedEntityId: entityId,
    actionType: "restart",
    maxDepth: 3,
    impacted: [
      { entityId: "svc-a", entityType: "service", impactScore: score, confidence: 1, path: [] },
    ],
  };
}

interface HarnessOptions {
  boardDisabled?: boolean;
  boardFails?: boolean;
  gatewayFails?: boolean;
  externalItems?: Array<{ title: string; summary: string; sourceUri?: string; sourceName?: string; provider?: string; contentHash: string }>;
  capturePrompts?: string[];
}

async function harness(opts: HarnessOptions = {}) {
  const storage = new MemStorage();
  const ws = await storage.createWorkspace({
    name: "news", type: "local", path: "/tmp/n", branch: "main", status: "active", ownerId: "u1",
  });
  await storage.upsertNewsProfile({ workspaceId: ws.id, userId: "u1", role: "sre", stack: ["aws", "kubernetes"] });

  const asOfSeen: string[] = [];
  const prompts = opts.capturePrompts ?? [];

  const boardProvider = opts.boardDisabled
    ? null
    : {
        blastRadius: vi.fn(async (p: { entityId: string; asOf?: string }) => {
          if (opts.boardFails) throw new Error("forbidden:no workspace token");
          if (p.asOf) asOfSeen.push(p.asOf);
          return blast(p.entityId);
        }),
        toAffects: (b: BlastRadius) => b.impacted.map((i) => ({
          entityId: i.entityId, entityType: i.entityType, impactScore: i.impactScore,
          confidence: i.confidence, path: i.path,
        })),
      };

  const deps: GenerateBriefDeps = {
    storage,
    boardProvider: boardProvider as unknown as GenerateBriefDeps["boardProvider"],
    searchInternal: async (asOf) => {
      asOfSeen.push(asOf);
      return [
        { title: "deploy svc-a", summary: "raw omniscience text", seedEntityId: "svc-a", sourceUri: "https://internal/x", sourceName: "omniscience" },
      ];
    },
    fetchExternal: async () =>
      opts.externalItems ?? [
        { title: "AWS EKS X", summary: "EKS adds X", sourceUri: "https://aws.amazon.com/x", sourceName: "AWS", provider: "aws-whatsnew", contentHash: "ext-hash-1" },
      ],
    summarize: async ({ prompt }) => {
      prompts.push(prompt);
      if (opts.gatewayFails) throw new Error("gateway down");
      return { summary: "clean summary", whyRelevant: "matters to your stack" };
    },
    now: () => new Date("2026-06-09T05:30:00.000Z"),
  };

  return { storage, ws, deps, asOfSeen, prompts };
}

describe("generateBrief — happy path", () => {
  it("produces a ready brief with internal + external items", async () => {
    const { storage, ws, deps } = await harness();
    const result = await generateBrief(deps, { workspaceId: ws.id, userId: "u1", briefDate: BRIEF_DATE });
    expect(result.status).toBe("ready");
    const brief = await storage.getMorningBrief(result.briefId);
    expect(brief?.status).toBe("ready");
    const { items } = await loadItems(storage, result.briefId);
    expect(items.some((i) => i.category === "internal")).toBe(true);
    expect(items.some((i) => i.category === "external")).toBe(true);
  });

  it("ranks items by relevanceScore DESC", async () => {
    const { storage, ws, deps } = await harness();
    const result = await generateBrief(deps, { workspaceId: ws.id, userId: "u1", briefDate: BRIEF_DATE });
    const { items } = await loadItems(storage, result.briefId);
    const scores = items.map((i) => i.relevanceScore);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);
  });
});

describe("generateBrief — C2: affects ONLY from blast_radius", () => {
  it("sets internal item affects from boardProvider.toAffects, not the LLM", async () => {
    const { storage, ws, deps } = await harness();
    const result = await generateBrief(deps, { workspaceId: ws.id, userId: "u1", briefDate: BRIEF_DATE });
    const { items } = await loadItems(storage, result.briefId);
    const internal = items.find((i) => i.category === "internal");
    expect(internal?.affects.length).toBe(1);
    expect(internal?.affects[0].entityId).toBe("svc-a");
  });

  it("external items never carry affects", async () => {
    const { storage, ws, deps } = await harness();
    const result = await generateBrief(deps, { workspaceId: ws.id, userId: "u1", briefDate: BRIEF_DATE });
    const { items } = await loadItems(storage, result.briefId);
    const ext = items.find((i) => i.category === "external");
    expect(ext?.affects).toEqual([]);
  });
});

describe("generateBrief — M3 as_of UTC + M4 untrusted framing", () => {
  it("passes an as_of ending in 'Z' to internal lookups", async () => {
    const { ws, deps, asOfSeen } = await harness();
    await generateBrief(deps, { workspaceId: ws.id, userId: "u1", briefDate: BRIEF_DATE });
    expect(asOfSeen.length).toBeGreaterThan(0);
    expect(asOfSeen.every((s) => s.endsWith("Z"))).toBe(true);
  });

  it("frames fetched content as untrusted DATA in the summarization prompt", async () => {
    const prompts: string[] = [];
    const { ws, deps } = await harness({ capturePrompts: prompts });
    await generateBrief(deps, { workspaceId: ws.id, userId: "u1", briefDate: BRIEF_DATE });
    expect(prompts.length).toBeGreaterThan(0);
    // every prompt instructs the model to NOT follow instructions in the content
    expect(prompts.every((p) => /do not follow/i.test(p))).toBe(true);
  });
});

describe("generateBrief — idempotency + dedup", () => {
  it("a second run for the same day does not duplicate items", async () => {
    const { storage, ws, deps } = await harness();
    const r1 = await generateBrief(deps, { workspaceId: ws.id, userId: "u1", briefDate: BRIEF_DATE });
    const before = (await loadItems(storage, r1.briefId)).items.length;
    const r2 = await generateBrief(deps, { workspaceId: ws.id, userId: "u1", briefDate: BRIEF_DATE });
    expect(r2.briefId).toBe(r1.briefId);
    const after = (await loadItems(storage, r2.briefId)).items.length;
    expect(after).toBe(before);
  });
});

describe("generateBrief — graceful degradation", () => {
  it("Omniscience disabled (no board provider) -> internalDegraded, external ships, ready", async () => {
    const { storage, ws, deps } = await harness({ boardDisabled: true });
    const result = await generateBrief(deps, { workspaceId: ws.id, userId: "u1", briefDate: BRIEF_DATE });
    expect(result.status).toBe("ready");
    const brief = await storage.getMorningBrief(result.briefId);
    expect(brief?.internalDegraded).toBe(true);
    const { items } = await loadItems(storage, result.briefId);
    expect(items.some((i) => i.category === "external")).toBe(true);
  });

  it("Omniscience unreachable (board throws) -> internalDegraded, ready (not thrown)", async () => {
    const { storage, ws, deps } = await harness({ boardFails: true });
    const result = await generateBrief(deps, { workspaceId: ws.id, userId: "u1", briefDate: BRIEF_DATE });
    expect(result.status).toBe("ready");
    const brief = await storage.getMorningBrief(result.briefId);
    expect(brief?.internalDegraded).toBe(true);
  });

  it("gateway failure -> brief status 'failed'", async () => {
    const { storage, ws, deps } = await harness({ gatewayFails: true });
    const result = await generateBrief(deps, { workspaceId: ws.id, userId: "u1", briefDate: BRIEF_DATE });
    expect(result.status).toBe("failed");
    const brief = await storage.getMorningBrief(result.briefId);
    expect(brief?.status).toBe("failed");
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

async function loadItems(storage: MemStorage, briefId: string) {
  const all = (storage as unknown as { newsItemsMap: Map<string, { briefId: string }> }).newsItemsMap;
  const items = Array.from(all.values()).filter((i) => i.briefId === briefId) as Array<{
    briefId: string; category: "internal" | "external"; relevanceScore: number;
    affects: Array<{ entityId: string }>;
  }>;
  return { items };
}
