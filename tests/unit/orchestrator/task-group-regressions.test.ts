/**
 * Regression tests for the Task Groups v2 orchestrator correctness fixes
 * (review-blocking bugs the linear-chain suite misses):
 *
 *   C1 — fan-in/join nodes must launch EXACTLY ONCE under simultaneous dep
 *        completion (diamond A→{B,C}→D; D must not double-run).
 *   H1 — a 0-ready-task start throws NoReadyTasksError BEFORE creating an
 *        iteration; the group is never left dangling-running.
 *   M2 — downstream-of-failed executions are `cancelled` (not left `blocked`).
 *   M1 — a running group appears in getActiveGroupIds() even with tracer:null.
 *
 * Deterministic: MemStorage + scripted doubles (no CLI/network/DB/WS).
 */
import { describe, it, expect } from "vitest";
import { MemStorage } from "../../../server/storage.js";
import {
  TaskOrchestrator,
  NoReadyTasksError,
  InvalidTaskGraphError,
} from "../../../server/services/task-orchestrator.js";
import type { WsManager } from "../../../server/ws/manager.js";
import type { Gateway } from "../../../server/gateway/index.js";
import type { GatewayRequest, GatewayResponse } from "../../../shared/types.js";
import type { TaskGroupRow } from "@shared/schema";

/**
 * A gateway whose complete() resolves only when the test releases each call,
 * so two dependency completions can be interleaved deterministically. It also
 * counts, per task name, how many times the gateway was invoked (the C1 oracle).
 */
interface GatewayGate {
  gateway: Gateway;
  /** Resolve the next pending call for `taskName` (FIFO). */
  release(taskName: string): void;
  /** How many times the gateway ran for `taskName`. */
  count(taskName: string): number;
  /** Wait until `n` calls for `taskName` are pending. */
  awaitPending(taskName: string, n: number): Promise<void>;
}

function makeGatewayGate(): GatewayGate {
  const counts = new Map<string, number>();
  const pending = new Map<string, Array<() => void>>();

  const respond = async (request: GatewayRequest): Promise<GatewayResponse> => {
    const sys = request.messages.find((m) => m.role === "system")?.content ?? "";
    const match = /Your specific task: (.+)/.exec(sys);
    const name = match?.[1]?.trim() ?? "?";
    counts.set(name, (counts.get(name) ?? 0) + 1);
    await new Promise<void>((resolve) => {
      const queue = pending.get(name) ?? [];
      queue.push(resolve);
      pending.set(name, queue);
    });
    return {
      content: JSON.stringify({ summary: `did ${name}`, output: { ok: true } }),
      tokensUsed: 1,
      modelSlug: request.modelSlug,
      finishReason: "stop",
    };
  };

  const gateway = {
    complete: respond,
    completeStreaming: respond,
  } as unknown as Gateway;

  return {
    gateway,
    release(taskName) {
      const queue = pending.get(taskName) ?? [];
      const next = queue.shift();
      if (next) next();
    },
    count(taskName) {
      return counts.get(taskName) ?? 0;
    },
    async awaitPending(taskName, n) {
      while ((pending.get(taskName)?.length ?? 0) < n) {
        await new Promise((r) => setTimeout(r, 0));
      }
    },
  };
}

function makeOrchestrator(gateway: Gateway): { orchestrator: TaskOrchestrator; storage: MemStorage } {
  const storage = new MemStorage();
  const wsManager = { broadcastToRun: () => {} } as unknown as WsManager;
  return {
    orchestrator: new TaskOrchestrator(storage, wsManager, gateway),
    storage,
  };
}

// ─── C1 — fan-in/join double-execution ──────────────────────────────────────

describe("C1 — diamond fan-in launches the join EXACTLY once", () => {
  it("D runs exactly once when B and C complete near-simultaneously", async () => {
    const gate = makeGatewayGate();
    const { orchestrator, storage } = makeOrchestrator(gate.gateway);

    // Diamond: A → {B, C} → D.
    const { group } = await orchestrator.createTaskGroup({
      name: "diamond",
      description: "d",
      input: "obj",
      tasks: [
        { name: "A", description: "a", executionMode: "direct_llm" },
        { name: "B", description: "b", executionMode: "direct_llm", dependsOn: ["A"] },
        { name: "C", description: "c", executionMode: "direct_llm", dependsOn: ["A"] },
        { name: "D", description: "d", executionMode: "direct_llm", dependsOn: ["B", "C"] },
      ],
    });

    const runPromise = orchestrator.startGroup(group.id);

    // A launches first; release it → B and C become ready and launch.
    await gate.awaitPending("A", 1);
    gate.release("A");
    await gate.awaitPending("B", 1);
    await gate.awaitPending("C", 1);

    // Release B and C back-to-back: both onTaskCompleted continuations race to
    // see D as ready. The claim must let exactly ONE launch D.
    gate.release("B");
    gate.release("C");

    // D must become pending exactly once; release it to settle the run.
    await gate.awaitPending("D", 1);
    gate.release("D");
    await runPromise;

    expect(gate.count("D")).toBe(1);

    // Exactly one execution row per definition (no duplicate D).
    const iteration = await storage.getLatestIteration(group.id);
    const execs = await storage.getExecutionsByIteration(group.id, iteration!.id);
    const dExecs = execs.filter((e) => e.taskName === "D");
    expect(dExecs).toHaveLength(1);
    expect(dExecs[0].status).toBe("completed");
    expect(execs.filter((e) => e.status === "completed")).toHaveLength(4);
  });
});

