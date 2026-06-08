/**
 * Integration tests for GET .../practice-cards and .../practice-cards/search.
 * Covers: workspace-scoped listing + filters + pagination, semantic-search
 * hydration of vector hits back to full cards, workspace isolation of hits, and
 * the 503 path when the embedding provider is unavailable.
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
    statement: "Statement " + Math.random().toString(36).slice(2),
    rationale: "Rationale text.",
    appliesTo: { tool: "terraform" },
    sources: [],
    confidence: 0.5,
    ingestedBy: "researcher-agent",
    ingestedByUserId: "ingester-user",
    reviewState: "accepted",
    status: "active",
    contentHash: "hash-" + Math.random().toString(36).slice(2),
    ...overrides,
  });
}

function listUrl(ws: string) {
  return `/api/workspaces/${ws}/knowledge/practice-cards`;
}
function searchUrl(ws: string) {
  return `/api/workspaces/${ws}/knowledge/practice-cards/search`;
}

describe("GET /practice-cards — list", () => {
  it("lists only the workspace's cards with total meta", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "user" });
    await seedCard(storage, workspaceId);
    await seedCard(storage, workspaceId);
    const res = await request(app).get(listUrl(workspaceId));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.total).toBe(2);
  });

  it("filters by reviewState", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "user" });
    await seedCard(storage, workspaceId, { reviewState: "accepted" });
    await seedCard(storage, workspaceId, { reviewState: "rejected" });
    const res = await request(app).get(listUrl(workspaceId)).query({ reviewState: "rejected" });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].reviewState).toBe("rejected");
  });

  it("paginates with limit/offset", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "user" });
    for (let i = 0; i < 5; i++) await seedCard(storage, workspaceId);
    const res = await request(app).get(listUrl(workspaceId)).query({ limit: 2, offset: 0 });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.total).toBe(5);
  });

  it("rejects limit over 200", async () => {
    const { app, workspaceId } = await createKnowledgeTestApp({ role: "user" });
    const res = await request(app).get(listUrl(workspaceId)).query({ limit: 500 });
    expect(res.status).toBe(400);
  });
});

describe("GET /practice-cards/search — hydration & isolation", () => {
  it("hydrates vector hits back into full cards with scores", async () => {
    const { app, storage, workspaceId, setSearchResults } = await createKnowledgeTestApp({ role: "user" });
    const card = await seedCard(storage, workspaceId);
    setSearchResults([{ sourceId: card.id, score: 0.91 }]);

    const res = await request(app).get(searchUrl(workspaceId)).query({ q: "version pinning" });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].card.id).toBe(card.id);
    expect(res.body.data[0].score).toBe(0.91);
  });

  it("drops hits whose card belongs to another workspace", async () => {
    const { app, storage, workspaceId, setSearchResults } = await createKnowledgeTestApp({ role: "user" });
    const otherWs = await storage.createWorkspace({
      name: "Other",
      type: "local",
      path: "/tmp/other",
      branch: "main",
      status: "active",
      ownerId: "x",
    });
    const foreignCard = await seedCard(storage, otherWs.id);
    setSearchResults([{ sourceId: foreignCard.id, score: 0.99 }]);

    const res = await request(app).get(searchUrl(workspaceId)).query({ q: "anything" });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it("returns 503 (generic) when the embedding provider is unavailable", async () => {
    const { app, workspaceId } = await createKnowledgeTestApp({ role: "user", embedFails: true });
    const res = await request(app).get(searchUrl(workspaceId)).query({ q: "anything" });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain("embedding provider down");
  });
});
