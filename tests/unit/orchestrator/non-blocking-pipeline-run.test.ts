/**
 * Regression: §14.5 (D.1) non-blocking `startGroupAsync` must settle
 * `pipeline_run` task executions to `completed` when their runs complete, and
 * the L-3 background-rejection guard must NOT stomp an already-`completed` group
 * to `failed`.
 *
 * Live-run bug: a DEV handoff group of 2 `pipeline_run` tasks started via
 * `startGroupAsync` ended `failed` (0/N completed) even though BOTH underlying
 * pipeline runs COMPLETED. Root cause: `failIterationBackground` unconditionally
 * failed the iteration/group on ANY top-level `launchBatch` rejection — including
 * a stray post-completion throw in the recursive onTaskCompleted chain — flipping
 * a `completed` group to `failed`. Fix: the guard fails ONLY a still-non-terminal
 * iteration; a settled group stays settled.
 *
 * Deterministic: MemStorage + scripted controller/gateway doubles. No `any`.
 */
import { describe, it, expect, vi } from "vitest";
import { MemStorage } from "../../../server/storage.js";
import { TaskOrchestrator } from "../../../server/services/task-orchestrator.js";
import type { WsManager } from "../../../server/ws/manager.js";
import type { PipelineController } from "../../../server/controller/pipeline-controller.js";
import type { Gateway } from "../../../server/gateway/index.js";
import type {
  TaskGroupRow,
  TaskGroupIterationRow,
  TaskExecutionRow,
  TaskRow,
} from "@shared/schema";

const noopWs = { broadcastToRun: () => {} } as unknown as WsManager;
const stubGateway = {
  complete: async () => ({}),
  completeStreaming: async () => ({}),
} as unknown as Gateway;

/** Typed handle onto the private `launchBatch` so a test can override it. */
type LaunchBatchFn = (
  candidates: TaskExecutionRow[],
  slots: number,
  group: TaskGroupRow,
  iteration: TaskGroupIterationRow,
  definitions: TaskRow[],
) => Promise<void>;
interface OrchestratorInternals {
  launchBatch: LaunchBatchFn;
}

describe("TaskOrchestrator — §14.5 non-blocking pipeline_run settlement (D.1 fix)", () => {
  it("settles pipeline_run executions + group to completed when the runs complete", async () => {
    const storage = new MemStorage();

    // Fake controller: create a RUNNING run, then flip it to completed so the
    // REAL pollRunCompletion (2s poll) observes completion and settles the exec.
    const startRun = async (pipelineId: string, input: string) => {
      const run = await storage.createPipelineRun({
        pipelineId,
        status: "running",
        input,
        output: null,
        workspaceId: null,
      } as Parameters<MemStorage["createPipelineRun"]>[0]);
      setTimeout(() => {
        void storage.updatePipelineRun(run.id, { status: "completed", output: { ok: true } });
      }, 50);
      return run;
    };
    const controller = { startRun } as unknown as PipelineController;
    const orchestrator = new TaskOrchestrator(storage, noopWs, controller, stubGateway);

    const { group } = await orchestrator.createTaskGroup({
      name: "DEV handoff",
      description: "d",
      input: "obj",
      tasks: [
        { name: "DEV1", description: "ap1", executionMode: "pipeline_run", pipelineId: "pl-1" },
        { name: "DEV2", description: "ap2", executionMode: "pipeline_run", pipelineId: "pl-2" },
      ],
    });

    const { group: returned } = await orchestrator.startGroupAsync(group.id);
    expect(returned.status).toBe("running"); // returned immediately, pre-settle

    // Poll interval is 2s; allow a poll + settle. Real timers (no fake timers
    // because the controller uses its own setTimeout to flip the run).
    await vi.waitFor(
      async () => {
        const grp = await storage.getTaskGroup(group.id);
        expect(grp?.status).toBe("completed");
      },
      { timeout: 8000, interval: 200 },
    );

    const iter = await storage.getIteration(group.id, 1);
    const execs = await storage.getExecutionsByIteration(group.id, iter!.id);
    expect(iter?.status).toBe("completed");
    expect(execs.map((e) => e.status)).toEqual(["completed", "completed"]);
  }, 15000);

  it("a post-completion launchBatch rejection does NOT flip a completed group to failed (guard no-op)", async () => {
    const storage = new MemStorage();
    const orchestrator = new TaskOrchestrator(
      storage,
      noopWs,
      {} as unknown as PipelineController,
      stubGateway,
    );

    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [{ name: "DEV1", description: "x", executionMode: "direct_llm" }],
    });

    // The executions settle the group to `completed` (as the happy pipeline_run
    // path does), and THEN launchBatch rejects at the top level — a stray
    // post-completion throw from the recursive onTaskCompleted chain.
    (orchestrator as unknown as OrchestratorInternals).launchBatch = async (
      _candidates,
      _slots,
      g,
      iter,
    ) => {
      await storage.updateIteration(iter.id, { status: "completed", completedAt: new Date() });
      await storage.updateTaskGroup(g.id, { status: "completed", completedAt: new Date() });
      throw new Error("stray post-completion throw");
    };

    await orchestrator.startGroupAsync(group.id);

    // Give the .catch(failIterationBackground) a tick to (not) run.
    await new Promise((r) => setTimeout(r, 20));

    // The completed group must stay completed — the guard no-ops on a terminal
    // iteration. (Before the fix it stomped to `failed`.)
    expect((await storage.getTaskGroup(group.id))?.status).toBe("completed");
    expect((await storage.getIteration(group.id, 1))?.status).toBe("completed");
  });

  it("still fails the iteration when launchBatch rejects BEFORE any execution settles (guard intact)", async () => {
    const storage = new MemStorage();
    const orchestrator = new TaskOrchestrator(
      storage,
      noopWs,
      {} as unknown as PipelineController,
      stubGateway,
    );

    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [{ name: "DEV1", description: "x", executionMode: "direct_llm" }],
    });

    // A GENUINE early launch error: reject without settling anything. The
    // iteration is still `running` → the guard MUST fail it (L-3 preserved).
    (orchestrator as unknown as OrchestratorInternals).launchBatch = () =>
      Promise.reject(new Error("genuine launch boom"));

    await orchestrator.startGroupAsync(group.id);

    await vi.waitFor(async () => {
      expect((await storage.getIteration(group.id, 1))?.status).toBe("failed");
      expect((await storage.getTaskGroup(group.id))?.status).toBe("failed");
    });
    expect(orchestrator.getActiveGroupIds()).not.toContain(group.id);
  });
});
