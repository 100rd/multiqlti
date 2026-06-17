/**
 * Integration tests for the v2 iteration routes (BE6) over MemStorage + supertest.
 *
 *   - full IDOR matrix per route: owner 200 / non-owner 403 / unauth 401 /
 *     missing 404 / cross-group `:n` 404;
 *   - MF-2 metadata-only LIST vs owner-gated DETAIL: the list MUST NOT leak
 *     input/output/summary/error; the detail DOES expose them;
 *   - keyset pagination (iteration_number desc, opaque cursor);
 *   - MF-3 per-iteration trace gate + legacy `:id/trace` aliasing the latest;
 *   - DELETE-while-running → 409; start returns { group, iteration }.
 *
 * Deterministic: MemStorage + the shared task-group test app (no CLI/network/DB).
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTaskGroupTestApp } from "../../helpers/test-task-group-app.js";
import type { MemStorage } from "../../../server/storage.js";
import type {
  InsertTaskGroup,
  InsertTaskGroupIteration,
  InsertTaskExecution,
  InsertTaskTrace,
  TaskGroupRow,
  TaskGroupStatus,
} from "@shared/schema";

async function seedGroup(storage: MemStorage, createdBy: string | null, status: TaskGroupStatus = "completed") {
  return storage.createTaskGroup({
    name: "G",
    description: "D",
    input: "SECRET-OBJECTIVE",
    status,
    createdBy,
  } as InsertTaskGroup);
}

async function seedIteration(
  storage: MemStorage,
  groupId: string,
  iterationNumber: number,
  status: TaskGroupStatus = "completed",
) {
  const it = await storage.createIteration({
    groupId,
    iterationNumber,
    status,
    input: "SECRET-ITERATION-INPUT",
    triggeredBy: "owner-id",
  } as InsertTaskGroupIteration);
  await storage.updateIteration(it.id, {
    output: { summaries: "SECRET-OUTPUT-SUMMARIES" },
    startedAt: new Date(1000),
    completedAt: new Date(5000),
  });
  return storage.getIteration(groupId, iterationNumber);
}

async function seedExecution(
  storage: MemStorage,
  groupId: string,
  iterationId: string,
  taskId: string,
  status: TaskGroupStatus = "completed",
) {
  return storage.createExecution({
    iterationId,
    taskId,
    groupId,
    status,
    summary: "SECRET-EXEC-SUMMARY",
    errorMessage: "SECRET-EXEC-ERROR",
    output: { secret: true },
    modelSlug: "claude-sonnet",
  } as InsertTaskExecution);
}

/** A group owned by `me` with iteration 1 (1 completed execution). */
async function seedOwnedWithIteration(storage: MemStorage): Promise<{ group: TaskGroupRow; iterationId: string }> {
  const group = await seedGroup(storage, "me", "completed");
  const it = (await seedIteration(storage, group.id, 1))!;
  await seedExecution(storage, group.id, it.id, "task-1");
  return { group, iterationId: it.id };
}

// ─── IDOR matrix ────────────────────────────────────────────────────────────

const routes = [
  { name: "LIST", path: (id: string) => `/api/task-groups/${id}/iterations` },
  { name: "DETAIL", path: (id: string) => `/api/task-groups/${id}/iterations/1` },
  { name: "TRACE", path: (id: string) => `/api/task-groups/${id}/iterations/1/trace` },
];

