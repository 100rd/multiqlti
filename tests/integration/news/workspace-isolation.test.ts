/**
 * Integration tests for workspace + user isolation.
 * A brief/item created in one workspace (or for one user) must never be
 * readable or mutable through another workspace's route; cross-tenant ids 404.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createNewsTestApp } from "../../helpers/test-news-app";

const base = (ws: string) => `/api/workspaces/${ws}/news`;

describe("workspace + user isolation", () => {
  it("a feedback request via a different workspace path 404s on the item", async () => {
    const { app, workspaceId, storage } = await createNewsTestApp({ ownsWorkspace: true });
    // Seed a second workspace owned by the same user, with its own brief+item.
    const other = await storage.createWorkspace({
      name: "Other", type: "local", path: "/tmp/o", branch: "main", status: "active", ownerId: "test-user-id",
    });
    const { brief } = await storage.createMorningBrief({ workspaceId: other.id, userId: "test-user-id", briefDate: "2026-06-09" });
    const [item] = await storage.upsertNewsItems([
      { briefId: brief.id, workspaceId: other.id, category: "external", title: "t", summary: "s", contentHash: "h-iso" },
    ]);
    // Use the FIRST workspace's path to reach the OTHER workspace's item → 404.
    const res = await request(app).post(`${base(workspaceId)}/items/${item.id}/feedback`).send({ action: "read" });
    expect(res.status).toBe(404);
  });

  it("listing briefs only returns the requesting user's briefs", async () => {
    const { app, workspaceId, storage } = await createNewsTestApp({ ownsWorkspace: true });
    await request(app).get(`${base(workspaceId)}/brief`); // user's own brief
    await storage.createMorningBrief({ workspaceId, userId: "another-user", briefDate: "2026-06-09" });
    const res = await request(app).get(`${base(workspaceId)}/briefs`);
    expect(res.status).toBe(200);
    expect(res.body.data.every((b: { userId: string }) => b.userId === "test-user-id")).toBe(true);
  });

  it("a brief generated for one workspace is not visible from another", async () => {
    const a = await createNewsTestApp({ ownsWorkspace: true, userId: "u1" });
    await request(a.app).get(`${base(a.workspaceId)}/brief`);
    // Different workspace in the same storage, different id.
    const other = await a.storage.createWorkspace({
      name: "B", type: "local", path: "/tmp/b", branch: "main", status: "active", ownerId: "u1",
    });
    const res = await request(a.app).get(`${base(other.id)}/briefs`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(0);
  });
});
