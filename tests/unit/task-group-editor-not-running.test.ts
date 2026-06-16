/**
 * Unit tests for the v2 "editable when NO iteration is running" rule (BE5,
 * task-groups-v2 §4.2). TaskGroupEditor.assertNotRunning replaces assertPending:
 *
 *   - a TERMINAL group (latest iteration completed/failed) is editable again,
 *     INCLUDING its input (the next iteration snapshots it);
 *   - a group whose latest iteration is RUNNING → 409 on every edit;
 *   - a dependency cycle → 400 (validateTaskGraph still runs);
 *   - persist-time TOCTOU: if the latest iteration flips to running between the
 *     route's auth and the editor's persist-time re-read → 409.
 *
 * Deterministic: MemStorage (+ a thin spy for the TOCTOU flip). No CLI/DB.
 */
import { describe, it, expect } from "vitest";
import { MemStorage } from "../../server/storage.js";
import {
  TaskGroupEditor,
  TaskGroupEditError,
} from "../../server/services/task-group-editor.js";
import type {
  InsertTaskGroup,
  InsertTask,
  InsertTaskGroupIteration,
  TaskGroupIterationRow,
  TaskGroupStatus,
} from "@shared/schema";

async function seed(storage: MemStorage, status: TaskGroupStatus) {
  const group = await storage.createTaskGroup({
    name: "G",
    description: "D",
    input: "original",
    status,
    createdBy: "me",
  } as InsertTaskGroup);
  return group;
}

/** Add a real iteration row with the given status (drives assertNotRunning). */
async function seedIteration(
  storage: MemStorage,
  groupId: string,
  status: TaskGroupStatus,
  iterationNumber = 1,
): Promise<TaskGroupIterationRow> {
  return storage.createIteration({
    groupId,
    iterationNumber,
    status,
    input: "snapshot",
  } as InsertTaskGroupIteration);
}

async function seedTask(storage: MemStorage, groupId: string, name: string, dependsOn: string[] = []) {
  return storage.createTask({
    groupId,
    name,
    description: "d",
    executionMode: "direct_llm",
    dependsOn,
    input: {},
    status: dependsOn.length === 0 ? "ready" : "blocked",
    sortOrder: 0,
  } as InsertTask);
}

describe("TaskGroupEditor.assertNotRunning (v2 editable-when-not-running)", () => {
  it("allows editing input on a group whose latest iteration is terminal", async () => {
    const storage = new MemStorage();
    const editor = new TaskGroupEditor(storage);
    const group = await seed(storage, "completed");
    await seedIteration(storage, group.id, "completed");

    const updated = await editor.updateGroup(group.id, { input: "next-run-objective", name: "N" });
    expect(updated.input).toBe("next-run-objective");
    expect(updated.name).toBe("N");
  });

  it("allows adding a task on a terminal group", async () => {
    const storage = new MemStorage();
    const editor = new TaskGroupEditor(storage);
    const group = await seed(storage, "failed");
    await seedIteration(storage, group.id, "failed");

    const task = await editor.addTask(group.id, { name: "new", description: "d" });
    expect(task.status).toBe("ready");
  });

  it("rejects every edit with 409 when the latest iteration is running", async () => {
    const storage = new MemStorage();
    const editor = new TaskGroupEditor(storage);
    const group = await seed(storage, "running");
    await seedIteration(storage, group.id, "running");
    const task = await seedTask(storage, group.id, "a");

    await expect(editor.updateGroup(group.id, { name: "x" })).rejects.toMatchObject({ status: 409 });
    await expect(editor.updateTask(group.id, task.id, { name: "x" })).rejects.toMatchObject({ status: 409 });
    await expect(editor.addTask(group.id, { name: "b", description: "d" })).rejects.toMatchObject({ status: 409 });
    await expect(editor.removeTask(group.id, task.id)).rejects.toMatchObject({ status: 409 });
  });

  it("falls back to the group row status for pre-v2 groups (no iterations)", async () => {
    const storage = new MemStorage();
    const editor = new TaskGroupEditor(storage);
    // No iteration rows → effective status = group.status.
    const running = await seed(storage, "running");
    await expect(editor.updateGroup(running.id, { name: "x" })).rejects.toMatchObject({ status: 409 });

    const completed = await seed(storage, "completed");
    const updated = await editor.updateGroup(completed.id, { input: "new" });
    expect(updated.input).toBe("new");
  });

  it("rejects a dependency cycle with 400 (validateTaskGraph still runs)", async () => {
    const storage = new MemStorage();
    const editor = new TaskGroupEditor(storage);
    const group = await seed(storage, "completed");
    await seedIteration(storage, group.id, "completed");
    const a = await seedTask(storage, group.id, "a");
    const b = await seedTask(storage, group.id, "b", [a.id]);

    await expect(
      editor.updateTask(group.id, a.id, { dependsOn: [b.id] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("persist-time TOCTOU: latest iteration flips to running before the write → 409", async () => {
    const storage = new MemStorage();
    const group = await seed(storage, "completed");
    const iteration = await seedIteration(storage, group.id, "completed");

    // Spy: the FIRST getLatestIteration (the editor's persist-time re-read) flips
    // the iteration to running, modelling a concurrent startGroup between auth and
    // write. The editor must observe the flip and throw 409.
    const realGetLatest = storage.getLatestIteration.bind(storage);
    let flipped = false;
    storage.getLatestIteration = async (gid: string) => {
      const row = await realGetLatest(gid);
      if (!flipped && row) {
        flipped = true;
        return { ...row, status: "running" as TaskGroupStatus };
      }
      return row;
    };

    const editor = new TaskGroupEditor(storage);
    await expect(editor.updateGroup(group.id, { name: "x" })).rejects.toBeInstanceOf(TaskGroupEditError);
    void iteration;
  });
});
