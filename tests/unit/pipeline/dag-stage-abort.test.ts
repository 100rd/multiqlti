/**
 * Unit test — DAG stage path abort parity (streaming-stage-execution, B1).
 *
 * Drives the REAL makeDAGStageExecuteFn closure (not just isAbortError) and
 * asserts the DAG error path mirrors the linear path:
 *   - an aborted stage → status "cancelled" (NOT "failed")
 *   - the error message is secret-scrubbed before it reaches storage/WS/tracer
 *   - a "pipeline:cancelled" WS event is emitted (not "stage:failed")
 *   - the StageProgressCoalescer's flush timer is cleared (no leaked timer)
 *
 * node:child_process is not involved; the team's execute() throws directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PipelineController } from "../../../server/controller/pipeline-controller.js";
import { configLoader } from "../../../server/config/loader.js";
import type { DAGStage } from "../../../shared/types.js";
import type { PipelineRun } from "../../../shared/schema.js";

interface RecordedUpdate {
  status?: string;
  error?: string;
}

function buildController() {
  const updates: RecordedUpdate[] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  const storage = {
    getStageExecutions: vi.fn(async () => [{ id: "se-1", dagStageId: "dag-1", stageIndex: 0, runId: "run-1" }]),
    updateStageExecution: vi.fn(async (_id: string, patch: RecordedUpdate) => {
      updates.push(patch);
    }),
    getStageExecution: vi.fn(async () => null),
    getPipelineRun: vi.fn(async () => null),
    getWorkspace: vi.fn(async () => undefined),
    upsertMemory: vi.fn(async () => undefined),
  };

  const failingTeam = {
    execute: vi.fn(async () => {
      // AbortError (classified as a cancel) whose message embeds a secret so we
      // can assert BOTH the abort→cancelled mapping AND the M2 scrub on the same
      // DAG flow. (CliAbortError has a fixed message, so it cannot carry one.)
      const err = new Error("aborted; partial leak leaking-secret-VALUE-123456");
      err.name = "AbortError";
      throw err;
    }),
  };
  const teamRegistry = { getTeam: vi.fn(() => failingTeam) };
  const wsManager = {
    broadcastToRun: vi.fn((_runId: string, event: { type: string; payload: Record<string, unknown> }) => {
      events.push({ type: event.type, payload: event.payload });
    }),
  };

  const controller = new PipelineController(
    storage as never,
    teamRegistry as never,
    wsManager as never,
  );

  // Override deep collaborators the DAG fn touches so we don't need real DBs.
  (controller as unknown as { memoryProvider: unknown }).memoryProvider = {
    getRelevantMemories: vi.fn(async () => []),
    formatForPrompt: vi.fn(() => ""),
  };
  (controller as unknown as { memoryExtractor: unknown }).memoryExtractor = {
    extractFromStageResult: vi.fn(async () => []),
  };
  (controller as unknown as { captureStageLesson: () => Promise<void> }).captureStageLesson =
    vi.fn(async () => undefined);

  return { controller, storage, events, updates };
}

const RUN = { id: "run-1", pipelineId: "pipe-1" } as unknown as PipelineRun;
const DAG_STAGE = { id: "dag-1", teamId: "planning", modelSlug: "claude-sonnet" } as unknown as DAGStage;

describe("DAG stage path — abort parity (B1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Kill-switch ON so the streaming block + coalescer are created.
    vi.spyOn(configLoader, "get").mockReturnValue({
      pipeline: {
        streaming: {
          enabled: true,
          idleTimeoutMs: 60_000,
          overallTimeoutMs: 600_000,
          maxOutputBytes: 8_388_608,
          wsProgressFlushMs: 250,
        },
      },
    } as never);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("maps an aborted DAG stage to cancelled, scrubs the error, and clears the coalescer timer", async () => {
    vi.stubEnv("JWT_SECRET", "leaking-secret-VALUE-123456");
    const { controller, events, updates } = buildController();
    const signal = new AbortController().signal;

    // Reach into the private factory and invoke the stage closure directly.
    const makeFn = (controller as unknown as {
      makeDAGStageExecuteFn: (run: PipelineRun, signal: AbortSignal) => (
        run: PipelineRun,
        dagStage: DAGStage,
        input: Record<string, unknown>,
        stageIndex: number,
        dagStageId: string,
      ) => Promise<{ output: Record<string, unknown>; failed: boolean }>;
    }).makeDAGStageExecuteFn.bind(controller);

    const stageFn = makeFn(RUN, signal);
    const result = await stageFn(RUN, DAG_STAGE, { taskDescription: "x" }, 0, "dag-1");

    // Stage reported failed (DAG executor contract) but status is "cancelled".
    expect(result.failed).toBe(true);
    const cancelled = updates.find((u) => u.status === "cancelled");
    expect(cancelled, "stage should be marked cancelled, not failed").toBeDefined();
    expect(updates.some((u) => u.status === "failed")).toBe(false);

    // Error scrubbed before reaching storage.
    expect(cancelled?.error).not.toContain("leaking-secret-VALUE-123456");
    expect(cancelled?.error).toContain("[REDACTED]");

    // A pipeline:cancelled event was emitted, not stage:failed.
    expect(events.some((e) => e.type === "pipeline:cancelled")).toBe(true);
    expect(events.some((e) => e.type === "stage:failed")).toBe(false);

    // Coalescer timer cleared: advancing time fires no further timers / errors.
    expect(() => vi.advanceTimersByTime(600_000)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
