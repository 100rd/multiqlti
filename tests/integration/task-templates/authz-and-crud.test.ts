/**
 * Integration tests for the /api/task-templates routes (BE7, §5.2):
 *   - authorizeTaskTemplate ordering 401 → 404 → 403 (byte-for-byte mirror of
 *     authorize-task-group); admin bypass; ownerless-denied to non-admins.
 *   - LIST own-filter (non-admin sees only own) + `created_by` stripped for
 *     non-admins / present for admins; MF-4 label filter returns only matching
 *     AND never enumerates another tenant's templates by label; keyset pagination.
 *   - CREATE stamps created_by from the session; invalid body → 400.
 *   - PATCH partial (≥1 field) bumps updated_at; DELETE → 204.
 *
 * Deterministic: MemStorage + supertest, no real CLI/network/DB.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTaskGroupTestApp } from "../../helpers/test-task-group-app.js";
import type { MemStorage } from "../../../server/storage.js";

async function seedTemplate(
  storage: MemStorage,
  createdBy: string | null,
  overrides: { name?: string; labels?: string[] } = {},
) {
  return storage.createTaskTemplate({
    name: overrides.name ?? "Summarize",
    description: "Summarize the input",
    executionMode: "direct_llm",
    modelSlug: "claude-sonnet",
    input: {},
    labels: overrides.labels ?? [],
    createdBy,
  });
}

// ─── authorizeTaskTemplate ordering (GET /:id) ──────────────────────────────

describe("task-templates authz — GET /api/task-templates/:id", () => {
  it("401 when unauthenticated (precedence over existence)", async () => {
    const { app, storage } = createTaskGroupTestApp();
    const t = await seedTemplate(storage, "test-user-id");
    const res = await request(app).get(`/api/task-templates/${t.id}`).set("x-test-unauth", "1");
    expect(res.status).toBe(401);
  });

  it("404 when the template does not exist", async () => {
    const { app } = createTaskGroupTestApp();
    const res = await request(app).get("/api/task-templates/ghost");
    expect(res.status).toBe(404);
  });

  it("403 when the caller is not the owner", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const t = await seedTemplate(storage, "someone-else");
    const res = await request(app).get(`/api/task-templates/${t.id}`);
    expect(res.status).toBe(403);
  });

  it("200 for the owner", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const t = await seedTemplate(storage, "me");
    const res = await request(app).get(`/api/task-templates/${t.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(t.id);
  });

  it("200 for an admin viewing another user's template (bypass)", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "boss", role: "admin" });
    const t = await seedTemplate(storage, "someone-else");
    const res = await request(app).get(`/api/task-templates/${t.id}`);
    expect(res.status).toBe(200);
  });

  it("403 on an ownerless template for a non-admin (STRICT)", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const t = await seedTemplate(storage, null);
    const res = await request(app).get(`/api/task-templates/${t.id}`);
    expect(res.status).toBe(403);
  });

  it("200 on an ownerless template for an admin", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "boss", role: "admin" });
    const t = await seedTemplate(storage, null);
    const res = await request(app).get(`/api/task-templates/${t.id}`);
    expect(res.status).toBe(200);
  });
});

// ─── LIST — own-filter, created_by strip, MF-4 label, keyset ────────────────

describe("task-templates LIST — GET /api/task-templates", () => {
  it("401 when unauthenticated", async () => {
    const { app } = createTaskGroupTestApp();
    const res = await request(app).get("/api/task-templates").set("x-test-unauth", "1");
    expect(res.status).toBe(401);
  });

  it("non-admin sees only own templates, created_by stripped", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    await seedTemplate(storage, "me", { name: "mine" });
    await seedTemplate(storage, "other", { name: "theirs" });
    const res = await request(app).get("/api/task-templates");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe("mine");
    expect(res.body.items[0]).not.toHaveProperty("createdBy");
  });

  it("admin sees all templates with created_by present", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "boss", role: "admin" });
    await seedTemplate(storage, "me");
    await seedTemplate(storage, "other");
    const res = await request(app).get("/api/task-templates");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toHaveProperty("createdBy");
  });

  it("label filter returns only matching OWN templates (MF-4 owner-before-label)", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    await seedTemplate(storage, "me", { name: "a", labels: ["research"] });
    await seedTemplate(storage, "me", { name: "b", labels: ["writing"] });
    // Another tenant's template carries the SAME label — must NOT be enumerable.
    await seedTemplate(storage, "other", { name: "secret", labels: ["research"] });
    const res = await request(app).get("/api/task-templates").query({ label: "research" });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe("a");
  });

  it("keyset pagination walks via nextCursor", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    for (let i = 0; i < 3; i++) await seedTemplate(storage, "me", { name: `t${i}` });
    const first = await request(app).get("/api/task-templates").query({ limit: 2 });
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await request(app)
      .get("/api/task-templates")
      .query({ limit: 2, cursor: first.body.nextCursor });
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(1);
    const seen = new Set([
      ...first.body.items.map((i: { id: string }) => i.id),
      ...second.body.items.map((i: { id: string }) => i.id),
    ]);
    expect(seen.size).toBe(3);
  });

  it("400 on a malformed cursor", async () => {
    const { app } = createTaskGroupTestApp({ userId: "me" });
    const res = await request(app).get("/api/task-templates").query({ cursor: "!!!not-base64!!!" });
    expect(res.status).toBe(400);
  });
});

// ─── CREATE ─────────────────────────────────────────────────────────────────

describe("task-templates CREATE — POST /api/task-templates", () => {
  it("201 stamps created_by from the session", async () => {
    const { app } = createTaskGroupTestApp({ userId: "me" });
    const res = await request(app)
      .post("/api/task-templates")
      .send({ name: "T", description: "d", executionMode: "direct_llm", input: {}, labels: ["x"] });
    expect(res.status).toBe(201);
    expect(res.body.createdBy).toBe("me");
    expect(res.body.labels).toEqual(["x"]);
  });

  it("400 on an invalid body (missing required name)", async () => {
    const { app } = createTaskGroupTestApp({ userId: "me" });
    const res = await request(app).post("/api/task-templates").send({ description: "d" });
    expect(res.status).toBe(400);
  });
});

// ─── PATCH / DELETE ─────────────────────────────────────────────────────────

describe("task-templates PATCH/DELETE", () => {
  it("PATCH partial updates a single field and bumps updated_at", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const t = await seedTemplate(storage, "me");
    const before = t.updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 2));
    const res = await request(app)
      .patch(`/api/task-templates/${t.id}`)
      .send({ description: "updated" });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe("updated");
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("PATCH 400 on an empty body (≥1 field required)", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const t = await seedTemplate(storage, "me");
    const res = await request(app).patch(`/api/task-templates/${t.id}`).send({});
    expect(res.status).toBe(400);
  });

  it("PATCH 403 on another owner's template", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const t = await seedTemplate(storage, "other");
    const res = await request(app).patch(`/api/task-templates/${t.id}`).send({ name: "x" });
    expect(res.status).toBe(403);
  });

  it("DELETE 204 for the owner", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const t = await seedTemplate(storage, "me");
    const res = await request(app).delete(`/api/task-templates/${t.id}`);
    expect(res.status).toBe(204);
    expect(await storage.getTaskTemplate(t.id)).toBeUndefined();
  });

  it("DELETE 403 on another owner's template", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const t = await seedTemplate(storage, "other");
    const res = await request(app).delete(`/api/task-templates/${t.id}`);
    expect(res.status).toBe(403);
  });
});
