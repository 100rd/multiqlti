/**
 * completed-count.test.ts — bug #3: the `/api/task-groups` list route's
 * `completedCount` must reflect the LATEST ITERATION's EXECUTIONS, not the task
 * DEFINITION statuses (which stay blocked/ready, so a fully executed group used to
 * report 0/N). Drives the REAL route over MemStorage via the shared test app.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTaskGroupTestApp } from "../../helpers/test-task-group-app.js";

describe("GET /api/task-groups — completedCount (#3)", () => {
  it("counts the latest iteration's completed EXECUTIONS, not definition statuses", async () => {
    const { app, storage, userId } = createTaskGroupTestApp();

    // A group owned by the caller, with 3 task DEFINITIONS that stay non-completed
    // (the bug: their status is blocked/ready/pending even after a full run).
    const group = await storage.createTaskGroup({
      name: "consilium sdlc handoff",
      description: "d",
      input: "i",
      createdBy: userId,
    });
    const defs = [];
    for (let i = 0; i < 3; i++) {
      defs.push(await storage.createTask({ groupId: group.id, name: `t${i}`, description: "d", sortOrder: i }));
    }
    // The definitions remain non-completed — exactly the state that produced 0/N.
    for (const d of defs) expect(d.status).not.toBe("completed");

    // Latest iteration with 3 executions; 2 completed, 1 running.
    const iteration = await storage.createIteration({
      groupId: group.id,
      iterationNumber: 1,
      status: "running",
      input: "i",
    });
    await storage.createExecution({ groupId: group.id, iterationId: iteration.id, taskId: defs[0].id, taskName: "t0", status: "completed" });
    await storage.createExecution({ groupId: group.id, iterationId: iteration.id, taskId: defs[1].id, taskName: "t1", status: "completed" });
    await storage.createExecution({ groupId: group.id, iterationId: iteration.id, taskId: defs[2].id, taskName: "t2", status: "running" });

    const res = await request(app).get("/api/task-groups").expect(200);
    const row = (res.body as Array<{ id: string; taskCount: number; completedCount: number }>).find((r) => r.id === group.id);
    expect(row).toBeDefined();
    expect(row?.taskCount).toBe(3); // number of definitions
    expect(row?.completedCount).toBe(2); // completed EXECUTIONS in the latest iteration
  });

  it("reports 0 completed when there is no iteration yet (never started)", async () => {
    const { app, storage, userId } = createTaskGroupTestApp();
    const group = await storage.createTaskGroup({ name: "fresh", description: "d", input: "i", createdBy: userId });
    await storage.createTask({ groupId: group.id, name: "t", description: "d", sortOrder: 0 });

    const res = await request(app).get("/api/task-groups").expect(200);
    const row = (res.body as Array<{ id: string; taskCount: number; completedCount: number }>).find((r) => r.id === group.id);
    expect(row?.taskCount).toBe(1);
    expect(row?.completedCount).toBe(0);
  });
});
