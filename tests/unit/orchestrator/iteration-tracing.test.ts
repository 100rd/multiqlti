import { describe, it, expect, beforeEach } from "vitest";
import { IterationTracing } from "../../../server/services/orchestrator/iteration-tracing.js";
import type { TaskTracer } from "../../../server/services/task-tracer.js";
import type { IStorage } from "../../../server/storage.js";
import type { TaskGroupRow, TaskGroupIterationRow, TaskRow } from "@shared/schema";

// Minimal typed fixtures — only the fields IterationTracing reads.
const group = { id: "g1", name: "Demo" } as unknown as TaskGroupRow;
const iteration = { id: "iter1" } as unknown as TaskGroupIterationRow;
const task = { id: "t1", name: "Build" } as unknown as TaskRow;

interface TracerCall {
  method: string;
  args: unknown[];
}

/** Recording fake tracer; `throwOn` forces a throw to exercise the non-fatal catch paths. */
function makeTracer(throwOn = new Set<string>()) {
  const calls: TracerCall[] = [];
  const rec = (method: string, ret: string) => (...args: unknown[]): string => {
    calls.push({ method, args });
    if (throwOn.has(method)) throw new Error(`${method} boom`);
    return ret;
  };
  const tracer = {
    startIterationTrace: async (...args: unknown[]): Promise<string> => {
      calls.push({ method: "startIterationTrace", args });
      if (throwOn.has("startIterationTrace")) throw new Error("startIterationTrace boom");
      return "trace-1";
    },
    startTaskSpan: rec("startTaskSpan", "span-task"),
    startLlmCallSpan: rec("startLlmCallSpan", "span-llm"),
    startPipelineRunSpan: rec("startPipelineRunSpan", "span-pipe"),
    completeSpan: (...args: unknown[]): void => {
      calls.push({ method: "completeSpan", args });
      if (throwOn.has("completeSpan")) throw new Error("completeSpan boom");
    },
    failSpan: (...args: unknown[]): void => {
      calls.push({ method: "failSpan", args });
      if (throwOn.has("failSpan")) throw new Error("failSpan boom");
    },
  } as unknown as TaskTracer;
  return { tracer, calls };
}

function makeStorage(traceSpans: Array<{ spanId: string }> = [{ spanId: "root-span" }]): IStorage {
  return {
    updateIteration: async () => iteration,
    getTaskTraceByIteration: async () => ({ spans: traceSpans }),
  } as unknown as IStorage;
}

describe("IterationTracing — pipeline spans + non-fatal behaviour", () => {
  let tracing: IterationTracing;

  beforeEach(() => {
    tracing = new IterationTracing(makeStorage());
  });

  it("returns empty span ids when no tracer is attached (tracer-less deployment)", () => {
    expect(tracing.startPipelineSpan("g1", "t1", "run-1")).toBe("");
    // No throw, no context — completes/fails are silent no-ops.
    tracing.completePipelineSpan("g1", "span", "run-1");
    tracing.failPipelineSpan("g1", "span", "err");
  });

  it("opens, completes, and fails a pipeline-run span under the task span", async () => {
    const { tracer, calls } = makeTracer();
    tracing.setTracer(tracer);
    await tracing.openIteration(group, iteration);
    // A task span must exist before a pipeline span can attach.
    expect(tracing.startTaskSpan("g1", task)).toBe("span-task");

    const pipeSpan = tracing.startPipelineSpan("g1", "t1", "run-1");
    expect(pipeSpan).toBe("span-pipe");
    expect(calls.find((c) => c.method === "startPipelineRunSpan")?.args).toEqual([
      "trace-1",
      "span-task",
      "run-1",
    ]);

    tracing.completePipelineSpan("g1", pipeSpan, "run-1");
    tracing.failPipelineSpan("g1", pipeSpan, "pipeline failed");
    expect(calls.some((c) => c.method === "completeSpan")).toBe(true);
    expect(calls.some((c) => c.method === "failSpan")).toBe(true);
  });

  it("returns '' for a pipeline span when the task span is missing", async () => {
    const { tracer } = makeTracer();
    tracing.setTracer(tracer);
    await tracing.openIteration(group, iteration);
    // No startTaskSpan called → no taskSpanId → ""
    expect(tracing.startPipelineSpan("g1", "t1", "run-1")).toBe("");
  });

  it("swallows tracer throws on every pipeline-span method (non-fatal)", async () => {
    const { tracer } = makeTracer(
      new Set(["startPipelineRunSpan", "completeSpan", "failSpan"]),
    );
    tracing.setTracer(tracer);
    await tracing.openIteration(group, iteration);
    tracing.startTaskSpan("g1", task);

    expect(tracing.startPipelineSpan("g1", "t1", "run-1")).toBe("");
    // completePipelineSpan needs a non-empty spanId to reach the throwing tracer call.
    expect(() => tracing.completePipelineSpan("g1", "span-x", "run-1")).not.toThrow();
    expect(() => tracing.failPipelineSpan("g1", "span-x", "err")).not.toThrow();
  });

  it("settles the iteration root span on group completion and drops context", async () => {
    const { tracer, calls } = makeTracer();
    tracing.setTracer(tracer);
    await tracing.openIteration(group, iteration);
    tracing.completeGroup("g1");
    // Let the getTaskTraceByIteration().then() microtask flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.some((c) => c.method === "completeSpan")).toBe(true);
  });

  it("settles the root span via failSpan on group failure", async () => {
    const { tracer, calls } = makeTracer();
    tracing.setTracer(tracer);
    await tracing.openIteration(group, iteration);
    tracing.failGroup("g1", "boom");
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.some((c) => c.method === "failSpan")).toBe(true);
  });

  it("openIteration is non-fatal when the tracer throws", async () => {
    const { tracer } = makeTracer(new Set(["startIterationTrace"]));
    tracing.setTracer(tracer);
    await expect(tracing.openIteration(group, iteration)).resolves.toBeUndefined();
    // Context never bound → later span calls are silent "".
    expect(tracing.startTaskSpan("g1", task)).toBe("");
  });
});
