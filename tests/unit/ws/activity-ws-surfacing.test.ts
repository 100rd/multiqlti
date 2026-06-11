/**
 * Unit tests for the additive WS surfacing the Activity lens relies on:
 *   - P-1: stage:progress now carries modelSlug,
 *   - O-1: a new orchestrator:step event {stepIndex, type, status, modelSlug}.
 *
 * (M-1 manager:decision modelSlug is covered in tests/integration/manager-mode.)
 *
 * Each controller/agent is constructed with a capturing wsManager double; we
 * drive the smallest path that emits the event. No CLI/network/DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PipelineController } from "../../../server/controller/pipeline-controller.js";
import { OrchestratorAgent } from "../../../server/orchestrator/orchestrator-agent.js";
import type { WsEvent } from "../../../shared/types.js";
import { configLoader } from "../../../server/config/loader.js";

interface Captured {
  runId: string;
  event: WsEvent;
}

function capturingWs(sink: Captured[]) {
  return {
    broadcastToRun: (runId: string, event: WsEvent) => sink.push({ runId, event }),
    broadcastGlobal: vi.fn(),
  } as never;
}

afterEach(() => vi.restoreAllMocks());

describe("P-1 — stage:progress carries modelSlug", () => {
  beforeEach(() => {
    const base = configLoader.get();
    vi.spyOn(configLoader, "get").mockReturnValue({
      ...base,
      pipeline: {
        ...base.pipeline,
        streaming: {
          enabled: true,
          wsProgressFlushMs: 0,
          idleTimeoutMs: 1000,
          overallTimeoutMs: 1000,
          maxOutputBytes: 100000,
        },
      },
    } as never);
  });

  it("includes modelSlug in the stage:progress payload", () => {
    const sink: Captured[] = [];
    const controller = new PipelineController({} as never, {} as never, capturingWs(sink));

    const build = (controller as unknown as {
      buildStreamingBlock: (
        runId: string,
        stageIndex: number,
        teamId: string,
        modelSlug: string,
        stageExecutionId: string | undefined,
        signal: AbortSignal,
      ) => { coalescer?: { push: (d: string, c: number) => void; flush?: () => void } };
    }).buildStreamingBlock(
      "run-1",
      2,
      "coding",
      "claude-sonnet",
      "exec-1",
      new AbortController().signal,
    );

    build.coalescer?.push("hello", 5);
    build.coalescer?.flush?.();

    const progress = sink.find((c) => c.event.type === "stage:progress");
    expect(progress).toBeTruthy();
    expect(progress!.event.payload).toMatchObject({
      stageIndex: 2,
      teamId: "coding",
      modelSlug: "claude-sonnet",
    });
  });
});

describe("O-1 — orchestrator:step event", () => {
  function makeAgent(sink: Captured[], executors: Record<string, unknown>) {
    const storage = {
      updateOrchestratorStep: vi.fn(async () => undefined),
      updateOrchestratorRun: vi.fn(async () => undefined),
      getOrchestratorSteps: vi.fn(async () => []),
    };
    const agent = new OrchestratorAgent({
      storage: storage as never,
      wsManager: capturingWs(sink),
      gateway: {} as never,
      stepExecutors: executors as never,
      models: {
        planModelSlug: "claude-opus",
        synthesizeModelSlug: "claude-opus",
        proposerModelSlug: "claude-opus",
        criticModelSlug: "gemini-flash",
        judgeModelSlug: "claude-opus",
      },
    });
    return { agent, storage };
  }

  it("emits running + completed orchestrator:step with the right shape", async () => {
    const sink: Captured[] = [];
    const { agent } = makeAgent(sink, {
      debate: vi.fn(async () => ({ output: { ok: true }, tokensUsed: 1 })),
    });
    const budget = { add: vi.fn(), total: 1 } as never;

    await (agent as unknown as {
      runStep: (
        runId: string,
        step: { id: string; stepIndex: number; type: string; args: unknown },
        caps: unknown,
        budget: unknown,
        signal: AbortSignal,
      ) => Promise<void>;
    }).runStep(
      "run-1",
      { id: "s1", stepIndex: 0, type: "debate", args: { type: "debate", question: "q" } },
      { stepOutputMaxBytes: 100000 } as never,
      budget,
      new AbortController().signal,
    );

    const steps = sink.filter((c) => c.event.type === "orchestrator:step");
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps[0].event.payload).toMatchObject({
      stepIndex: 0,
      type: "debate",
      status: "running",
      modelSlug: "claude-opus",
    });
    const completed = steps.find((s) => (s.event.payload as { status: string }).status === "completed");
    expect(completed).toBeTruthy();
    expect(completed!.event.payload).toMatchObject({ stepIndex: 0, type: "debate", modelSlug: "claude-opus" });
  });

  it("emits a failed orchestrator:step when the step throws", async () => {
    const sink: Captured[] = [];
    const { agent } = makeAgent(sink, {
      ground: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    await expect(
      (agent as unknown as { runStep: (...a: unknown[]) => Promise<void> }).runStep(
        "run-1",
        { id: "s1", stepIndex: 1, type: "ground", args: { type: "ground", query: "q" } },
        { stepOutputMaxBytes: 100000 },
        { add: vi.fn(), total: 0 },
        new AbortController().signal,
      ),
    ).rejects.toThrow();

    const failed = sink.find(
      (c) => c.event.type === "orchestrator:step" && (c.event.payload as { status: string }).status === "failed",
    );
    expect(failed).toBeTruthy();
    expect(failed!.event.payload).toMatchObject({ stepIndex: 1, type: "ground" });
  });
});
