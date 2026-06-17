/**
 * BE2 — MemStorage executions (task-groups-v2 §3.2).
 *
 * MF-1: group is a MANDATORY scope key on every execution read — a wrong groupId
 * must resolve to "not found", never leak a cross-group row. Also covers
 * UNIQUE(iteration_id, task_id), updateExecution, task-delete SET NULL (SEC1:
 * historical executions survive a definition delete), and the lazy
 * virtual-iteration adapter (§8, MF-5).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../../server/storage.js";
import type { InsertTaskGroup } from "@shared/schema";

let storage: MemStorage;
let groupId: string;
let iterationId: string;
let taskId: string;

beforeEach(async () => {
  storage = new MemStorage();
  const g = await storage.createTaskGroup({ name: "g", description: "d", input: "i", createdBy: "owner-1" } as InsertTaskGroup);
  groupId = g.id;
  const t = await storage.createTask({ groupId, name: "t1", description: "d", sortOrder: 0 });
  taskId = t.id;
  const it = await storage.createIteration({ groupId, iterationNumber: 1, input: "i" });
  iterationId = it.id;
});

describe("MemStorage.createExecution", () => {
  it("creates an execution with defaults (status=pending)", async () => {
    const ex = await storage.createExecution({ iterationId, taskId, groupId });
    expect(ex.id).toBeTruthy();
    expect(ex.status).toBe("pending");
    expect(ex.iterationId).toBe(iterationId);
    expect(ex.groupId).toBe(groupId);
  });

  it("throws on UNIQUE(iteration_id, task_id) collision", async () => {
    await storage.createExecution({ iterationId, taskId, groupId });
    await expect(
      storage.createExecution({ iterationId, taskId, groupId }),
    ).rejects.toThrow(/already exists/i);
  });

  it("allows the same task in a different iteration", async () => {
    const it2 = await storage.createIteration({ groupId, iterationNumber: 2, input: "i" });
    await storage.createExecution({ iterationId, taskId, groupId });
    await expect(
      storage.createExecution({ iterationId: it2.id, taskId, groupId }),
    ).resolves.toBeDefined();
  });
});

describe("MemStorage.getExecutionsByIteration — MF-1 group scope", () => {
  it("returns executions for the iteration when group matches", async () => {
    await storage.createExecution({ iterationId, taskId, groupId });
    const rows = await storage.getExecutionsByIteration(groupId, iterationId);
    expect(rows).toHaveLength(1);
  });

  it("returns NOTHING when the groupId does not match (no cross-group leak)", async () => {
    await storage.createExecution({ iterationId, taskId, groupId });
    const rows = await storage.getExecutionsByIteration("attacker-group", iterationId);
    expect(rows).toEqual([]);
  });
});

describe("MemStorage.getExecution — MF-1 group scope", () => {
  it("returns the execution when group matches", async () => {
    const ex = await storage.createExecution({ iterationId, taskId, groupId });
    const found = await storage.getExecution(groupId, ex.id);
    expect(found?.id).toBe(ex.id);
  });

  it("returns undefined for a guessed id under the wrong group (IDOR closed)", async () => {
    const ex = await storage.createExecution({ iterationId, taskId, groupId });
    const found = await storage.getExecution("attacker-group", ex.id);
    expect(found).toBeUndefined();
  });

  it("returns undefined for an unknown id", async () => {
    expect(await storage.getExecution(groupId, "nope")).toBeUndefined();
  });
});

describe("MemStorage.updateExecution", () => {
  it("updates status/summary/output", async () => {
    const ex = await storage.createExecution({ iterationId, taskId, groupId });
    const done = await storage.updateExecution(ex.id, {
      status: "completed",
      summary: "did the thing",
      modelSlug: "claude-haiku-4-5",
    });
    expect(done.status).toBe("completed");
    expect(done.summary).toBe("did the thing");
    expect(done.modelSlug).toBe("claude-haiku-4-5");
  });

  it("throws for an unknown id", async () => {
    await expect(storage.updateExecution("ghost", { status: "failed" })).rejects.toThrow(/not found/i);
  });
});

describe("MemStorage SET NULL on task delete (SEC1 — history integrity)", () => {
  it("deleteTask PRESERVES historical executions and nulls their task_id", async () => {
    // The execution captures the definition name (denormalized at create time)
    // so history stays readable after the definition is gone.
    const ex = await storage.createExecution({ iterationId, taskId, taskName: "t1", groupId });
    await storage.deleteTask(taskId);

    // SEC1: the execution SURVIVES (immutable iteration history, §6/R2); only the
    // now-dangling task_id is nulled, and task_name is retained.
    const survivor = await storage.getExecution(groupId, ex.id);
    expect(survivor).toBeDefined();
    expect(survivor!.taskId).toBeNull();
    expect(survivor!.taskName).toBe("t1");
  });
});

describe("MemStorage.getVirtualIteration — lazy adapter (§8, MF-5)", () => {
  it("synthesizes iteration 1 + executions from legacy task columns when none exist", async () => {
    // Fresh pre-v2 group: legacy execution columns on `tasks`, no iteration rows.
    const legacy = await storage.createTaskGroup({
      name: "legacy",
      description: "d",
      input: "old prompt",
      status: "completed",
      createdBy: "owner-1",
      completedAt: new Date(),
    } as InsertTaskGroup);
    const lt = await storage.createTask({ groupId: legacy.id, name: "lt", description: "d", sortOrder: 0 });
    await storage.updateTask(lt.id, { status: "completed", summary: "legacy result", modelSlug: "claude-haiku-4-5" });

    const virtual = await storage.getVirtualIteration(legacy.id);
    expect(virtual).not.toBeNull();
    expect(virtual?.virtual).toBe(true);
    expect(virtual?.iteration.iterationNumber).toBe(1);
    expect(virtual?.iteration.status).toBe("completed");
    expect(virtual?.executions).toHaveLength(1);
    expect(virtual?.executions[0].summary).toBe("legacy result");
    expect(virtual?.executions[0].modelSlug).toBe("claude-haiku-4-5");
    expect(virtual?.executions[0].groupId).toBe(legacy.id);
  });

  it("returns null when the group already has a real iteration (reads those instead)", async () => {
    // The beforeEach group already has a real iteration 1.
    expect(await storage.getVirtualIteration(groupId)).toBeNull();
  });

  it("returns null for an unknown group", async () => {
    expect(await storage.getVirtualIteration("no-such-group")).toBeNull();
  });
});
