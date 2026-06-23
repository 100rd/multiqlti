/**
 * Unit tests for the §14.5 (D.1) non-awaiting `startGroup` path and the §14.3
 * (D.2) `workspaceId` threading. Both are STRICTLY ADDITIVE — the default
 * `startGroup` behaviour is covered (unchanged) by task-group-iterations.test.ts;
 * here we only exercise the new seams:
 *
 *   D.1 — `startGroupAsync` (== `startGroup({ await: false })`) returns the
 *         freshly-created `{group, iteration}` BEFORE a slow `launchBatch`
 *         resolves; a TOP-LEVEL background `launchBatch` rejection marks the
 *         iteration + group `failed` (no perpetual `running`, no hang, no
 *         unhandled rejection escapes).
 *   D.2 — a task's `workspaceId` flows through `executePipelineRun` into
 *         `pipelineController.startRun(..., workspaceId)`.
 *
 * Deterministic: MemStorage + scripted gateway/controller doubles (no
 * CLI/network/DB/WS). No `any` — internals are reached via typed handles.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { MemStorage } from "../../../server/storage.js";
import { TaskOrchestrator } from "../../../server/services/task-orchestrator.js";
import type { WsManager } from "../../../server/ws/manager.js";
import type { PipelineController } from "../../../server/controller/pipeline-controller.js";
import type { Gateway } from "../../../server/gateway/index.js";
import type { GatewayRequest, GatewayResponse } from "../../../shared/types.js";
import type {
  TaskGroupRow,
  TaskGroupIterationRow,
  TaskExecutionRow,
  TaskRow,
} from "@shared/schema";

// ─── Doubles ──────────────────────────────────────────────────────────────────

/**
 * A gateway whose completeStreaming stays pending until `release()` is called.
 * `release()` is idempotent and safe to call BEFORE the gateway is invoked
 * (it latches), so a test never has to race the fire-and-forget dispatch.
 */
function makeDeferredGateway(): {
  gateway: Gateway;
  release: () => void;
  started: () => boolean;
} {
  let released = false;
  let didStart = false;
  const respond = (request: GatewayRequest): Promise<GatewayResponse> => {
    didStart = true;
    const value: GatewayResponse = {
      content: JSON.stringify({ summary: "ok", output: { ok: true } }),
      tokensUsed: 1,
      modelSlug: request.modelSlug,
      finishReason: "stop",
    };
    return new Promise<GatewayResponse>((resolve) => {
      const tick = (): void => {
        if (released) resolve(value);
        else setTimeout(tick, 1);
      };
      tick();
    });
  };
  return {
    gateway: {
      complete: respond,
      completeStreaming: respond,
    } as unknown as Gateway,
    release: () => {
      released = true;
    },
    started: () => didStart,
  };
}

const noopWs = { broadcastToRun: () => {} } as unknown as WsManager;

function makeOrchestrator(
  gateway: Gateway,
  pipelineController: PipelineController = {} as unknown as PipelineController,
): { orchestrator: TaskOrchestrator; storage: MemStorage } {
  const storage = new MemStorage();
  return {
    orchestrator: new TaskOrchestrator(storage, noopWs, pipelineController, gateway),
    storage,
  };
}

/** Typed handle onto the private `launchBatch` so a test can override it cleanly. */
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
function internals(o: TaskOrchestrator): OrchestratorInternals {
  return o as unknown as OrchestratorInternals;
}

// ─── D.1 — non-awaiting startGroup ──────────────────────────────────────────────