describe("iteration routes — IDOR matrix", () => {
  for (const r of routes) {
    it(`${r.name} → 401 unauth`, async () => {
      const { app, storage } = createTaskGroupTestApp({ userId: "me" });
      const { group } = await seedOwnedWithIteration(storage);
      const res = await request(app).get(r.path(group.id)).set("x-test-unauth", "1");
      expect(res.status).toBe(401);
    });

    it(`${r.name} → 404 missing group`, async () => {
      const { app } = createTaskGroupTestApp({ userId: "me" });
      const res = await request(app).get(r.path("does-not-exist"));
      expect(res.status).toBe(404);
    });

    it(`${r.name} → 403 non-owner`, async () => {
      const { app, storage } = createTaskGroupTestApp({ userId: "me" });
      const other = await seedGroup(storage, "someone-else", "completed");
      await seedIteration(storage, other.id, 1);
      const res = await request(app).get(r.path(other.id));
      expect(res.status).toBe(403);
    });
  }

  it("DETAIL/TRACE → 404 for a cross-group iteration number that does not exist", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const { group } = await seedOwnedWithIteration(storage);
    expect((await request(app).get(`/api/task-groups/${group.id}/iterations/99`)).status).toBe(404);
    expect((await request(app).get(`/api/task-groups/${group.id}/iterations/99/trace`)).status).toBe(404);
  });
});

// ─── MF-2: metadata-only LIST vs owner-gated DETAIL ─────────────────────────

describe("iteration LIST is metadata-only (MF-2)", () => {
  it("never leaks input/output/summary/error/triggeredBy for a non-admin", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me", role: "user" });
    const { group } = await seedOwnedWithIteration(storage);

    const res = await request(app).get(`/api/task-groups/${group.id}/iterations`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const summary = res.body.items[0];

    // ALLOWLIST fields present.
    expect(summary.iterationNumber).toBe(1);
    expect(summary.status).toBe("completed");
    expect(summary.taskCount).toBe(1);
    expect(summary.completedCount).toBe(1);
    expect(summary).toHaveProperty("durationMs");

    // Forbidden fields ABSENT.
    expect(summary).not.toHaveProperty("input");
    expect(summary).not.toHaveProperty("output");
    expect(summary).not.toHaveProperty("summary");
    expect(summary).not.toHaveProperty("triggeredBy"); // admin-only
    const blob = JSON.stringify(res.body);
    expect(blob).not.toContain("SECRET-ITERATION-INPUT");
    expect(blob).not.toContain("SECRET-OUTPUT-SUMMARIES");
    expect(blob).not.toContain("SECRET-EXEC-SUMMARY");
  });

  it("exposes triggeredBy for an admin", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "admin", role: "admin" });
    const group = await seedGroup(storage, "someone-else", "completed");
    const it = (await seedIteration(storage, group.id, 1))!;
    await seedExecution(storage, group.id, it.id, "task-1");

    const res = await request(app).get(`/api/task-groups/${group.id}/iterations`);
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toHaveProperty("triggeredBy");
  });
});

describe("iteration DETAIL exposes execution detail (owner-gated)", () => {
  it("returns iteration + executions with summary/error/output/model_slug", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const { group } = await seedOwnedWithIteration(storage);

    const res = await request(app).get(`/api/task-groups/${group.id}/iterations/1`);
    expect(res.status).toBe(200);
    expect(res.body.iteration.iterationNumber).toBe(1);
    expect(res.body.executions).toHaveLength(1);
    const exec = res.body.executions[0];
    expect(exec.summary).toBe("SECRET-EXEC-SUMMARY");
    expect(exec.errorMessage).toBe("SECRET-EXEC-ERROR");
    expect(exec.modelSlug).toBe("claude-sonnet");
    expect(exec.output).toEqual({ secret: true });
  });
});

// ─── Keyset pagination ──────────────────────────────────────────────────────

