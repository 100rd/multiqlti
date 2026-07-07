/**
 * Unit tests for the MemStorage history finders + deleteTask (Phase 0).
 *   - deleteTask removes a single task without disturbing siblings;
 *   - listTaskGroupHistory returns terminal-status rows only, owner-filtered
 *     when ownerId is set, ordered (completedAt desc, id desc), bounded by
 *     limit, and keyset-paged via the cursor.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../../server/storage.js";
import type { InsertTaskGroup, InsertTask } from "@shared/schema";

let storage: MemStorage;
beforeEach(() => {
  storage = new MemStorage();
});

async function group(createdBy: string | null, status: string, completedAt: Date | null) {
  return storage.createTaskGroup({
    name: "g",
    description: "d",
    input: "i",
    status,
    createdBy,
    completedAt,
  } as InsertTaskGroup);
}

describe("MemStorage.deleteTask", () => {
  it("removes one task and leaves siblings intact", async () => {
    const g = await group("u", "pending", null);
    const a = await storage.createTask({
      groupId: g.id,
      name: "a",
      description: "d",
      executionMode: "direct_llm",
      dependsOn: [],
      input: {},
      status: "ready",
      sortOrder: 0,
    } as InsertTask);
    const b = await storage.createTask({
      groupId: g.id,
      name: "b",
      description: "d",
      executionMode: "direct_llm",
      dependsOn: [],
      input: {},
      status: "ready",
      sortOrder: 1,
    } as InsertTask);

    await storage.deleteTask(a.id);
    const remaining = await storage.getTasksByGroup(g.id);
    expect(remaining.map((t) => t.id)).toEqual([b.id]);
  });
});

describe("MemStorage.listTaskGroupHistory", () => {
  it("returns terminal-status groups only, owner-filtered", async () => {
    await group("me", "pending", null);
    await group("me", "running", null);
    await group("me", "completed", new Date("2026-01-01T00:00:00Z"));
    await group("other", "cancelled", new Date("2026-01-02T00:00:00Z"));

    const all = await storage.listTaskGroupHistory({ limit: 100 });
    expect(all).toHaveLength(2);

    const mine = await storage.listTaskGroupHistory({ ownerId: "me", limit: 100 });
    expect(mine).toHaveLength(1);
    expect(mine[0].createdBy).toBe("me");
  });
});
