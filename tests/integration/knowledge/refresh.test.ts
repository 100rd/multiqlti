/**
 * Integration tests for the refresh endpoints + scheduler.
 * Covers: auth gating, 202 + refreshRunId, a completed report row, the CRITICAL
 * no-status-mutation invariant (stale/superseded cards stay status='active'),
 * pending_review HINT applied, and refresh-runs GET 200/404 + cross-workspace 404.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createKnowledgeTestApp } from "../../helpers/test-knowledge-app";
import type { MemStorage } from "../../../server/storage";

const NINETY_ONE_DAYS = 91 * 24 * 60 * 60 * 1000;

async function seedActive(
  storage: MemStorage,
  workspaceId: string,
  overrides: Record<string, unknown> = {},
) {
  return storage.createPracticeCard({
    workspaceId,
    topic: "terraform-module-best-practices",
    statement: "Statement " + Math.random().toString(36).slice(2),
    rationale: "Rationale.",
    appliesTo: { tool: "terraform" },
    sources: [],
    confidence: 0.6,
    status: "active",
    ingestedBy: "researcher",
    ingestedByUserId: "u1",
    reviewState: "accepted",
    contentHash: "h-" + Math.random().toString(36).slice(2),
    ...overrides,
  });
}

function refreshUrl(ws: string) {
  return `/api/workspaces/${ws}/knowledge/practice-cards/refresh`;
}
function runUrl(ws: string, runId: string) {
  return `/api/workspaces/${ws}/knowledge/practice-cards/refresh-runs/${runId}`;
}

describe("POST /refresh — auth", () => {
  it("rejects a plain user with 403", async () => {
    const { app, workspaceId } = await createKnowledgeTestApp({ role: "user" });
    const res = await request(app).post(refreshUrl(workspaceId)).send({});
    expect(res.status).toBe(403);
  });

  it("404s on an unknown workspace", async () => {
    const { app } = await createKnowledgeTestApp({ role: "admin" });
    const res = await request(app).post(refreshUrl("nope")).send({});
    expect(res.status).toBe(404);
  });
});

describe("POST /refresh — happy path", () => {
  it("returns 202 with a refreshRunId and writes a completed report row", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "admin" });
    await seedActive(storage, workspaceId, { lastVerifiedAt: new Date() });

    const res = await request(app).post(refreshUrl(workspaceId)).send({});
    expect(res.status).toBe(202);
    const runId = res.body.data.refreshRunId;
    expect(typeof runId).toBe("string");

    const run = await storage.getRefreshRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.report).toMatchObject({ unchangedCount: 1 });
  });

  it("CRITICAL: stale cards keep status='active' (no source mutation), only a review HINT", async () => {
    const { app, storage, workspaceId } = await createKnowledgeTestApp({ role: "admin" });
    const stale = await seedActive(storage, workspaceId, {
      lastVerifiedAt: new Date(Date.now() - NINETY_ONE_DAYS),
      reviewState: "accepted",
    });

    const res = await request(app).post(refreshUrl(workspaceId)).send({});
    expect(res.status).toBe(202);

    const after = await storage.getPracticeCard(stale.id);
    expect(after?.status).toBe("active"); // never mutated
    expect(after?.reviewState).toBe("pending_review"); // queue hint only

    const run = await storage.getRefreshRun(res.body.data.refreshRunId);
    expect((run?.report as { stale: string[] }).stale).toContain(stale.id);
  });
});

describe("GET /refresh-runs/:runId", () => {
  it("returns 200 for a run in the workspace", async () => {
    const { app, storage, workspaceId, refreshScheduler } = await createKnowledgeTestApp({ role: "user" });
    await seedActive(storage, workspaceId, { lastVerifiedAt: new Date() });
    const runId = await refreshScheduler.triggerNow(workspaceId);
    const res = await request(app).get(runUrl(workspaceId, runId));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(runId);
  });

  it("404s for an unknown run id", async () => {
    const { app, workspaceId } = await createKnowledgeTestApp({ role: "user" });
    const res = await request(app).get(runUrl(workspaceId, "no-such-run"));
    expect(res.status).toBe(404);
  });

  it("404s for a run that belongs to another workspace", async () => {
    const { app, storage, workspaceId, refreshScheduler } = await createKnowledgeTestApp({ role: "user" });
    const otherWs = await storage.createWorkspace({
      name: "Other",
      type: "local",
      path: "/tmp/other",
      branch: "main",
      status: "active",
      ownerId: "x",
    });
    const foreignRunId = await refreshScheduler.triggerNow(otherWs.id);
    const res = await request(app).get(runUrl(workspaceId, foreignRunId));
    expect(res.status).toBe(404);
  });
});
