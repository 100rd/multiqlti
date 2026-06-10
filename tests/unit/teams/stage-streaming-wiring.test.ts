/**
 * Unit tests — BaseTeam stage streaming wiring (streaming-stage-execution, T15).
 *
 * Verifies that executeSingleModel routes to the streaming gateway methods when
 * context.streaming is present and the kill-switch is on, routes to the blocking
 * methods when the kill-switch is off, threads signal/onDelta/limits, and
 * THROWS (never returns a partial TeamResult) on a stream error (H3).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CustomTeam } from "../../../server/teams/custom.js";
import { configLoader } from "../../../server/config/loader.js";
import type { StageContext, TeamConfig, StreamingStageOptions } from "../../../shared/types.js";

const baseConfig: TeamConfig = {
  id: "custom_test",
  name: "Test Custom",
  description: "Test",
  defaultModelSlug: "mock",
  systemPromptTemplate: "Default template prompt.",
  inputSchema: {},
  outputSchema: {},
  tools: [],
  color: "violet",
  icon: "⚙️",
};

function makeGateway() {
  return {
    complete: vi.fn().mockResolvedValue({ content: '{"summary":"blocking"}', tokensUsed: 10 }),
    completeWithTools: vi
      .fn()
      .mockResolvedValue({ content: '{"summary":"blocking-tools"}', tokensUsed: 10, toolCallLog: [] }),
    completeStreaming: vi.fn().mockResolvedValue({ content: '{"summary":"streamed"}', tokensUsed: 20 }),
    completeWithToolsStreaming: vi
      .fn()
      .mockResolvedValue({ content: '{"summary":"streamed-tools"}', tokensUsed: 20, toolCallLog: [] }),
  };
}

function makeContext(streaming?: StreamingStageOptions, overrides?: Partial<StageContext>): StageContext {
  return {
    runId: "run-1",
    stageIndex: 0,
    modelSlug: "mock",
    previousOutputs: [],
    // Disable tools by default so we hit the plain path unless asked otherwise.
    stageConfig: { teamId: "custom_test", modelSlug: "mock", enabled: true, tools: { enabled: false } },
    streaming,
    ...overrides,
  };
}

describe("BaseTeam stage streaming wiring", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Force streaming kill-switch ON for these tests.
    vi.spyOn(configLoader, "get").mockReturnValue({
      pipeline: { streaming: { enabled: true } },
    } as never);
  });

  it("routes the plain path to completeStreaming when context.streaming is present", async () => {
    const gateway = makeGateway();
    const team = new CustomTeam(gateway as never, baseConfig);
    const onDelta = vi.fn();
    const result = await team.execute({ taskDescription: "x" }, makeContext({ onDelta }));
    expect(gateway.completeStreaming).toHaveBeenCalledOnce();
    expect(gateway.complete).not.toHaveBeenCalled();
    expect(result.raw).toContain("streamed");
  });

  it("passes signal + streaming limits through to the gateway", async () => {
    const gateway = makeGateway();
    const team = new CustomTeam(gateway as never, baseConfig);
    const controller = new AbortController();
    const streaming: StreamingStageOptions = {
      signal: controller.signal,
      onDelta: vi.fn(),
      idleTimeoutMs: 1111,
      overallTimeoutMs: 2222,
      maxOutputBytes: 4096,
    };
    await team.execute({ taskDescription: "x" }, makeContext(streaming));
    const callArgs = gateway.completeStreaming.mock.calls[0];
    const passedStreamOpts = callArgs[3] as StreamingStageOptions;
    expect(passedStreamOpts.signal).toBe(controller.signal);
    expect(passedStreamOpts.idleTimeoutMs).toBe(1111);
    expect(passedStreamOpts.overallTimeoutMs).toBe(2222);
  });

  it("uses the BLOCKING path when the kill-switch is off", async () => {
    vi.spyOn(configLoader, "get").mockReturnValue({
      pipeline: { streaming: { enabled: false } },
    } as never);
    const gateway = makeGateway();
    const team = new CustomTeam(gateway as never, baseConfig);
    await team.execute({ taskDescription: "x" }, makeContext({ onDelta: vi.fn() }));
    expect(gateway.complete).toHaveBeenCalledOnce();
    expect(gateway.completeStreaming).not.toHaveBeenCalled();
  });

  it("uses the BLOCKING path when context.streaming is absent", async () => {
    const gateway = makeGateway();
    const team = new CustomTeam(gateway as never, baseConfig);
    await team.execute({ taskDescription: "x" }, makeContext(undefined));
    expect(gateway.complete).toHaveBeenCalledOnce();
    expect(gateway.completeStreaming).not.toHaveBeenCalled();
  });

  it("THROWS (no partial TeamResult) when the stream rejects (H3)", async () => {
    const gateway = makeGateway();
    gateway.completeStreaming.mockRejectedValue(new Error("CLI idle for 60000ms (no output)"));
    const team = new CustomTeam(gateway as never, baseConfig);
    await expect(
      team.execute({ taskDescription: "x" }, makeContext({ onDelta: vi.fn() })),
    ).rejects.toThrow(/idle/i);
  });
});