// ─── H1 — empty / no-ready-tasks start never settles ─────────────────────────

describe("H1 — a start with zero ready tasks throws before creating an iteration", () => {
  async function makeGroup(storage: MemStorage): Promise<TaskGroupRow> {
    return storage.createTaskGroup({
      name: "empty",
      description: "d",
      input: "obj",
      status: "pending",
      createdBy: null,
    } as never);
  }

  it("a 0-definition group → NoReadyTasksError, no iteration, group not running", async () => {
    const { orchestrator, storage } = makeOrchestrator({} as unknown as Gateway);
    const group = await makeGroup(storage);

    await expect(orchestrator.startGroup(group.id)).rejects.toBeInstanceOf(NoReadyTasksError);

    expect(await storage.getLatestIteration(group.id)).toBeUndefined();
    expect((await storage.getTaskGroup(group.id))!.status).not.toBe("running");
  });

  it("an all-blocked graph (no ready seed) → NoReadyTasksError, no iteration", async () => {
    const { orchestrator, storage } = makeOrchestrator({} as unknown as Gateway);
    const group = await makeGroup(storage);
    const t = await storage.createTask({
      groupId: group.id,
      name: "blocked",
      description: "d",
      executionMode: "direct_llm",
      dependsOn: ["nonexistent-id"],
      input: {},
      status: "blocked",
      sortOrder: 0,
    } as never);
    expect(t.status).toBe("blocked");

    await expect(orchestrator.startGroup(group.id)).rejects.toBeInstanceOf(NoReadyTasksError);
    expect(await storage.getLatestIteration(group.id)).toBeUndefined();
  });
});

// ─── M2 — downstream-of-failed cancelled, not blocked ────────────────────────

describe("M2 — downstream of a failed dependency is cancelled", () => {
  it("B dependsOn A; A fails → B execution is cancelled, iteration failed", async () => {
    const failImpl = async (): Promise<GatewayResponse> => {
      throw new Error("scripted failure");
    };
    const failingGateway = {
      complete: failImpl,
      completeStreaming: failImpl,
    } as unknown as Gateway;

    const { orchestrator, storage } = makeOrchestrator(failingGateway);
    const { group, tasks } = await orchestrator.createTaskGroup({
      name: "chain",
      description: "d",
      input: "obj",
      tasks: [
        { name: "A", description: "a", executionMode: "direct_llm" },
        { name: "B", description: "b", executionMode: "direct_llm", dependsOn: ["A"] },
      ],
    });
    const b = tasks.find((t) => t.name === "B")!;

    const { iteration } = await orchestrator.startGroup(group.id);
    const execs = await storage.getExecutionsByIteration(group.id, iteration.id);
    const bExec = execs.find((e) => e.taskId === b.id)!;

    expect(bExec.status).toBe("cancelled");
    expect((await storage.getIteration(group.id, 1))!.status).toBe("failed");
  });
});

// ─── M1 — getActiveGroupIds() independent of the tracer ──────────────────────

describe("M1 — getActiveGroupIds tracks running groups without a tracer", () => {
  it("a running group appears in getActiveGroupIds() with tracer:null", async () => {
    const gate = makeGatewayGate();
    const { orchestrator, storage } = makeOrchestrator(gate.gateway);
    // No setTracer() called → tracer stays null.

    const { group } = await orchestrator.createTaskGroup({
      name: "live",
      description: "d",
      input: "obj",
      tasks: [{ name: "T", description: "t", executionMode: "direct_llm" }],
    });

    const runPromise = orchestrator.startGroup(group.id);
    await gate.awaitPending("T", 1);

    // Mid-run, with NO tracer, the group must be reported active.
    expect(orchestrator.getActiveGroupIds()).toContain(group.id);

    gate.release("T");
    await runPromise;

    // After settle, it is removed.
    expect(orchestrator.getActiveGroupIds()).not.toContain(group.id);
    expect((await storage.getTaskGroup(group.id))!.status).toBe("completed");
  });
});

// ─── L2 — create-path dangling dependsOn rejected ────────────────────────────

describe("L2 — createTaskGroup rejects a dangling / self / cyclic dependsOn", () => {
  it("a dangling dependsOn name throws InvalidTaskGraphError", async () => {
    const { orchestrator } = makeOrchestrator({} as unknown as Gateway);
    await expect(
      orchestrator.createTaskGroup({
        name: "g",
        description: "d",
        input: "obj",
        tasks: [
          { name: "A", description: "a", executionMode: "direct_llm", dependsOn: ["GHOST"] },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidTaskGraphError);
  });

  it("a cycle throws InvalidTaskGraphError", async () => {
    const { orchestrator } = makeOrchestrator({} as unknown as Gateway);
    await expect(
      orchestrator.createTaskGroup({
        name: "g",
        description: "d",
        input: "obj",
        tasks: [
          { name: "A", description: "a", executionMode: "direct_llm", dependsOn: ["B"] },
          { name: "B", description: "b", executionMode: "direct_llm", dependsOn: ["A"] },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidTaskGraphError);
  });
});

