/**
 * BE2 — MemStorage iterations (task-groups-v2 §3.1).
 *
 * createIteration / getIterations (keyset, iteration_number desc, limit clamp) /
 * getIteration / getLatestIteration / updateIteration / createIterationWithExecutions.
 * Asserts the EMULATED DB constraints: UNIQUE(group, number) collisions throw a
 * typed IterationConflictError, cascade delete removes children, atomic start is
 * all-or-nothing, and keyset paging yields no dupes/gaps.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage, IterationConflictError, TASK_GROUP_V2_MAX_LIMIT } from "../../server/storage.js";
import type { InsertTaskGroup } from "@shared/schema";

let storage: MemStorage;
let groupId: string;

beforeEach(async () => {
  storage = new MemStorage();
  const g = await storage.createTaskGroup({
    name: "g",
    description: "d",
    input: "the prompt",
    createdBy: "owner-1",
  } as InsertTaskGroup);
  groupId = g.id;
});

describe("MemStorage.createIteration", () => {
  it("creates an iteration with defaults (status=running) and generated id", async () => {
    const it = await storage.createIteration({ groupId, iterationNumber: 1, input: "the prompt" });
    expect(it.id).toBeTruthy();
    expect(it.groupId).toBe(groupId);
    expect(it.iterationNumber).toBe(1);
    expect(it.status).toBe("running");
    expect(it.input).toBe("the prompt");
    expect(it.createdAt).toBeInstanceOf(Date);
  });

  it("throws IterationConflictError on UNIQUE(group, number) collision", async () => {
    await storage.createIteration({ groupId, iterationNumber: 1, input: "x" });
    await expect(
      storage.createIteration({ groupId, iterationNumber: 1, input: "y" }),
    ).rejects.toBeInstanceOf(IterationConflictError);
  });

  it("allows the same iteration_number for a different group (scoped uniqueness)", async () => {
    const g2 = await storage.createTaskGroup({ name: "g2", description: "d", input: "i", createdBy: "owner-1" } as InsertTaskGroup);
    await storage.createIteration({ groupId, iterationNumber: 1, input: "x" });
    await expect(
      storage.createIteration({ groupId: g2.id, iterationNumber: 1, input: "x" }),
    ).resolves.toBeDefined();
  });
});

describe("MemStorage.getLatestIteration / getIteration", () => {
  it("returns the highest-numbered iteration", async () => {
    await storage.createIteration({ groupId, iterationNumber: 1, input: "x" });
    await storage.createIteration({ groupId, iterationNumber: 2, input: "x" });
    const latest = await storage.getLatestIteration(groupId);
    expect(latest?.iterationNumber).toBe(2);
  });

  it("returns undefined for a group with no iterations", async () => {
    expect(await storage.getLatestIteration(groupId)).toBeUndefined();
  });

  it("getIteration scopes by (group, number)", async () => {
    await storage.createIteration({ groupId, iterationNumber: 3, input: "x" });
    expect((await storage.getIteration(groupId, 3))?.iterationNumber).toBe(3);
    expect(await storage.getIteration("other-group", 3)).toBeUndefined();
    expect(await storage.getIteration(groupId, 99)).toBeUndefined();
  });
});

describe("MemStorage.getIterations — keyset pagination (iteration_number desc)", () => {
  beforeEach(async () => {
    for (let n = 1; n <= 5; n++) {
      await storage.createIteration({ groupId, iterationNumber: n, input: "x" });
    }
  });

  it("returns newest-first, bounded by limit", async () => {
    const page = await storage.getIterations(groupId, { limit: 2 });
    expect(page.map((i) => i.iterationNumber)).toEqual([5, 4]);
  });

  it("paginates with cursor without dupes or gaps", async () => {
    const page1 = await storage.getIterations(groupId, { limit: 2 });
    const page2 = await storage.getIterations(groupId, {
      limit: 2,
      cursor: { iterationNumber: page1[page1.length - 1].iterationNumber },
    });
    const page3 = await storage.getIterations(groupId, {
      limit: 2,
      cursor: { iterationNumber: page2[page2.length - 1].iterationNumber },
    });
    const all = [...page1, ...page2, ...page3].map((i) => i.iterationNumber);
    expect(all).toEqual([5, 4, 3, 2, 1]);
    expect(new Set(all).size).toBe(all.length); // no dupes
  });

  it("clamps limit to TASK_GROUP_V2_MAX_LIMIT", async () => {
    const page = await storage.getIterations(groupId, { limit: TASK_GROUP_V2_MAX_LIMIT + 50 });
    expect(page.length).toBeLessThanOrEqual(TASK_GROUP_V2_MAX_LIMIT);
  });

  it("scopes to the requested group only", async () => {
    const g2 = await storage.createTaskGroup({ name: "g2", description: "d", input: "i", createdBy: "x" } as InsertTaskGroup);
    await storage.createIteration({ groupId: g2.id, iterationNumber: 1, input: "x" });
    const page = await storage.getIterations(groupId, { limit: 100 });
    expect(page.every((i) => i.groupId === groupId)).toBe(true);
    expect(page).toHaveLength(5);
  });
});

describe("MemStorage.createIterationWithExecutions — atomic start (SF-1)", () => {
  it("inserts the iteration + all seed executions together", async () => {
    const t1 = await storage.createTask({ groupId, name: "t1", description: "d", sortOrder: 0 });
    const t2 = await storage.createTask({ groupId, name: "t2", description: "d", sortOrder: 1 });
    const { iteration, executions } = await storage.createIterationWithExecutions(
      groupId,
      { input: "the prompt", triggeredBy: "owner-1", iterationNumber: 1 },
      [
        { taskId: t1.id, status: "ready" },
        { taskId: t2.id, status: "blocked", modelSlug: "claude-haiku-4-5" },
      ],
    );
    expect(iteration.iterationNumber).toBe(1);
    expect(iteration.status).toBe("running");
    expect(executions).toHaveLength(2);
    const fetched = await storage.getExecutionsByIteration(groupId, iteration.id);
    expect(fetched).toHaveLength(2);
    expect(fetched.find((e) => e.taskId === t2.id)?.modelSlug).toBe("claude-haiku-4-5");
  });

  it("throws IterationConflictError on a duplicate number and writes NOTHING (all-or-nothing)", async () => {
    const t1 = await storage.createTask({ groupId, name: "t1", description: "d", sortOrder: 0 });
    await storage.createIteration({ groupId, iterationNumber: 1, input: "first" });
    await expect(
      storage.createIterationWithExecutions(
        groupId,
        { input: "second", iterationNumber: 1 },
        [{ taskId: t1.id, status: "ready" }],
      ),
    ).rejects.toBeInstanceOf(IterationConflictError);
    // The pre-existing iteration 1 has no executions: the failed start left none.
    const existing = await storage.getIteration(groupId, 1);
    expect(existing).toBeDefined();
    expect(await storage.getExecutionsByIteration(groupId, existing!.id)).toHaveLength(0);
  });
});

describe("MemStorage cascade delete — group removes its iterations", () => {
  it("deleteTaskGroup removes iterations and executions", async () => {
    const t1 = await storage.createTask({ groupId, name: "t1", description: "d", sortOrder: 0 });
    const { iteration } = await storage.createIterationWithExecutions(
      groupId,
      { input: "x", iterationNumber: 1 },
      [{ taskId: t1.id, status: "ready" }],
    );
    await storage.deleteTaskGroup(groupId);
    expect(await storage.getIteration(groupId, 1)).toBeUndefined();
    expect(await storage.getExecutionsByIteration(groupId, iteration.id)).toHaveLength(0);
  });
});

describe("MemStorage.updateIteration", () => {
  it("projects terminal status + completedAt", async () => {
    const it = await storage.createIteration({ groupId, iterationNumber: 1, input: "x" });
    const done = await storage.updateIteration(it.id, { status: "completed", completedAt: new Date() });
    expect(done.status).toBe("completed");
    expect(done.completedAt).toBeInstanceOf(Date);
  });

  it("throws for an unknown id", async () => {
    await expect(storage.updateIteration("ghost", { status: "failed" })).rejects.toThrow(/not found/i);
  });
});
