/**
 * Integration tests for GET .../practice-cards/compliance.
 * Covers: happy mapping with an injected graph, only active cards are mapped,
 * a malformed/disabled graph degrades to 200 (all-empty, never 500), an empty
 * active set yields an empty list, and any authenticated user can read.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createKnowledgeTestApp } from "../../helpers/test-knowledge-app";
import type { MemStorage } from "../../../server/storage";
import type { ComplianceGraph } from "../../../server/knowledge/compliance-mapper";

const GRAPH: ComplianceGraph = {
  nodes: [
    { id: "backend", label: "remote state backend", source_file: "live/prod/backend.tf" },
    { id: "mod", label: "network module", source_file: "modules/network/main.tf" },
    { id: "readme", label: "README", source_file: "README.md" },
  ],
};

async function seedActive(
  storage: MemStorage,
  workspaceId: string,
  overrides: Record<string, unknown> = {},
) {
  return storage.createPracticeCard({
    workspaceId,
    topic: "terraform-module-best-practices",
    statement: "Use a remote state backend with locking.",
    rationale: "Prevents concurrent state corruption.",
    appliesTo: { tool: "terraform", tags: ["state", "backend"] },
    sources: [],
    confidence: 0.8,
    status: "active",
    ingestedBy: "researcher",
    ingestedByUserId: "u1",
    reviewState: "accepted",
    contentHash: "h-" + Math.random().toString(36).slice(2),
    ...overrides,
  });
}

function complianceUrl(ws: string) {
  return `/api/workspaces/${ws}/knowledge/practice-cards/compliance`;
}

describe("GET /compliance", () => {
  it("maps active terraform cards against the injected graph (any authed user)", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "user", complianceGraph: GRAPH });
    const card = await seedActive(storage, workspaceId);
    const res = await request(app).get(complianceUrl(workspaceId));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].cardId).toBe(card.id);
    const followedFiles = res.body.data[0].followed.map((n: { source_file: string }) => n.source_file);
    expect(followedFiles).toContain("live/prod/backend.tf");
  });

  it("excludes non-active cards", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "user", complianceGraph: GRAPH });
    await seedActive(storage, workspaceId, { status: "superseded" });
    await seedActive(storage, workspaceId, { status: "active" });
    const res = await request(app).get(complianceUrl(workspaceId));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("degrades to 200 with all-empty entries when the graph is disabled/malformed (null)", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "user", complianceGraph: null });
    const card = await seedActive(storage, workspaceId);
    const res = await request(app).get(complianceUrl(workspaceId));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].cardId).toBe(card.id);
    expect(res.body.data[0].followed).toEqual([]);
    expect(res.body.data[0].unknown).toEqual([]);
  });

  it("returns an empty list when there are no active cards", async () => {
    const { app, workspaceId } = await createKnowledgeTestApp({ role: "user", complianceGraph: GRAPH });
    const res = await request(app).get(complianceUrl(workspaceId));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("404s on an unknown workspace", async () => {
    const { app } = await createKnowledgeTestApp({ role: "user", complianceGraph: GRAPH });
    const res = await request(app).get(complianceUrl("nope"));
    expect(res.status).toBe(404);
  });

  it("one entry per active card", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "user", complianceGraph: GRAPH });
    await seedActive(storage, workspaceId);
    await seedActive(storage, workspaceId);
    await seedActive(storage, workspaceId);
    const res = await request(app).get(complianceUrl(workspaceId));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });
});
