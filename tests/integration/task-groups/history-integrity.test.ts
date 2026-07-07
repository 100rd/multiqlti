/**
 * SEC1 (history-integrity) + H1 route integration for Task Groups v2.
 *
 *   SEC1 — removing a task DEFINITION between runs must NOT destroy that task's
 *          historical executions. After delete, iteration-1 executions SURVIVE
 *          with `task_name` populated and `task_id` nulled (ON DELETE SET NULL),
 *          and the group stays runnable.
 *   H1    — POST /start on a 0-task group → 400, no iteration created, group not
 *          left running.
 *
 * Deterministic: the shared task-group test app (MemStorage + real orchestrator
 * with a scripted gateway) over supertest. No CLI/network/DB.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTaskGroupTestApp } from "../../helpers/test-task-group-app.js";
import type { Gateway } from "../../../server/gateway/index.js";
import type { GatewayResponse } from "../../../shared/types.js";
import { TaskOrchestrator } from "../../../server/services/task-orchestrator.js";
import type { WsManager } from "../../../server/ws/manager.js";
import { MemStorage } from "../../../server/storage.js";

function okGateway(): Gateway {
  const respond = async (): Promise<GatewayResponse> => ({
    content: JSON.stringify({ summary: "ok", output: { ok: true } }),
    tokensUsed: 1,
    modelSlug: "claude-sonnet",
    finishReason: "stop",
  });
  return {
    complete: respond,
    completeStreaming: respond,
  } as unknown as Gateway;
}

function makeOrchestrator(storage: MemStorage): TaskOrchestrator {
  const wsManager = { broadcastToRun: () => {} } as unknown as WsManager;
  return new TaskOrchestrator(storage, wsManager, okGateway());
}

describe("SEC1 — removing a definition preserves historical executions", () => {
  it("iteration-1 executions survive a definition delete with task_name + null task_id", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const orchestrator = makeOrchestrator(storage);

    // Create a 2-task group via the orchestrator (so the real seed path runs).
    const { group, tasks } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [
        { name: "Keep", description: "k", executionMode: "direct_llm" },
        { name: "Drop", description: "x", executionMode: "direct_llm" },
      ],
      createdBy: "me",
    });
    const drop = tasks.find((t) => t.name === "Drop")!;

    // Run iteration 1 — both tasks get an execution row.
    const { iteration } = await orchestrator.startGroup(group.id);
    const before = await storage.getExecutionsByIteration(group.id, iteration.id);
    expect(before).toHaveLength(2);
    const dropExecBefore = before.find((e) => e.taskId === drop.id)!;
    expect(dropExecBefore.taskName).toBe("Drop");

    // Remove the "Drop" definition between runs (editable when not running).
    const del = await request(app).delete(`/api/task-groups/${group.id}/tasks/${drop.id}`);
    expect(del.status).toBe(204);

    // Iteration-1 executions SURVIVE: 2 rows, the dropped one keeps task_name +
    // has a null task_id.
    const after = await storage.getExecutionsByIteration(group.id, iteration.id);
    expect(after).toHaveLength(2);
    const survivor = after.find((e) => e.taskName === "Drop");
    expect(survivor).toBeDefined();
    expect(survivor!.taskId).toBeNull();
    expect(survivor!.status).toBe("completed");

    // The group is still runnable (the surviving definition seeds iteration 2).
    const second = await orchestrator.startGroup(group.id);
    expect(second.iteration.iterationNumber).toBe(2);
    const secondExecs = await storage.getExecutionsByIteration(group.id, second.iteration.id);
    expect(secondExecs).toHaveLength(1);
    expect(secondExecs[0].taskName).toBe("Keep");
  });
});

describe("H1 — POST /start on a 0-task group → 400", () => {
  it("returns 400, creates no iteration, leaves the group not running", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const group = await storage.createTaskGroup({
      name: "Empty",
      description: "d",
      input: "obj",
      status: "pending",
      createdBy: "me",
    } as never);

    const res = await request(app).post(`/api/task-groups/${group.id}/start`);
    expect(res.status).toBe(400);

    expect(await storage.getLatestIteration(group.id)).toBeUndefined();
    expect((await storage.getTaskGroup(group.id))!.status).not.toBe("running");
  });
});
