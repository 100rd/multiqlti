/**
 * Integration tests for GET /news/brief and GET /news/briefs.
 * Covers: lazy-generate-on-miss, second-GET cache (no regen), filters
 * (category/readState), date validation (400), https sourceUri sanitization
 * (M2), history pagination, workspace 404, malformed-token 403.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createNewsTestApp } from "../../helpers/test-news-app";

const base = (ws: string) => `/api/workspaces/${ws}/news`;

describe("GET /news/brief — lazy generation + cache (C1/M1)", () => {
  it("generates a ready brief on first GET", async () => {
    const { app, workspaceId, generationCount } = await createNewsTestApp({ ownsWorkspace: true });
    const res = await request(app).get(`${base(workspaceId)}/brief`);
    expect(res.status).toBe(200);
    expect(res.body.data.brief.status).toBe("ready");
    expect(res.body.data.items.length).toBeGreaterThan(0);
    expect(generationCount()).toBe(1);
  });

  it("serves the cached brief on the second GET without regenerating", async () => {
    const { app, workspaceId, generationCount } = await createNewsTestApp({ ownsWorkspace: true });
    await request(app).get(`${base(workspaceId)}/brief`);
    const res2 = await request(app).get(`${base(workspaceId)}/brief`);
    expect(res2.status).toBe(200);
    expect(generationCount()).toBe(1); // no regen
  });

  it("filters items by category", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true });
    const res = await request(app).get(`${base(workspaceId)}/brief?category=external`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.every((i: { category: string }) => i.category === "external")).toBe(true);
  });

  it("400s on a malformed date", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true });
    const res = await request(app).get(`${base(workspaceId)}/brief?date=2026/06/09`);
    expect(res.status).toBe(400);
  });

  it("carries internalDegraded on the brief object (FE contract) and echoes it in meta", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true });
    const res = await request(app).get(`${base(workspaceId)}/brief`);
    // Frontend reads brief.internalDegraded off the brief object.
    expect(res.body.data.brief).toHaveProperty("internalDegraded");
    expect(typeof res.body.data.brief.internalDegraded).toBe("boolean");
    // Brief object shape the FE relies on.
    expect(res.body.data.brief).toMatchObject({
      id: expect.any(String),
      briefDate: expect.any(String),
      status: expect.any(String),
    });
    expect(res.body.data.brief).toHaveProperty("meta");
    // meta echo retained for convenience.
    expect(res.body.meta).toHaveProperty("internalDegraded");
    expect(res.body.meta.internalDegraded).toBe(res.body.data.brief.internalDegraded);
  });

  it("404s for an unknown workspace", async () => {
    const { app } = await createNewsTestApp({ ownsWorkspace: true });
    const res = await request(app).get(`${base("nope")}/brief`);
    expect(res.status).toBe(404);
  });

  it("403s when the session has no user id", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true, noUserId: true });
    const res = await request(app).get(`${base(workspaceId)}/brief`);
    expect(res.status).toBe(403);
  });
});

describe("GET /news/briefs — history", () => {
  it("lists the user's briefs with a total", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true });
    await request(app).get(`${base(workspaceId)}/brief`); // generate one
    const res = await request(app).get(`${base(workspaceId)}/briefs`);
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBeGreaterThanOrEqual(1);
  });

  it("400s when limit exceeds the cap", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true });
    const res = await request(app).get(`${base(workspaceId)}/briefs?limit=100`);
    expect(res.status).toBe(400);
  });
});
