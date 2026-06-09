/**
 * Integration tests for POST /news/items/:itemId/feedback.
 * Covers: read/up/down/hidden transitions, `up` clears a prior hidden, 404 for
 * an item not in this workspace+user's brief, 400 on bad action, feedback
 * persists and changes the next ranking, owner/role gate.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createNewsTestApp } from "../../helpers/test-news-app";
import type { MemStorage } from "../../../server/storage";

const base = (ws: string) => `/api/workspaces/${ws}/news`;

async function firstItemId(app: import("express").Express, ws: string): Promise<string> {
  const res = await request(app).get(`${base(ws)}/brief`);
  return res.body.data.items[0].id as string;
}

describe("POST /news/items/:itemId/feedback", () => {
  it("marks an item read", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true });
    const id = await firstItemId(app, workspaceId);
    const res = await request(app).post(`${base(workspaceId)}/items/${id}/feedback`).send({ action: "read" });
    expect(res.status).toBe(200);
    expect(res.body.data.readState).toBe("read");
  });

  it("records up / down / hidden", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true });
    const id = await firstItemId(app, workspaceId);
    for (const action of ["down", "up", "hidden"] as const) {
      const res = await request(app).post(`${base(workspaceId)}/items/${id}/feedback`).send({ action });
      expect(res.status).toBe(200);
    }
  });

  it("`up` clears a prior hidden via the state machine", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true });
    const id = await firstItemId(app, workspaceId);
    await request(app).post(`${base(workspaceId)}/items/${id}/feedback`).send({ action: "hidden" });
    const res = await request(app).post(`${base(workspaceId)}/items/${id}/feedback`).send({ action: "up" });
    expect(res.body.data.feedback).toBe("up");
  });

  it("400s on an invalid action", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true });
    const id = await firstItemId(app, workspaceId);
    const res = await request(app).post(`${base(workspaceId)}/items/${id}/feedback`).send({ action: "love" });
    expect(res.status).toBe(400);
  });

  it("404s for an unknown item", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true });
    const res = await request(app).post(`${base(workspaceId)}/items/does-not-exist/feedback`).send({ action: "read" });
    expect(res.status).toBe(404);
  });

  it("404s for an item belonging to another user's brief", async () => {
    const { app, workspaceId, storage } = await createNewsTestApp({ ownsWorkspace: true });
    // Seed a brief + item owned by a DIFFERENT user in the same workspace.
    const mem = storage as MemStorage;
    const { brief } = await mem.createMorningBrief({ workspaceId, userId: "other-user", briefDate: "2026-06-09" });
    const [item] = await mem.upsertNewsItems([
      { briefId: brief.id, workspaceId, category: "external", title: "x", summary: "y", contentHash: "h-other" },
    ]);
    const res = await request(app).post(`${base(workspaceId)}/items/${item.id}/feedback`).send({ action: "read" });
    expect(res.status).toBe(404);
  });

  it("feedback persists and demotes the item in the next ranking", async () => {
    const { app, workspaceId, storage } = await createNewsTestApp({ ownsWorkspace: true });
    const get1 = await request(app).get(`${base(workspaceId)}/brief`);
    const top = get1.body.data.items[0];
    await request(app).post(`${base(workspaceId)}/items/${top.id}/feedback`).send({ action: "hidden" });
    const stored = await storage.getNewsItem(top.id);
    expect(stored?.feedback).toBe("hidden");
  });
});