describe("TaskOrchestrator — §14.5 non-awaiting startGroup (D.1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("startGroupAsync returns BEFORE a slow launchBatch resolves", async () => {
    const { gateway, release, started } = makeDeferredGateway();
    const { orchestrator, storage } = makeOrchestrator(gateway);
    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [{ name: "T1", description: "x", executionMode: "direct_llm" }],
    });

    // The gateway will NOT resolve until release() — so launchBatch cannot
    // complete. startGroupAsync must STILL return synchronously.
    const { group: returnedGroup, iteration } = await orchestrator.startGroupAsync(group.id);

    // We returned with the freshly-created rows, group already marked running,
    // WITHOUT the batch having settled (gateway still pending).
    expect(returnedGroup.status).toBe("running");
    expect(iteration.iterationNumber).toBe(1);

    // The batch IS dispatched in the background (gateway eventually invoked) and
    // the iteration stays `running` for as long as the gateway is held.
    await vi.waitFor(() => expect(started()).toBe(true));
    expect((await storage.getIteration(group.id, 1))?.status).toBe("running");

    // Now let the background batch finish and confirm it settles as usual.
    release();
    await vi.waitFor(async () => {
      const settled = await storage.getIteration(group.id, 1);
      expect(settled?.status).toBe("completed");
    });
  });

  it("startGroup({ await: false }) is equivalent to startGroupAsync", async () => {
    const { gateway, release } = makeDeferredGateway();
    const { orchestrator, storage } = makeOrchestrator(gateway);
    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [{ name: "T1", description: "x", executionMode: "direct_llm" }],
    });

    const res = await orchestrator.startGroup(group.id, { await: false });
    expect(res.group.status).toBe("running");
    // Not yet settled (gateway held).
    expect((await storage.getIteration(group.id, 1))?.status).toBe("running");

    release();
    await vi.waitFor(async () => {
      expect((await storage.getIteration(group.id, 1))?.status).toBe("completed");
    });
  });

  it("a background launchBatch rejection marks the iteration + group failed (no hang, no unhandled rejection)", async () => {
    const { gateway } = makeDeferredGateway();
    const { orchestrator, storage } = makeOrchestrator(gateway);
    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [{ name: "T1", description: "x", executionMode: "direct_llm" }],
    });

    // Trip an unhandled-rejection detector — the guard MUST consume the rejection.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    // Force a TOP-LEVEL launchBatch rejection (one that escapes the per-execution
    // Promise.allSettled) to exercise the §14.5 risk guard.
    internals(orchestrator).launchBatch = () =>
      Promise.reject(new Error("top-level batch boom"));

    const res = await orchestrator.startGroupAsync(group.id);
    expect(res.group.status).toBe("running"); // returned synchronously, pre-failure

    // The guard flips the iteration + group to `failed` so deriveReviewEvent sees
    // a terminal status, never a perpetual `running`.
    await vi.waitFor(async () => {
      expect((await storage.getIteration(group.id, 1))?.status).toBe("failed");
      expect((await storage.getTaskGroup(group.id))?.status).toBe("failed");
    });

    // No longer reported live (markGroupSettled ran).
    expect(orchestrator.getActiveGroupIds()).not.toContain(group.id);

    // Let any stray microtasks flush, then assert nothing escaped.
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toHaveLength(0);
  });

  it("default startGroup (await omitted) still AWAITS — unchanged behaviour", async () => {
    // A non-deferred gateway so the default path settles within the await.
    const respond = async (req: GatewayRequest): Promise<GatewayResponse> => ({
      content: JSON.stringify({ summary: "ok", output: { ok: true } }),
      tokensUsed: 1,
      modelSlug: req.modelSlug,
      finishReason: "stop",
    });
    const gateway = { complete: respond, completeStreaming: respond } as unknown as Gateway;
    const { orchestrator, storage } = makeOrchestrator(gateway);
    const { group } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [{ name: "T1", description: "x", executionMode: "direct_llm" }],
    });

    // Default: returns the SETTLED rows (group completed) — no waitFor needed.
    const { group: settled } = await orchestrator.startGroup(group.id);
    expect(settled.status).toBe("completed");
    expect((await storage.getIteration(group.id, 1))?.status).toBe("completed");
  });
});

// ─── D.2 — workspaceId threading ────────────────────────────────────────────────

describe("TaskOrchestrator — §14.3 workspaceId threading (D.2)", () => {
  /** A controller whose startRun records its args + creates a COMPLETED run. */
  function makeRecordingController(storage: MemStorage): {
    controller: PipelineController;
    calls: Array<{ pipelineId: string; workspaceId?: string }>;
  } {
    const calls: Array<{ pipelineId: string; workspaceId?: string }> = [];
    const startRun = async (
      pipelineId: string,
      input: string,
      _variables?: Record<string, string>,
      _triggeredBy?: string,
      workspaceId?: string,
    ) => {
      calls.push({ pipelineId, workspaceId });
      return storage.createPipelineRun({
        pipelineId,
        status: "completed",
        input,
        output: { ok: true },
        workspaceId: workspaceId ?? null,
      } as Parameters<MemStorage["createPipelineRun"]>[0]);
    };
    return {
      controller: { startRun } as unknown as PipelineController,
      calls,
    };
  }

  it("persists workspaceId on the definition and threads it into startRun", async () => {
    const storage = new MemStorage();
    const { controller, calls } = makeRecordingController(storage);
    const gateway = {
      complete: async () => ({}),
      completeStreaming: async () => ({}),
    } as unknown as Gateway;
    const orchestrator = new TaskOrchestrator(storage, noopWs, controller, gateway);

    const WS = "ws-loop-123";
    const { group, tasks } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [
        {
          name: "DEV",
          description: "x",
          executionMode: "pipeline_run",
          pipelineId: "pl-1",
          workspaceId: WS,
        },
      ],
    });

    // The column is persisted on the task definition.
    expect((await storage.getTask(tasks[0].id))?.workspaceId).toBe(WS);

    await orchestrator.startGroup(group.id);

    // startRun saw the loop's workspaceId in the 5th position.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ pipelineId: "pl-1", workspaceId: WS });
  });

  it("omitting workspaceId keeps today's behaviour (undefined passed to startRun)", async () => {
    const storage = new MemStorage();
    const { controller, calls } = makeRecordingController(storage);
    const gateway = {
      complete: async () => ({}),
      completeStreaming: async () => ({}),
    } as unknown as Gateway;
    const orchestrator = new TaskOrchestrator(storage, noopWs, controller, gateway);

    const { group, tasks } = await orchestrator.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      tasks: [
        { name: "DEV", description: "x", executionMode: "pipeline_run", pipelineId: "pl-1" },
      ],
    });

    expect((await storage.getTask(tasks[0].id))?.workspaceId).toBeNull();

    await orchestrator.startGroup(group.id);
    expect(calls[0]).toEqual({ pipelineId: "pl-1", workspaceId: undefined });
  });
});
