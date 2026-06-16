/**
 * Integration tests for the /api/task-groups routes:
 *   - C1 IDOR matrix: every per-id route × 401 / 404 / 403-non-owner / owner /
 *     admin / ownerless(createdBy==null deny non-admin) + the list-own filter.
 *   - C2/M3: cross-group taskId → 404 on every task-scoped route.
 *   - H2 edit guard: pending OK, running/terminal 409 per route; name/desc
 *     relabel allowed post-terminal.
 *   - M1: generic error envelope (no String(err) leak).
 *
 * Deterministic: MemStorage + supertest, no real CLI/network/DB.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTaskGroupTestApp } from "../../helpers/test-task-group-app.js";
import type { MemStorage } from "../../../server/storage.js";
import type { InsertTaskGroup, InsertTask, TaskGroupStatus } from "@shared/schema";

async function seedGroup(
  storage: MemStorage,
  createdBy: string | null,
  status: TaskGroupStatus = "pending",
) {
  return storage.createTaskGroup({
    name: "G",
    description: "D",
    input: "obj",
    status,
    createdBy,
  } as InsertTaskGroup);
}

async function seedTask(storage: MemStorage, groupId: string, name = "t") {
  return storage.createTask({
    groupId,
    name,
    description: "d",
    executionMode: "direct_llm",
    dependsOn: [],
    input: {},
    status: "ready",
    sortOrder: 0,
  } as InsertTask);
}

// ─── C1: per-id route IDOR matrix ──────────────────────────────────────────────

describe("task-groups IDOR — GET /api/task-groups/:id", () => {
  it("401 when unauthenticated", async () => {
    const { app, storage } = createTaskGroupTestApp();
    const g = await seedGroup(storage, "test-user-id");
    const res = await request(app).get(`/api/task-groups/${g.id}`).set("x-test-unauth", "1");
    expect(res.status).toBe(401);
  });

  it("404 when the group does not exist", async () => {
    const { app } = createTaskGroupTestApp();
    const res = await request(app).get("/api/task-groups/ghost");
    expect(res.status).toBe(404);
  });

  it("403 when the caller is not the owner", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const g = await seedGroup(storage, "someone-else");
    const res = await request(app).get(`/api/task-groups/${g.id}`);
    expect(res.status).toBe(403);
  });

  it("200 for the owner", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const g = await seedGroup(storage, "me");
    const res = await request(app).get(`/api/task-groups/${g.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(g.id);
  });

  it("200 for an admin viewing another user's group", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "boss", role: "admin" });
    const g = await seedGroup(storage, "someone-else");
    const res = await request(app).get(`/api/task-groups/${g.id}`);
    expect(res.status).toBe(200);
  });

  it("403 on an ownerless group for a non-admin", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const g = await seedGroup(storage, null);
    const res = await request(app).get(`/api/task-groups/${g.id}`);
    expect(res.status).toBe(403);
  });

  it("200 on an ownerless group for an admin", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "boss", role: "admin" });
    const g = await seedGroup(storage, null);
    const res = await request(app).get(`/api/task-groups/${g.id}`);
    expect(res.status).toBe(200);
  });
});

describe("task-groups IDOR — mutating per-id routes are all gated", () => {
  const routes: Array<{ method: "post" | "delete"; path: (id: string) => string }> = [
    { method: "post", path: (id) => `/api/task-groups/${id}/start` },
    { method: "post", path: (id) => `/api/task-groups/${id}/cancel` },
    { method: "delete", path: (id) => `/api/task-groups/${id}` },
  ];

  for (const r of routes) {
    it(`${r.method.toUpperCase()} ${r.path(":id")} → 403 for a non-owner`, async () => {
      const { app, storage } = createTaskGroupTestApp({ userId: "me" });
      const g = await seedGroup(storage, "someone-else");
      const res = await request(app)[r.method](r.path(g.id));
      expect(res.status).toBe(403);
    });

    it(`${r.method.toUpperCase()} ${r.path(":id")} → 401 unauth`, async () => {
      const { app, storage } = createTaskGroupTestApp({ userId: "me" });
      const g = await seedGroup(storage, "me");
      const res = await request(app)[r.method](r.path(g.id)).set("x-test-unauth", "1");
      expect(res.status).toBe(401);
    });

    it(`${r.method.toUpperCase()} ${r.path(":id")} → 404 missing`, async () => {
      const { app } = createTaskGroupTestApp({ userId: "me" });
      const res = await request(app)[r.method](r.path("ghost"));
      expect(res.status).toBe(404);
    });
  }
});

// ─── C1: list-own filter ──────────────────────────────────────────────────────

describe("GET /api/task-groups list — owner-scoped (C1)", () => {
  it("non-admin sees only their own groups and createdBy is hidden", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    await seedGroup(storage, "me");
    await seedGroup(storage, "someone-else");
    await seedGroup(storage, null);
    const res = await request(app).get("/api/task-groups");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].createdBy).toBeUndefined();
  });

  it("admin sees all groups with createdBy attribution", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "boss", role: "admin" });
    await seedGroup(storage, "me");
    await seedGroup(storage, "someone-else");
    await seedGroup(storage, null);
    const res = await request(app).get("/api/task-groups");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.some((g: { createdBy?: string }) => g.createdBy === "me")).toBe(true);
  });

  it("401 unauth on list", async () => {
    const { app } = createTaskGroupTestApp();
    const res = await request(app).get("/api/task-groups").set("x-test-unauth", "1");
    expect(res.status).toBe(401);
  });
});

// ─── C2 / M3: cross-group taskId → 404 ─────────────────────────────────────────

describe("task-scoped routes assert task ∈ group (C2/M3)", () => {
  it("retry: a taskId from a DIFFERENT group → 404", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const g1 = await seedGroup(storage, "me");
    const g2 = await seedGroup(storage, "me");
    const t = await seedTask(storage, g2.id);
    const res = await request(app).post(`/api/task-groups/${g1.id}/tasks/${t.id}/retry`);
    expect(res.status).toBe(404);
  });

  it("PATCH task: a taskId from a DIFFERENT group → 404", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const g1 = await seedGroup(storage, "me");
    const g2 = await seedGroup(storage, "me");
    const t = await seedTask(storage, g2.id);
    const res = await request(app)
      .patch(`/api/task-groups/${g1.id}/tasks/${t.id}`)
      .send({ name: "x" });
    expect(res.status).toBe(404);
  });

  it("DELETE task: a taskId from a DIFFERENT group → 404", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const g1 = await seedGroup(storage, "me");
    const g2 = await seedGroup(storage, "me");
    const t = await seedTask(storage, g2.id);
    const res = await request(app).delete(`/api/task-groups/${g1.id}/tasks/${t.id}`);
    expect(res.status).toBe(404);
  });

  it("retry: group is still owner-gated (non-owner → 403, not 404)", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const g = await seedGroup(storage, "someone-else");
    const t = await seedTask(storage, g.id);
    const res = await request(app).post(`/api/task-groups/${g.id}/tasks/${t.id}/retry`);
    expect(res.status).toBe(403);
  });
});

// ─── H2: edit guards ────────────────────────────────────────────────────────

describe("edit guard — PATCH group", () => {
  it("200 editing name/description/input on a pending group", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const g = await seedGroup(storage, "me", "pending");
    const res = await request(app)
      .patch(`/api/task-groups/${g.id}`)
      .send({ name: "N", description: "DD", input: "new" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("N");
    expect(res.body.tasks).toBeDefined();
  });

  it("409 editing input on a completed group, but name/desc relabel OK", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const g = await seedGroup(storage, "me", "completed");
    const blocked = await request(app).patch(`/api/task-groups/${g.id}`).send({ input: "x" });
    expect(blocked.status).toBe(409);
    const relabel = await request(app).patch(`/api/task-groups/${g.id}`).send({ name: "relabel" });
    expect(relabel.status).toBe(200);
    expect(relabel.body.name).toBe("relabel");
  });

  it("409 editing anything on a running group", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const g = await seedGroup(storage, "me", "running");
    const res = await request(app).patch(`/api/task-groups/${g.id}`).send({ name: "x" });
    expect(res.status).toBe(409);
  });

  it("400 when no field is supplied", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const g = await seedGroup(storage, "me", "pending");
    const res = await request(app).patch(`/api/task-groups/${g.id}`).send({});
    expect(res.status).toBe(400);
  });
});

describe("edit guard — task routes 409 on non-pending", () => {
  for (const status of ["running", "completed"] as const) {
    it(`PATCH task → 409 when group is ${status}`, async () => {
      const { app, storage } = createTaskGroupTestApp({ userId: "me" });
      const g = await seedGroup(storage, "me", status);
      const t = await seedTask(storage, g.id);
      const res = await request(app)
        .patch(`/api/task-groups/${g.id}/tasks/${t.id}`)
        .send({ name: "x" });
      expect(res.status).toBe(409);
    });

    it(`POST task → 409 when group is ${status}`, async () => {
      const { app, storage } = createTaskGroupTestApp({ userId: "me" });
      const g = await seedGroup(storage, "me", status);
      const res = await request(app)
        .post(`/api/task-groups/${g.id}/tasks`)
        .send({ name: "c", description: "d" });
      expect(res.status).toBe(409);
    });

    it(`DELETE task → 409 when group is ${status}`, async () => {
      const { app, storage } = createTaskGroupTestApp({ userId: "me" });
      const g = await seedGroup(storage, "me", status);
      const t = await seedTask(storage, g.id);
      const res = await request(app).delete(`/api/task-groups/${g.id}/tasks/${t.id}`);
      expect(res.status).toBe(409);
    });
  }
});

describe("edit happy paths on pending groups", () => {
  it("POST task adds and DELETE task removes, cleaning sibling deps", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const g = await seedGroup(storage, "me", "pending");
    const a = await seedTask(storage, g.id, "a");

    const add = await request(app)
      .post(`/api/task-groups/${g.id}/tasks`)
      .send({ name: "b", description: "d", dependsOn: [a.id] });
    expect(add.status).toBe(201);
    expect(add.body.status).toBe("blocked");

    const del = await request(app).delete(`/api/task-groups/${g.id}/tasks/${a.id}`);
    expect(del.status).toBe(204);

    const remaining = await storage.getTasksByGroup(g.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].dependsOn).toEqual([]);
    expect(remaining[0].status).toBe("ready");
  });

  it("PATCH task rejects a cycle with 400", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const g = await seedGroup(storage, "me", "pending");
    const a = await seedTask(storage, g.id, "a");
    const b = await storage.createTask({
      groupId: g.id,
      name: "b",
      description: "d",
      executionMode: "direct_llm",
      dependsOn: [a.id],
      input: {},
      status: "blocked",
      sortOrder: 1,
    } as InsertTask);
    const res = await request(app)
      .patch(`/api/task-groups/${g.id}/tasks/${a.id}`)
      .send({ dependsOn: [b.id] });
    expect(res.status).toBe(400);
  });
});

// ─── M1: error envelope never leaks internals ──────────────────────────────────

describe("M1 — generic error envelope", () => {
  it("409 body is a plain { error } string, not a stack/internal dump", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const g = await seedGroup(storage, "me", "running");
    const res = await request(app).patch(`/api/task-groups/${g.id}`).send({ name: "x" });
    expect(res.status).toBe(409);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error).not.toMatch(/at \w|Error:|\/server\//);
  });
});
