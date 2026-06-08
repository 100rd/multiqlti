/**
 * Unit tests for the practice-card service core:
 *   - computeContentHash: SERVER-computed sha256 over canonicalized
 *     (statement + rationale + appliesTo) with STABLE key order, so logically
 *     identical cards collide (idempotent ingest) and different cards do not.
 *   - projectToChunk / dropProjection: card <-> memory_chunks projection using
 *     injected embedder + vector store (no DB, no network).
 */
import { describe, it, expect, vi } from "vitest";
import {
  computeContentHash,
  projectToChunk,
  dropProjection,
} from "../../../server/knowledge/practice-card-service";
import type { PracticeCardRow } from "@shared/schema";

function makeCard(overrides: Partial<PracticeCardRow> = {}): PracticeCardRow {
  return {
    id: "card-1",
    workspaceId: "ws-1",
    topic: "terraform-module-best-practices",
    statement: "Pin module source versions.",
    rationale: "Unpinned modules drift and break reproducibility.",
    appliesTo: { tool: "terraform", resourceKinds: ["module"], tags: ["versioning"] },
    sources: [],
    confidence: 0.8,
    status: "active",
    supersedes: [],
    supersededBy: [],
    ingestedBy: "researcher",
    ingestedByUserId: "u1",
    verifiedBy: null,
    verifiedByUserId: null,
    verification: {},
    reviewState: "pending_verification",
    contentHash: "x",
    lastVerifiedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe("computeContentHash — canonicalization & idempotency", () => {
  it("produces a stable 64-char hex sha256", () => {
    const h = computeContentHash({
      statement: "s",
      rationale: "r",
      appliesTo: { tool: "terraform" },
    });
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is identical regardless of appliesTo key order (stable key order)", () => {
    const a = computeContentHash({
      statement: "s",
      rationale: "r",
      appliesTo: { tool: "terraform", tags: ["a", "b"], resourceKinds: ["module"] },
    });
    const b = computeContentHash({
      statement: "s",
      rationale: "r",
      appliesTo: { resourceKinds: ["module"], tags: ["a", "b"], tool: "terraform" },
    });
    expect(a).toBe(b);
  });

  it("differs when the statement differs", () => {
    const a = computeContentHash({ statement: "s1", rationale: "r", appliesTo: { tool: "terraform" } });
    const b = computeContentHash({ statement: "s2", rationale: "r", appliesTo: { tool: "terraform" } });
    expect(a).not.toBe(b);
  });

  it("differs when the rationale differs", () => {
    const a = computeContentHash({ statement: "s", rationale: "r1", appliesTo: { tool: "terraform" } });
    const b = computeContentHash({ statement: "s", rationale: "r2", appliesTo: { tool: "terraform" } });
    expect(a).not.toBe(b);
  });

  it("differs when appliesTo content differs", () => {
    const a = computeContentHash({ statement: "s", rationale: "r", appliesTo: { tool: "terraform", tags: ["x"] } });
    const b = computeContentHash({ statement: "s", rationale: "r", appliesTo: { tool: "terraform", tags: ["y"] } });
    expect(a).not.toBe(b);
  });
});

describe("projectToChunk", () => {
  it("embeds statement+rationale and inserts one practice_card chunk", async () => {
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    const insertChunks = vi.fn().mockResolvedValue([{ id: "chunk-1" }]);
    const card = makeCard();

    await projectToChunk(card, {
      embed,
      insertChunks,
      dimensions: 768,
      model: "nomic-embed-text",
      provider: "ollama",
    });

    expect(embed).toHaveBeenCalledOnce();
    const embeddedText = embed.mock.calls[0][0] as string;
    expect(embeddedText).toContain(card.statement);
    expect(embeddedText).toContain(card.rationale);

    expect(insertChunks).toHaveBeenCalledOnce();
    const rows = insertChunks.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceType).toBe("practice_card");
    expect(rows[0].sourceId).toBe(card.id);
    expect(rows[0].workspaceId).toBe(card.workspaceId);
    expect(rows[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });
});

describe("dropProjection", () => {
  it("deletes the practice_card chunk for the card", async () => {
    const deleteBySource = vi.fn().mockResolvedValue(1);
    const card = makeCard();
    const n = await dropProjection(card, { deleteBySource });
    expect(deleteBySource).toHaveBeenCalledWith(card.workspaceId, "practice_card", card.id);
    expect(n).toBe(1);
  });
});