describe("iteration LIST keyset pagination", () => {
  it("paginates iteration_number desc with an opaque cursor", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const group = await seedGroup(storage, "me", "completed");
    for (let n = 1; n <= 3; n++) await seedIteration(storage, group.id, n);

    const page1 = await request(app).get(`/api/task-groups/${group.id}/iterations?limit=2`);
    expect(page1.status).toBe(200);
    expect(page1.body.items.map((i: { iterationNumber: number }) => i.iterationNumber)).toEqual([3, 2]);
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await request(app).get(
      `/api/task-groups/${group.id}/iterations?limit=2&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.status).toBe(200);
    expect(page2.body.items.map((i: { iterationNumber: number }) => i.iterationNumber)).toEqual([1]);
    expect(page2.body.nextCursor).toBeNull();
  });

  it("400 on a malformed cursor", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const { group } = await seedOwnedWithIteration(storage);
    const res = await request(app).get(`/api/task-groups/${group.id}/iterations?cursor=not-base64`);
    expect(res.status).toBe(400);
  });
});

// ─── Pre-v2 virtual fallback (MF-5) ─────────────────────────────────────────

describe("iteration LIST virtual fallback (MF-5)", () => {
  it("synthesizes iteration 1 for a pre-v2 group with no real iterations", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const group = await seedGroup(storage, "me", "completed");
    // No iteration rows; one legacy task.
    await storage.createTask({
      groupId: group.id,
      name: "legacy",
      description: "d",
      executionMode: "direct_llm",
      dependsOn: [],
      input: {},
      status: "completed",
      sortOrder: 0,
    } as never);

    const res = await request(app).get(`/api/task-groups/${group.id}/iterations`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].iterationNumber).toBe(1);
    expect(res.body.items[0].taskCount).toBe(1);
  });
});

// ─── Legacy trace alias + per-iteration trace ───────────────────────────────

describe("iteration trace routes", () => {
  it("per-iteration trace returns the iteration-scoped trace", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const { group, iterationId } = await seedOwnedWithIteration(storage);
    await storage.createTaskTrace({
      groupId: group.id,
      iterationId,
      traceId: "trace-iter-1",
      rootSpan: null,
      spans: [],
      totalDurationMs: 0,
      totalTokens: 0,
      totalCostUsd: 0,
    } as InsertTaskTrace);

    const res = await request(app).get(`/api/task-groups/${group.id}/iterations/1/trace`);
    expect(res.status).toBe(200);
    expect(res.body.traceId).toBe("trace-iter-1");
  });

  it("legacy /:id/trace aliases the LATEST iteration's trace", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const group = await seedGroup(storage, "me", "completed");
    const it1 = (await seedIteration(storage, group.id, 1))!;
    const it2 = (await seedIteration(storage, group.id, 2))!;
    await storage.createTaskTrace({
      groupId: group.id, iterationId: it1.id, traceId: "trace-1",
      rootSpan: null, spans: [], totalDurationMs: 0, totalTokens: 0, totalCostUsd: 0,
    } as InsertTaskTrace);
    await storage.createTaskTrace({
      groupId: group.id, iterationId: it2.id, traceId: "trace-2-latest",
      rootSpan: null, spans: [], totalDurationMs: 0, totalTokens: 0, totalCostUsd: 0,
    } as InsertTaskTrace);

    const res = await request(app).get(`/api/task-groups/${group.id}/trace`);
    expect(res.status).toBe(200);
    expect(res.body.traceId).toBe("trace-2-latest");
  });
});

// ─── start { group, iteration } + DELETE-while-running ──────────────────────

describe("start + delete lifecycle", () => {
  it("POST /start responds with { group, iteration }", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const group = await seedGroup(storage, "me", "pending");
    await storage.createTask({
      groupId: group.id,
      name: "t",
      description: "d",
      executionMode: "direct_llm",
      dependsOn: [],
      input: {},
      status: "ready",
      sortOrder: 0,
    } as never);

    const res = await request(app).post(`/api/task-groups/${group.id}/start`);
    expect(res.status).toBe(200);
    expect(res.body.group).toBeDefined();
    expect(res.body.iteration).toBeDefined();
    expect(res.body.iteration.iterationNumber).toBe(1);
  });

  it("DELETE → 409 while the latest iteration is running", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const group = await seedGroup(storage, "me", "running");
    await seedIteration(storage, group.id, 1, "running");

    const res = await request(app).delete(`/api/task-groups/${group.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Cancel the running iteration first");
  });

  it("DELETE → 204 when the latest iteration is terminal", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const { group } = await seedOwnedWithIteration(storage);
    const res = await request(app).delete(`/api/task-groups/${group.id}`);
    expect(res.status).toBe(204);
  });
});
