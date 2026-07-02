/**
 * Unit tests for the additive WS surfacing the Activity lens relies on:
 *   - P-1: stage:progress now carries modelSlug.
 *
 * (M-1 manager:decision modelSlug is covered in tests/integration/manager-mode.)
 *
 * Each controller is constructed with a capturing wsManager double; we
 * drive the smallest path that emits the event. No CLI/network/DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PipelineController } from "../../../server/controller/pipeline-controller.js";
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
