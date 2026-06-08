/**
 * Integration tests for POST .../practice-cards/:cardId/verify.
 * Covers: auth, the adversarial same-actor 409 gate (id AND declared label),
 * verdict-driven state transitions, cross-workspace 404, and illegal-transition 409.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createKnowledgeTestApp } from "../../helpers/test-knowledge-app";
import type { MemStorage } from "../../../server/storage";

async function seedCard(
  storage: MemStorage,
  workspaceId: string,
  overrides: Record<string, unknown> = {},
) {
  return storage.createPracticeCard({
    workspaceId,
    topic: "terraform-module-best-practices",
    statement: "Use remote state with locking.",
    rationale: "Prevents concurrent applies from corrupting state.",
    appliesTo: { tool: "terraform" },
    sources: [],
    confidence: 0.8,
    ingestedBy: "researcher-agent",
    ingestedByUserId: "ingester-user",
    reviewState: "pending_verification",
    contentHash: "hash-" + Math.random().toString(36).slice(2),
    ...overrides,
  });
}

function verifyUrl(ws: string, cardId: string) {
  return `/api/workspaces/${ws}/knowledge/practice-cards/${cardId}/verify`;
}

describe("verify — auth", () => {
  it("rejects a plain user with 403", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "user" });
    const card = await seedCard(storage, workspaceId);
    const res = await request(app)
      .post(verifyUrl(workspaceId, card.id))
      .send({ verifiedBy: "validator-agent", verdict: "pass" });
    expect(res.status).toBe(403);
  });
});

describe("verify — adversarial same-actor gate", () => {
  it("returns 409 when verifier user id equals the ingester user id", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "admin", userId: "same-user" });
    const card = await seedCard(storage, workspaceId, { ingestedByUserId: "same-user" });
    const res = await request(app)
      .post(verifyUrl(workspaceId, card.id))
      .send({ verifiedBy: "validator-agent", verdict: "pass" });
    expect(res.status).toBe(409);
  });

  it("returns 409 when the declared verifiedBy equals ingestedBy", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "admin", userId: "verifier-user" });
    const card = await seedCard(storage, workspaceId, { ingestedBy: "researcher-agent" });
    const res = await request(app)
      .post(verifyUrl(workspaceId, card.id))
      .send({ verifiedBy: "researcher-agent", verdict: "pass" });
    expect(res.status).toBe(409);
  });

  it("fails closed: a card with a null ingester id cannot be verified (defense-in-depth)", async () => {
    // A null ingester id cannot occur normally (NOT NULL column + ingest guard),
    // so we forge a corrupt/legacy row by nulling it post-create. The identity
    // check then can't compare, and the gate must NOT let a differing label pass.
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "admin", userId: "verifier-user" });
    const card = await seedCard(storage, workspaceId, { ingestedBy: "researcher-agent" });
    await storage.updatePracticeCardState(card.id, {
      ingestedByUserId: null as unknown as string,
    });
    const res = await request(app)
      .post(verifyUrl(workspaceId, card.id))
      .send({ verifiedBy: "different-validator", verdict: "pass" });
    expect(res.status).toBe(409);
  });
});

describe("verify — verdict transitions", () => {
  it("pass -> pending_review, records verifier + lastVerifiedAt", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "admin", userId: "verifier-user" });
    const card = await seedCard(storage, workspaceId);
    const res = await request(app)
      .post(verifyUrl(workspaceId, card.id))
      .send({ verifiedBy: "validator-agent", verdict: "pass", checkedSources: [] });
    expect(res.status).toBe(200);
    expect(res.body.data.reviewState).toBe("pending_review");
    expect(res.body.data.verifiedByUserId).toBe("verifier-user");
    expect(res.body.data.lastVerifiedAt).not.toBeNull();
  });

  it("fail -> rejected", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "admin", userId: "verifier-user" });
    const card = await seedCard(storage, workspaceId);
    const res = await request(app)
      .post(verifyUrl(workspaceId, card.id))
      .send({ verifiedBy: "validator-agent", verdict: "fail" });
    expect(res.status).toBe(200);
    expect(res.body.data.reviewState).toBe("rejected");
  });

  it("returns 409 when verifying a card not pending_verification", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "admin", userId: "verifier-user" });
    const card = await seedCard(storage, workspaceId, { reviewState: "pending_review" });
    const res = await request(app)
      .post(verifyUrl(workspaceId, card.id))
      .send({ verifiedBy: "validator-agent", verdict: "pass" });
    expect(res.status).toBe(409);
  });
});

describe("verify — cross-workspace isolation", () => {
  it("404s for a card that belongs to another workspace", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "admin", userId: "verifier-user" });
    const otherWs = await storage.createWorkspace({
      name: "Other",
      type: "local",
      path: "/tmp/other",
      branch: "main",
      status: "active",
      ownerId: "verifier-user",
    });
    const card = await seedCard(storage, otherWs.id);
    const res = await request(app)
      .post(verifyUrl(workspaceId, card.id))
      .send({ verifiedBy: "validator-agent", verdict: "pass" });
    expect(res.status).toBe(404);
  });
});
