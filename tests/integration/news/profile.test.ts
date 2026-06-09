/**
 * Integration tests for GET/PUT /news/profile.
 * Covers: default-create on first GET, PUT updates, strict validation (400),
 * no-passthrough, workspace 404, malformed-token 403, userId bound to req.user.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createNewsTestApp } from "../../helpers/test-news-app";

const base = (ws: string) => `/api/workspaces/${ws}/news`;

describe("GET /news/profile", () => {
  it("creates a default profile on first read", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true });
    const res = await request(app).get(`${base(workspaceId)}/profile`);
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe("sre");
    expect(Array.isArray(res.body.data.stack)).toBe(true);
  });

  it("404s for an unknown workspace", async () => {
    const { app } = await createNewsTestApp({ ownsWorkspace: true });
    const res = await request(app).get(`${base("nope")}/profile`);
    expect(res.status).toBe(404);
  });

  it("403s when the session has no user id", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true, noUserId: true });
    const res = await request(app).get(`${base(workspaceId)}/profile`);
    expect(res.status).toBe(403);
  });

  it("binds the profile to req.user.id", async () => {
    const { app, workspaceId, storage, userId } = await createNewsTestApp({ ownsWorkspace: true });
    await request(app).get(`${base(workspaceId)}/profile`);
    const stored = await storage.getNewsProfile(workspaceId, userId);
    expect(stored?.userId).toBe(userId);
  });
});

describe("PUT /news/profile", () => {
  it("updates role/stack/mutedCategories", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true });
    const res = await request(app)
      .put(`${base(workspaceId)}/profile`)
      .send({ role: "devops", stack: ["go", "terraform"], mutedCategories: ["external"] });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe("devops");
    expect(res.body.data.mutedCategories).toEqual(["external"]);
  });

  it("400s on an invalid role", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true });
    const res = await request(app).put(`${base(workspaceId)}/profile`).send({ role: "ceo", stack: [] });
    expect(res.status).toBe(400);
  });

  it("400s on unknown passthrough keys (strict schema)", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true });
    const res = await request(app)
      .put(`${base(workspaceId)}/profile`)
      .send({ role: "sre", stack: ["go"], userId: "attacker" });
    expect(res.status).toBe(400);
  });

  it("403s a non-owner without a qualifying role", async () => {
    const { app, workspaceId } = await createNewsTestApp({ role: "viewer" as never, ownsWorkspace: false });
    const res = await request(app).put(`${base(workspaceId)}/profile`).send({ role: "sre", stack: ["go"] });
    expect(res.status).toBe(403);
  });
});
