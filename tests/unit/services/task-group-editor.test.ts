/**
 * Unit tests for server/services/task-group-editor.ts — the pending-only edit
 * orchestration (group fields, per-task fields, add/remove, dependsOn rewrite +
 * status recompute), DAG-validated and TOCTOU-guarded against a concurrent start.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../../../server/storage.js";
import {
  TaskGroupEditor,
  TaskGroupEditError,
} from "../../../server/services/task-group-editor.js";
import type { InsertTaskGroup, InsertTask, TaskStatus } from "@shared/schema";

async function seedGroup(
  storage: MemStorage,
  status: InsertTaskGroup["status"] = "pending",
) {
  const group = await storage.createTaskGroup({
    name: "G",
    description: "D",
    input: "obj",
    status,
    createdBy: "owner",
  } as InsertTaskGroup);
  return group;
}

async function seedTask(
  storage: MemStorage,
  groupId: string,
  name: string,
  opts: { dependsOn?: string[]; status?: TaskStatus; sortOrder?: number } = {},
) {
  return storage.createTask({
    groupId,
    name,
    description: "d",
    executionMode: "direct_llm",
    dependsOn: opts.dependsOn ?? [],
    input: {},
    status: opts.status ?? "ready",
    sortOrder: opts.sortOrder ?? 0,
  } as InsertTask);
}

describe("TaskGroupEditor.updateGroup", () => {
  let storage: MemStorage;
  let editor: TaskGroupEditor;
  beforeEach(() => {
    storage = new MemStorage();
    editor = new TaskGroupEditor(storage);
  });

  it("updates name/description/input on a pending group", async () => {
    const g = await seedGroup(storage, "pending");
    const updated = await editor.updateGroup(g.id, { name: "N", description: "DD", input: "new" });
    expect(updated.name).toBe("N");
    expect(updated.description).toBe("DD");
    expect(updated.input).toBe("new");
  });

  it("allows name/description relabel on a completed group", async () => {
    const g = await seedGroup(storage, "completed");
    const updated = await editor.updateGroup(g.id, { name: "relabel" });
    expect(updated.name).toBe("relabel");
  });

  it("409s when editing input on a completed group", async () => {
    const g = await seedGroup(storage, "completed");
    await expect(editor.updateGroup(g.id, { input: "nope" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("409s for ANY field when the group is running", async () => {
    const g = await seedGroup(storage, "running");
    await expect(editor.updateGroup(g.id, { name: "x" })).rejects.toMatchObject({ status: 409 });
  });

  it("404s for a missing group", async () => {
    await expect(editor.updateGroup("ghost", { name: "x" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("TaskGroupEditor.updateTask", () => {
  let storage: MemStorage;
  let editor: TaskGroupEditor;
  beforeEach(() => {
    storage = new MemStorage();
    editor = new TaskGroupEditor(storage);
  });

  it("updates a task's dependsOn and recomputes status to blocked", async () => {
    const g = await seedGroup(storage);
    const a = await seedTask(storage, g.id, "a", { status: "ready" });
    const b = await seedTask(storage, g.id, "b", { status: "ready" });
    const updated = await editor.updateTask(g.id, b.id, { dependsOn: [a.id] });
    expect(updated.dependsOn).toEqual([a.id]);
    expect(updated.status).toBe("blocked");
  });

  it("recomputes status to ready when dependsOn cleared", async () => {
    const g = await seedGroup(storage);
    const a = await seedTask(storage, g.id, "a");
    const b = await seedTask(storage, g.id, "b", { dependsOn: [a.id], status: "blocked" });
    const updated = await editor.updateTask(g.id, b.id, { dependsOn: [] });
    expect(updated.status).toBe("ready");
  });

  it("409s when the group is not pending", async () => {
    const g = await seedGroup(storage, "running");
    const a = await seedTask(storage, g.id, "a");
    await expect(editor.updateTask(g.id, a.id, { name: "x" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("404s when the task belongs to a different group (cross-group tamper)", async () => {
    const g1 = await seedGroup(storage);
    const g2 = await seedGroup(storage);
    const t = await seedTask(storage, g2.id, "a");
    await expect(editor.updateTask(g1.id, t.id, { name: "x" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("400s when an edit introduces a cycle", async () => {
    const g = await seedGroup(storage);
    const a = await seedTask(storage, g.id, "a");
    const b = await seedTask(storage, g.id, "b", { dependsOn: [a.id], status: "blocked" });
    // make a depend on b → cycle
    await expect(editor.updateTask(g.id, a.id, { dependsOn: [b.id] })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("400s when dependsOn references a task outside the group", async () => {
    const g = await seedGroup(storage);
    const a = await seedTask(storage, g.id, "a");
    await expect(editor.updateTask(g.id, a.id, { dependsOn: ["ghost"] })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("TaskGroupEditor.addTask", () => {
  let storage: MemStorage;
  let editor: TaskGroupEditor;
  beforeEach(() => {
    storage = new MemStorage();
    editor = new TaskGroupEditor(storage);
  });

  it("adds a ready task with sortOrder = max+1", async () => {
    const g = await seedGroup(storage);
    await seedTask(storage, g.id, "a", { sortOrder: 0 });
    await seedTask(storage, g.id, "b", { sortOrder: 1 });
    const created = await editor.addTask(g.id, { name: "c", description: "d" });
    expect(created.sortOrder).toBe(2);
    expect(created.status).toBe("ready");
  });

  it("adds a blocked task when it has deps", async () => {
    const g = await seedGroup(storage);
    const a = await seedTask(storage, g.id, "a");
    const created = await editor.addTask(g.id, { name: "c", description: "d", dependsOn: [a.id] });
    expect(created.status).toBe("blocked");
  });

  it("409s when the group is not pending", async () => {
    const g = await seedGroup(storage, "completed");
    await expect(editor.addTask(g.id, { name: "c", description: "d" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("400s when the new task depends on an unknown id", async () => {
    const g = await seedGroup(storage);
    await expect(
      editor.addTask(g.id, { name: "c", description: "d", dependsOn: ["ghost"] }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("TaskGroupEditor.removeTask", () => {
  let storage: MemStorage;
  let editor: TaskGroupEditor;
  beforeEach(() => {
    storage = new MemStorage();
    editor = new TaskGroupEditor(storage);
  });

  it("deletes the task and strips its id from siblings' dependsOn, recomputing status", async () => {
    const g = await seedGroup(storage);
    const a = await seedTask(storage, g.id, "a");
    const b = await seedTask(storage, g.id, "b", { dependsOn: [a.id], status: "blocked" });

    await editor.removeTask(g.id, a.id);

    const remaining = await storage.getTasksByGroup(g.id);
    expect(remaining.map((t) => t.id)).toEqual([b.id]);
    expect(remaining[0].dependsOn).toEqual([]);
    // b had only a as a dep → now unblocked → ready
    expect(remaining[0].status).toBe("ready");
  });

  it("keeps a sibling blocked when it still has remaining deps", async () => {
    const g = await seedGroup(storage);
    const a = await seedTask(storage, g.id, "a");
    const b = await seedTask(storage, g.id, "b");
    const c = await seedTask(storage, g.id, "c", { dependsOn: [a.id, b.id], status: "blocked" });

    await editor.removeTask(g.id, a.id);

    const cRow = (await storage.getTasksByGroup(g.id)).find((t) => t.id === c.id)!;
    expect(cRow.dependsOn).toEqual([b.id]);
    expect(cRow.status).toBe("blocked");
  });

  it("409s when the group is not pending", async () => {
    const g = await seedGroup(storage, "running");
    const a = await seedTask(storage, g.id, "a");
    await expect(editor.removeTask(g.id, a.id)).rejects.toMatchObject({ status: 409 });
  });

  it("404s when the task is not in the group", async () => {
    const g1 = await seedGroup(storage);
    const g2 = await seedGroup(storage);
    const t = await seedTask(storage, g2.id, "a");
    await expect(editor.removeTask(g1.id, t.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("TaskGroupEditError", () => {
  it("carries an http status code", () => {
    const e = new TaskGroupEditError(409, "conflict");
    expect(e.status).toBe(409);
    expect(e.message).toBe("conflict");
    expect(e).toBeInstanceOf(Error);
  });
});
