/**
 * QA blocking deliverable — Mem/Pg storage PARITY harness (task-groups-v2 §12.3).
 *
 * ONE shared case table run against BOTH MemStorage and PgStorage. The PG project
 * is gated behind `describe.skipIf(!process.env.DATABASE_URL)` so unit/integration
 * CI stays DB-free; the harness EXISTING is the deliverable, and it runs for real
 * against a Postgres when DATABASE_URL is set.
 *
 * It exercises the DB-ENFORCED behaviors the v2 design relies on (so MemStorage's
 * emulation is held to the same contract as Postgres):
 *  - UNIQUE(group_id, iteration_number)             → IterationConflictError
 *  - UNIQUE(iteration_id, task_id)                  → throws
 *  - cascade delete (group → iterations/executions) → children removed
 *  - label containment filter                        → jsonb `@>` parity with `.includes`
 *  - keyset ordering (iteration_number desc)        → identical page shape
 */
import { describe, it, expect } from "vitest";
import { MemStorage, IterationConflictError } from "../../../server/storage.js";
import type { IStorage } from "../../../server/storage.js";
import type { InsertTaskGroup } from "../../../shared/schema.js";

const HAS_DATABASE = Boolean(process.env.DATABASE_URL);

/** A short unique suffix so PG runs (shared DB) don't collide across cases. */
function uniq(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The shared case table. Each case is self-contained: it creates its own group +
 * tasks, asserts the behavior, and tears down via cascade so the harness is safe
 * to run repeatedly against a persistent Postgres. Owners are left null where
 * possible (FK→users onDelete:set null) to avoid seeding user rows.
 */
function runParityCases(label: string, makeStorage: () => IStorage): void {
  describe(`storage parity — ${label}`, () => {
    async function freshGroup(storage: IStorage): Promise<string> {
      const g = await storage.createTaskGroup({
        name: `parity-${uniq()}`,
        description: "d",
        input: "the prompt",
        createdBy: null,
      } as InsertTaskGroup);
      return g.id;
    }

    it("enforces UNIQUE(group_id, iteration_number) → IterationConflictError", async () => {
      const storage = makeStorage();
      const groupId = await freshGroup(storage);
      try {
        await storage.createIteration({ groupId, iterationNumber: 1, input: "x" });
        await expect(
          storage.createIteration({ groupId, iterationNumber: 1, input: "y" }),
        ).rejects.toBeInstanceOf(IterationConflictError);
      } finally {
        await storage.deleteTaskGroup(groupId);
      }
    });

    it("enforces UNIQUE(iteration_id, task_id) → throws on a duplicate execution", async () => {
      const storage = makeStorage();
      const groupId = await freshGroup(storage);
      try {
        const task = await storage.createTask({ groupId, name: "t", description: "d", sortOrder: 0 });
        const it = await storage.createIteration({ groupId, iterationNumber: 1, input: "x" });
        await storage.createExecution({ iterationId: it.id, taskId: task.id, groupId });
        await expect(
          storage.createExecution({ iterationId: it.id, taskId: task.id, groupId }),
        ).rejects.toThrow();
      } finally {
        await storage.deleteTaskGroup(groupId);
      }
    });

    it("cascade-deletes iterations + executions when the group is deleted", async () => {
      const storage = makeStorage();
      const groupId = await freshGroup(storage);
      const task = await storage.createTask({ groupId, name: "t", description: "d", sortOrder: 0 });
      const { iteration } = await storage.createIterationWithExecutions(
        groupId,
        { input: "x", iterationNumber: 1 },
        [{ taskId: task.id, status: "ready" }],
      );
      // Sanity: the execution is readable before delete.
      expect(await storage.getExecutionsByIteration(groupId, iteration.id)).toHaveLength(1);

      await storage.deleteTaskGroup(groupId);

      expect(await storage.getIteration(groupId, 1)).toBeUndefined();
      expect(await storage.getExecutionsByIteration(groupId, iteration.id)).toHaveLength(0);
    });

    it("MF-1: getExecution under the wrong group resolves to not-found (no leak)", async () => {
      const storage = makeStorage();
      const groupId = await freshGroup(storage);
      const otherGroupId = await freshGroup(storage);
      try {
        const task = await storage.createTask({ groupId, name: "t", description: "d", sortOrder: 0 });
        const it = await storage.createIteration({ groupId, iterationNumber: 1, input: "x" });
        const ex = await storage.createExecution({ iterationId: it.id, taskId: task.id, groupId });
        expect(await storage.getExecution(groupId, ex.id)).toBeDefined();
        expect(await storage.getExecution(otherGroupId, ex.id)).toBeUndefined();
      } finally {
        await storage.deleteTaskGroup(groupId);
        await storage.deleteTaskGroup(otherGroupId);
      }
    });

    it("label containment filter selects only templates carrying the label", async () => {
      const storage = makeStorage();
      const labelA = `pa-${uniq()}`;
      const labelB = `pb-${uniq()}`;
      const hit = await storage.createTaskTemplate({ name: "hit", description: "d", createdBy: null, labels: [labelA] });
      const miss = await storage.createTaskTemplate({ name: "miss", description: "d", createdBy: null, labels: [labelB] });
      try {
        const rows = await storage.getTaskTemplates({ isAdmin: true, label: labelA, limit: 100 });
        const names = rows.map((t) => t.name);
        expect(names).toContain("hit");
        expect(names).not.toContain("miss");
      } finally {
        await storage.deleteTaskTemplate(hit.id);
        await storage.deleteTaskTemplate(miss.id);
      }
    });

    it("keyset ordering (iteration_number desc) is identical page shape", async () => {
      const storage = makeStorage();
      const groupId = await freshGroup(storage);
      try {
        for (let n = 1; n <= 4; n++) {
          await storage.createIteration({ groupId, iterationNumber: n, input: "x" });
        }
        const page1 = await storage.getIterations(groupId, { limit: 2 });
        expect(page1.map((i) => i.iterationNumber)).toEqual([4, 3]);
        const page2 = await storage.getIterations(groupId, {
          limit: 2,
          cursor: { iterationNumber: page1[page1.length - 1].iterationNumber },
        });
        expect(page2.map((i) => i.iterationNumber)).toEqual([2, 1]);
      } finally {
        await storage.deleteTaskGroup(groupId);
      }
    });
  });
}

// MemStorage: always runs (DB-free).
runParityCases("MemStorage", () => new MemStorage());

// PgStorage: registered only when DATABASE_URL is set. `await import` keeps `./db`
// (which eagerly builds a pg Pool) out of the DB-free import path. When unset, the
// whole block is skipped — the harness existing is the deliverable.
describe.skipIf(!HAS_DATABASE)("storage parity — PgStorage gate", async () => {
  const { PgStorage } = await import("../../../server/storage-pg.js");
  runParityCases("PgStorage", () => new PgStorage());
});
