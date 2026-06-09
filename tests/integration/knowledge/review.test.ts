/**
 * Integration tests for POST .../practice-cards/:cardId/review (human gate).
 * Covers: admin/owner-only gating (maintainer is NOT enough), accept is the ONLY
 * path that sets status='active', supersession links, reject drops the projection,
 * and 409 when the card is not pending_review.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createKnowledgeTestApp } from "../../helpers/test-knowledge-app";
import type { MemStorage } from "../../../server/storage";

async function seedPendingReview(
  storage: MemStorage,
  workspaceId: string,
  overrides: Record<string, unknown> = {},
) {
  return storage.createPracticeCard({
    workspaceId,
    topic: "terraform-module-best-practices",
    statement: "Tag every resource with owner + environment.",
    rationale: "Untagged resources cannot be attributed or cleaned up.",
    appliesTo: { tool: "terraform" },
    sources: [],
    confidence: 0.7,
    status: "active",
    ingestedBy: "researcher-agent",
    ingestedByUserId: "ingester-user",
    verifiedBy: "validator-agent",
    verifiedByUserId: "verifier-user",
    reviewState: "pending_review",
    contentHash: "hash-" + Math.random().toString(36).slice(2),
    ...overrides,
  });
}

function reviewUrl(ws: string, cardId: string) {
  return `/api/workspaces/${ws}/knowledge/practice-cards/${cardId}/review`;
}

describe("review — human gate", () => {
  it("rejects a maintainer with 403 (admin/owner only)", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "maintainer" });
    const card = await seedPendingReview(storage, workspaceId);
    const res = await request(app).post(reviewUrl(workspaceId, card.id)).send({ decision: "accept" });
    expect(res.status).toBe(403);
  });

  it("allows the workspace owner even as a plain user", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "user", ownsWorkspace: true });
    const card = await seedPendingReview(storage, workspaceId);
    const res = await request(app).post(reviewUrl(workspaceId, card.id)).send({ decision: "accept" });
    expect(res.status).toBe(200);
  });
});

describe("review — accept", () => {
  it("accept is the only path that sets status='active' and reviewState='accepted'", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "admin" });
    // Seed a non-active card to prove accept is what activates it.
    const card = await seedPendingReview(storage, workspaceId, { status: "deprecated" });
    const res = await request(app).post(reviewUrl(workspaceId, card.id)).send({ decision: "accept" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("active");
    expect(res.body.data.reviewState).toBe("accepted");
  });

  it("supersedes prior cards reciprocally", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "admin" });
    const old = await seedPendingReview(storage, workspaceId, { reviewState: "accepted", status: "active" });
    const fresh = await seedPendingReview(storage, workspaceId);
    const res = await request(app)
      .post(reviewUrl(workspaceId, fresh.id))
      .send({ decision: "accept", supersedes: [old.id] });
    expect(res.status).toBe(200);
    expect(res.body.data.supersedes).toContain(old.id);

    const updatedOld = await storage.getPracticeCard(old.id);
    expect(updatedOld?.status).toBe("superseded");
    expect(updatedOld?.supersededBy).toContain(fresh.id);
  });
});

describe("review — reject", () => {
  it("reject sets reviewState='rejected' and drops the search projection", async () => {
    const { app, storage, workspaceId, chunks } = await createKnowledgeTestApp({ role: "admin" });
    const card = await seedPendingReview(storage, workspaceId);
    // Simulate an existing projection for this card.
    chunks.push({ workspaceId, sourceType: "practice_card", sourceId: card.id, chunkText: "x" });

    const res = await request(app).post(reviewUrl(workspaceId, card.id)).send({ decision: "reject" });
    expect(res.status).toBe(200);
    expect(res.body.data.reviewState).toBe("rejected");
    expect(chunks.find((c) => c.sourceId === card.id)).toBeUndefined();
  });
});

describe("review — illegal transition", () => {
  it("409 when the card is still pending_verification", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "admin" });
    const card = await seedPendingReview(storage, workspaceId, { reviewState: "pending_verification" });
    const res = await request(app).post(reviewUrl(workspaceId, card.id)).send({ decision: "accept" });
    expect(res.status).toBe(409);
  });
});
