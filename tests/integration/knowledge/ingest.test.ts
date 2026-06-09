/**
 * Integration tests for POST .../practice-cards/ingest.
 * Covers: auth gating, strict zod validation, allowlist re-validation with atomic
 * batch rejection, server-bound ingestedByUserId, content-hash idempotency, and
 * projection into the (mock) vector store.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createKnowledgeTestApp } from "../../helpers/test-knowledge-app";

const VALID_CARD = {
  statement: "Pin Terraform module source versions.",
  rationale: "Unpinned module sources drift and break reproducible plans.",
  appliesTo: { tool: "terraform", resourceKinds: ["module"], tags: ["versioning"] },
  sources: [
    {
      url: "https://developer.hashicorp.com/terraform/language/modules/sources",
      sourceVersion: "v1.9",
      fetchedAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  confidence: 0.9,
};

function ingestBody(cards: unknown[] = [VALID_CARD]) {
  return { topic: "terraform-module-best-practices", ingestedBy: "researcher-agent", cards };
}

function url(ws: string) {
  return `/api/workspaces/${ws}/knowledge/practice-cards/ingest`;
}

describe("POST /practice-cards/ingest — auth", () => {
  it("rejects a plain user with 403", async () => {
    const { app, workspaceId } = await createKnowledgeTestApp({ role: "user" });
    const res = await request(app).post(url(workspaceId)).send(ingestBody());
    expect(res.status).toBe(403);
  });

  it("allows a maintainer with 201", async () => {
    const { app, workspaceId } = await createKnowledgeTestApp({ role: "maintainer" });
    const res = await request(app).post(url(workspaceId)).send(ingestBody());
    expect(res.status).toBe(201);
    expect(res.body.data.accepted).toBe(1);
  });

  it("allows a non-admin workspace OWNER", async () => {
    const { app, workspaceId } = await createKnowledgeTestApp({ role: "user", ownsWorkspace: true });
    const res = await request(app).post(url(workspaceId)).send(ingestBody());
    expect(res.status).toBe(201);
  });

  it("404s on an unknown workspace", async () => {
    const { app } = await createKnowledgeTestApp({ role: "admin" });
    const res = await request(app).post(url("does-not-exist")).send(ingestBody());
    expect(res.status).toBe(404);
  });
});

describe("POST /practice-cards/ingest — validation", () => {
  it("rejects an over-long statement", async () => {
    const { app, workspaceId } = await createKnowledgeTestApp({ role: "admin" });
    const bad = { ...VALID_CARD, statement: "x".repeat(2001) };
    const res = await request(app).post(url(workspaceId)).send(ingestBody([bad]));
    expect(res.status).toBe(400);
  });

  it("rejects unknown fields (no passthrough)", async () => {
    const { app, workspaceId } = await createKnowledgeTestApp({ role: "admin" });
    const bad = { ...VALID_CARD, evil: true };
    const res = await request(app).post(url(workspaceId)).send(ingestBody([bad]));
    expect(res.status).toBe(400);
  });

  it("rejects confidence outside 0..1", async () => {
    const { app, workspaceId } = await createKnowledgeTestApp({ role: "admin" });
    const bad = { ...VALID_CARD, confidence: 1.5 };
    const res = await request(app).post(url(workspaceId)).send(ingestBody([bad]));
    expect(res.status).toBe(400);
  });

  it("rejects a batch larger than 50", async () => {
    const { app, workspaceId } = await createKnowledgeTestApp({ role: "admin" });
    const many = new Array(51).fill(VALID_CARD);
    const res = await request(app).post(url(workspaceId)).send(ingestBody(many));
    expect(res.status).toBe(400);
  });
});

describe("POST /practice-cards/ingest — allowlist re-validation", () => {
  it("rejects the WHOLE batch and persists nothing if any URL is off-allowlist", async () => {
    const { app, workspaceId, storage, chunks } = await createKnowledgeTestApp({ role: "admin" });
    const evil = {
      ...VALID_CARD,
      sources: [{ url: "https://evil.com/x", fetchedAt: "2026-06-01T00:00:00.000Z" }],
    };
    const res = await request(app).post(url(workspaceId)).send(ingestBody([VALID_CARD, evil]));
    expect(res.status).toBe(400);
    expect(res.body.rejectedUrls).toContain("https://evil.com/x");

    const { total } = await storage.listPracticeCards(workspaceId);
    expect(total).toBe(0);
    expect(chunks).toHaveLength(0);
  });
});

describe("POST /practice-cards/ingest — persistence & projection", () => {
  it("binds ingestedByUserId to the authenticated user, not the declared label", async () => {
    const { app, workspaceId, storage } = await createKnowledgeTestApp({ role: "admin", userId: "real-user-7" });
    const res = await request(app).post(url(workspaceId)).send(ingestBody());
    const cardId = res.body.data.cardIds[0];
    const card = await storage.getPracticeCard(cardId);
    expect(card?.ingestedByUserId).toBe("real-user-7");
    expect(card?.ingestedBy).toBe("researcher-agent");
    expect(card?.reviewState).toBe("pending_verification");
  });

  it("projects each card into one practice_card chunk", async () => {
    const { app, workspaceId, chunks } = await createKnowledgeTestApp({ role: "admin" });
    await request(app).post(url(workspaceId)).send(ingestBody());
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sourceType).toBe("practice_card");
  });

  it("is idempotent: re-ingesting the same content does not duplicate", async () => {
    const { app, workspaceId, storage } = await createKnowledgeTestApp({ role: "admin" });
    await request(app).post(url(workspaceId)).send(ingestBody());
    await request(app).post(url(workspaceId)).send(ingestBody());
    const { total } = await storage.listPracticeCards(workspaceId);
    expect(total).toBe(1);
  });

  it("returns 503 when the embedding provider is unavailable", async () => {
    const { app, workspaceId } = await createKnowledgeTestApp({ role: "admin", embedFails: true });
    const res = await request(app).post(url(workspaceId)).send(ingestBody());
    expect(res.status).toBe(503);
  });

  it("rejects ingest when there is no bound trusted ingester id (persists nothing)", async () => {
    // Role gate passes (admin) but req.user.id is absent → the adversarial gate
    // would be toothless, so ingest must be refused BEFORE any row is written.
    const { app, workspaceId, storage, chunks } = await createKnowledgeTestApp({ role: "admin", noUserId: true });
    const res = await request(app).post(url(workspaceId)).send(ingestBody());
    expect(res.status).toBe(403);
    const { total } = await storage.listPracticeCards(workspaceId);
    expect(total).toBe(0);
    expect(chunks).toHaveLength(0);
  });

  it("storage enforces the NOT NULL ingester invariant (parity with the DB constraint)", async () => {
    const { storage, workspaceId } = await createKnowledgeTestApp({ role: "admin" });
    await expect(
      storage.createPracticeCard({
        workspaceId,
        topic: "terraform-module-best-practices",
        statement: "s",
        rationale: "r",
        appliesTo: { tool: "terraform" },
        sources: [],
        confidence: 0.5,
        ingestedBy: "researcher-agent",
        ingestedByUserId: null as unknown as string,
        reviewState: "pending_verification",
        contentHash: "h-null-ingester",
      }),
    ).rejects.toThrow();
  });
});
