/**
 * Unit tests for server/pipeline/swarm-executor.ts (Phase 6.7)
 *
 * Tests cover:
 *  - chunks splitter (even split, uneven length)
 *  - perspectives splitter (user-provided, auto-generate)
 *  - custom splitter
 *  - concatenate merger
 *  - llm_merge merger
 *  - vote merger (structured majority, tie fallback, unstructured fallback)
 *  - partial failure (1 of 3 fails)
 *  - all clones fail → SwarmAllFailedError
 *  - Zod schema validation (cloneCount bounds, custom length mismatch)
 *  - swarm.enabled=false → returns null
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SwarmExecutor, SwarmAllFailedError } from "../../../server/pipeline/swarm-executor.js";
import { SwarmConfigSchema, SwarmPerspectiveSchema } from "../../../shared/types.js";
import type { Gateway } from "../../../server/gateway/index.js";
import type { TeamRegistry } from "../../../server/teams/registry.js";
import type { WsManager } from "../../../server/ws/manager.js";
import type {
  PipelineStageConfig,
  StageContext,
  SwarmConfig,
  TeamResult,
} from "../../../shared/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGateway(responses: string[]): Gateway {
  let callIndex = 0;
  const complete = vi.fn().mockImplementation(() => {
    const content = responses[callIndex] ?? responses[responses.length - 1] ?? "";
    callIndex++;
    return Promise.resolve({
      content,
      tokensUsed: 10,
      modelSlug: "mock",
      finishReason: "stop",
    });
  });
  return {
    complete,
    stream: vi.fn(),
    completeWithTools: vi.fn().mockResolvedValue({
      content: "{}",
      tokensUsed: 10,
      modelSlug: "mock",
      finishReason: "stop",
      toolCallLog: [],
    }),
  } as unknown as Gateway;
}

function makeWsManager(): WsManager {
  return {
    broadcastToRun: vi.fn(),
  } as unknown as WsManager;
}

function makeTeamRegistry(outputRaw = "clone result"): TeamRegistry {
  return {
    getTeam: vi.fn().mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        output: { raw: outputRaw },
        tokensUsed: 15,
        raw: outputRaw,
      } satisfies TeamResult),
      parseOutput: vi.fn().mockReturnValue({ summary: "parsed" }),
    }),
  } as unknown as TeamRegistry;
}

function makeFailingTeamRegistry(failOnCallIndex: number): TeamRegistry {
  let callIndex = 0;
  return {
    getTeam: vi.fn().mockReturnValue({
      execute: vi.fn().mockImplementation(() => {
        const idx = callIndex++;
        if (idx === failOnCallIndex) {
          return Promise.reject(new Error("clone execution failed"));
        }
        return Promise.resolve({
          output: { raw: "success" },
          tokensUsed: 10,
          raw: "success",
        } satisfies TeamResult);
      }),
      parseOutput: vi.fn().mockReturnValue({ summary: "parsed" }),
    }),
  } as unknown as TeamRegistry;
}

function makeAllFailingTeamRegistry(): TeamRegistry {
  return {
    getTeam: vi.fn().mockReturnValue({
      execute: vi.fn().mockRejectedValue(new Error("always fails")),
      parseOutput: vi.fn().mockReturnValue({}),
    }),
  } as unknown as TeamRegistry;
}

function makeStage(swarm: SwarmConfig, overrides: Partial<PipelineStageConfig> = {}): PipelineStageConfig {
  return {
    teamId: "development",
    modelSlug: "mock",
    enabled: true,
    swarm,
    ...overrides,
  };
}

function makeContext(): StageContext {
  return {
    runId: "run-test-1",
    stageIndex: 0,
    previousOutputs: [],
    modelSlug: "mock",
  };
}

function makeSwarmConfig(overrides: Partial<SwarmConfig> = {}): SwarmConfig {
  return {
    enabled: true,
    cloneCount: 2,
    splitter: "chunks",
    merger: "concatenate",
    ...overrides,
  };
}

// ─── swarm.enabled=false → returns null ──────────────────────────────────────

describe("SwarmExecutor.execute — swarm disabled", () => {
  it("returns null when swarm.enabled is false", async () => {
    const executor = new SwarmExecutor(makeGateway([]), makeTeamRegistry(), makeWsManager());
    const stage = makeStage(makeSwarmConfig({ enabled: false }));
    const result = await executor.execute(stage, "some input", makeContext(), "stage-1");
    expect(result).toBeNull();
  });

  it("returns null when stage.swarm is undefined", async () => {
    const executor = new SwarmExecutor(makeGateway([]), makeTeamRegistry(), makeWsManager());
    const stage: PipelineStageConfig = {
      teamId: "development",
      modelSlug: "mock",
      enabled: true,
    };
    const result = await executor.execute(stage, "some input", makeContext(), "stage-1");
    expect(result).toBeNull();
  });
});

// ─── chunks splitter ─────────────────────────────────────────────────────────

describe("SwarmExecutor — chunks splitter", () => {
  it("even split: cloneCount=2 divides input into 2 parts", async () => {
    const wsManager = makeWsManager();
    const teamRegistry = makeTeamRegistry();
    const executor = new SwarmExecutor(makeGateway([]), teamRegistry, wsManager);
    const input = "line1\nline2\nline3\nline4";
    const stage = makeStage(makeSwarmConfig({ splitter: "chunks", cloneCount: 2 }));
    const result = await executor.execute(stage, input, makeContext(), "stage-1");

    expect(result).not.toBeNull();
    expect(result!.cloneResults).toHaveLength(2);
    // Each clone receives a portion of the input
    const executeCalls = (teamRegistry.getTeam("development").execute as ReturnType<typeof vi.fn>).mock.calls;
    expect(executeCalls).toHaveLength(2);
    // Verify the two chunks together contain all lines
    const chunk1 = executeCalls[0][0].taskDescription as string;
    const chunk2 = executeCalls[1][0].taskDescription as string;
    const allLines = (chunk1 + "\n" + chunk2).split("\n").filter((l) => l.length > 0);
    expect(allLines).toContain("line1");
    expect(allLines).toContain("line4");
  });

  it("uneven length: graceful remainder distribution", async () => {
    const wsManager = makeWsManager();
    const teamRegistry = makeTeamRegistry();
    const executor = new SwarmExecutor(makeGateway([]), teamRegistry, wsManager);
    // 3 lines, 2 clones — one clone gets 2 lines, other gets 1
    const input = "a\nb\nc";
    const stage = makeStage(makeSwarmConfig({ splitter: "chunks", cloneCount: 2 }));
    const result = await executor.execute(stage, input, makeContext(), "stage-1");

    expect(result).not.toBeNull();
    expect(result!.cloneResults).toHaveLength(2);
    expect(result!.succeededCount).toBe(2);
  });

  it("cloneCount=2 (minimum): works correctly", async () => {
    const executor = new SwarmExecutor(makeGateway([]), makeTeamRegistry(), makeWsManager());
    const stage = makeStage(makeSwarmConfig({ splitter: "chunks", cloneCount: 2 }));
    const result = await executor.execute(stage, "hello world input", makeContext(), "stage-1");
    expect(result).not.toBeNull();
    expect(result!.cloneResults).toHaveLength(2);
  });
});

// ─── perspectives splitter (user-provided) ────────────────────────────────────

describe("SwarmExecutor — perspectives splitter (user-provided)", () => {
  it("uses provided perspectives with correct system prompt suffix per clone", async () => {
    const teamRegistry = makeTeamRegistry();
    const executor = new SwarmExecutor(makeGateway([]), teamRegistry, makeWsManager());

    const perspectives = [
      { label: "Security", systemPromptSuffix: "Focus on security vulnerabilities." },
      { label: "Performance", systemPromptSuffix: "Focus on performance bottlenecks." },
    ];
    const stage = makeStage(
      makeSwarmConfig({
        splitter: "perspectives",
        cloneCount: 2,
        perspectives,
      }),
      { systemPromptOverride: "Base prompt." },
    );

    const result = await executor.execute(stage, "full input text", makeContext(), "stage-1");
    expect(result).not.toBeNull();
    expect(result!.cloneResults).toHaveLength(2);
    expect(result!.succeededCount).toBe(2);

    // Verify each clone received the full input (not split)
    const executeCalls = (teamRegistry.getTeam("development").execute as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of executeCalls) {
      expect(call[0].taskDescription).toBe("full input text");
    }
  });

  it("system prompt includes base prompt and perspective suffix", async () => {
    const teamRegistry = makeTeamRegistry();
    const executor = new SwarmExecutor(makeGateway([]), teamRegistry, makeWsManager());

    const perspectives = [
      { label: "Security", systemPromptSuffix: "Security focus." },
      { label: "Cost", systemPromptSuffix: "Cost focus." },
    ];
    const stage = makeStage(
      makeSwarmConfig({ splitter: "perspectives", cloneCount: 2, perspectives }),
      { systemPromptOverride: "BASE_PROMPT" },
    );

    await executor.execute(stage, "input", makeContext(), "stage-1");

    const executeCalls = (teamRegistry.getTeam("development").execute as ReturnType<typeof vi.fn>).mock.calls;
    const context0 = executeCalls[0][1] as StageContext;
    expect(context0.stageConfig?.systemPromptOverride).toContain("BASE_PROMPT");
    expect(context0.stageConfig?.systemPromptOverride).toContain("Security focus.");
  });
});

// ─── perspectives splitter (auto-generate) ───────────────────────────────────

describe("SwarmExecutor — perspectives splitter (auto-generate)", () => {
  it("calls gateway once for auto-generation and uses returned perspectives", async () => {
    const autoPerspectives = [
      { label: "Tech Review", systemPromptSuffix: "Technical angle." },
      { label: "Business Review", systemPromptSuffix: "Business angle." },
    ];
    const gateway = makeGateway([JSON.stringify(autoPerspectives)]);
    const teamRegistry = makeTeamRegistry();
    const executor = new SwarmExecutor(gateway, teamRegistry, makeWsManager());

    const stage = makeStage(
      makeSwarmConfig({
        splitter: "perspectives",
        cloneCount: 2,
        // No perspectives provided → auto-generate
      }),
    );

    const result = await executor.execute(stage, "input text", makeContext(), "stage-1");
    expect(result).not.toBeNull();
    expect(result!.cloneResults).toHaveLength(2);
    // Gateway was called once for perspective generation
    expect((gateway.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("falls back to generic labels when gateway parse fails", async () => {
    const gateway = makeGateway(["NOT VALID JSON AT ALL"]);
    const teamRegistry = makeTeamRegistry();
    const executor = new SwarmExecutor(gateway, teamRegistry, makeWsManager());

    const stage = makeStage(
      makeSwarmConfig({ splitter: "perspectives", cloneCount: 2 }),
    );

    // Should not throw — falls back to generic labels
    const result = await executor.execute(stage, "input text", makeContext(), "stage-1");
    expect(result).not.toBeNull();
    expect(result!.cloneResults).toHaveLength(2);
  });
});

// ─── custom splitter ─────────────────────────────────────────────────────────

describe("SwarmExecutor — custom splitter", () => {
  it("applies per-clone override from customClonePrompts", async () => {
    const teamRegistry = makeTeamRegistry();
    const executor = new SwarmExecutor(makeGateway([]), teamRegistry, makeWsManager());

    const stage = makeStage(
      makeSwarmConfig({
        splitter: "custom",
        cloneCount: 2,
        customClonePrompts: ["You are a security expert.", "You are a performance expert."],
      }),
    );

    const result = await executor.execute(stage, "full input", makeContext(), "stage-1");
    expect(result).not.toBeNull();
    expect(result!.cloneResults).toHaveLength(2);

    const executeCalls = (teamRegistry.getTeam("development").execute as ReturnType<typeof vi.fn>).mock.calls;
    // All clones get full input
    for (const call of executeCalls) {
      expect(call[0].taskDescription).toBe("full input");
    }
    // Each gets its own systemPromptOverride
    const ctx0 = executeCalls[0][1] as StageContext;
    const ctx1 = executeCalls[1][1] as StageContext;
    expect(ctx0.stageConfig?.systemPromptOverride).toBe("You are a security expert.");
    expect(ctx1.stageConfig?.systemPromptOverride).toBe("You are a performance expert.");
  });
});

// ─── concatenate merger ───────────────────────────────────────────────────────

describe("SwarmExecutor — concatenate merger", () => {
  it("joined output contains section headers for each clone", async () => {
    const executor = new SwarmExecutor(makeGateway([]), makeTeamRegistry("output data"), makeWsManager());
    const stage = makeStage(
      makeSwarmConfig({ splitter: "chunks", cloneCount: 2, merger: "concatenate" }),
    );
    const result = await executor.execute(stage, "line1\nline2\nline3\nline4", makeContext(), "stage-1");
    expect(result).not.toBeNull();
    expect(result!.mergedOutput).toContain("## Clone 1");
    expect(result!.mergedOutput).toContain("## Clone 2");
    expect(result!.mergedOutput).toContain("---");
  });
});

// ─── llm_merge merger ─────────────────────────────────────────────────────────

describe("SwarmExecutor — llm_merge merger", () => {
  it("calls gateway for synthesis and returns content", async () => {
    const synthesis = "Unified synthesis output";
    const gateway = makeGateway([synthesis]);
    const executor = new SwarmExecutor(gateway, makeTeamRegistry(), makeWsManager());

    const stage = makeStage(
      makeSwarmConfig({ splitter: "chunks", cloneCount: 2, merger: "llm_merge" }),
    );

    const result = await executor.execute(stage, "input\nmore input", makeContext(), "stage-1");
    expect(result).not.toBeNull();
    expect(result!.mergedOutput).toBe(synthesis);
    // Gateway called once for the merge
    expect((gateway.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("synthesis prompt includes all clone outputs", async () => {
    const gateway = makeGateway(["synthesis"]);
    const executor = new SwarmExecutor(gateway, makeTeamRegistry("clone result"), makeWsManager());

    const stage = makeStage(
      makeSwarmConfig({ splitter: "chunks", cloneCount: 2, merger: "llm_merge" }),
    );

    await executor.execute(stage, "a\nb\nc\nd", makeContext(), "stage-1");

    const mergeCall = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    const mergePromptContent = mergeCall[0].messages[0].content as string;
    expect(mergePromptContent).toContain("merging");
    expect(mergePromptContent).toContain("clone result");
  });
});

// ─── vote merger (structured majority) ───────────────────────────────────────

describe("SwarmExecutor — vote merger", () => {
  it("majority wins: 2 out of 3 clones agree on the same value", async () => {
    // All 3 clones return JSON with result field
    const executor = new SwarmExecutor(makeGateway([]), {
      getTeam: vi.fn().mockReturnValue({
        execute: vi.fn()
          .mockResolvedValueOnce({ output: { raw: '{"result": "approve"}' }, tokensUsed: 5, raw: '{"result": "approve"}' })
          .mockResolvedValueOnce({ output: { raw: '{"result": "approve"}' }, tokensUsed: 5, raw: '{"result": "approve"}' })
          .mockResolvedValueOnce({ output: { raw: '{"result": "reject"}' }, tokensUsed: 5, raw: '{"result": "reject"}' }),
        parseOutput: vi.fn().mockReturnValue({}),
      }),
    } as unknown as TeamRegistry, makeWsManager());

    const stage = makeStage(
      makeSwarmConfig({ splitter: "chunks", cloneCount: 3, merger: "vote" }),
    );

    const result = await executor.execute(stage, "line1\nline2\nline3", makeContext(), "stage-1");
    expect(result).not.toBeNull();
    expect(result!.mergedOutput).toBe(JSON.stringify({ result: "approve" }));
  });

  it("tie on 2 clones falls back to llm_merge", async () => {
    const synthesis = "tie-break synthesis";
    const gateway = makeGateway([synthesis]);
    const executor = new SwarmExecutor(gateway, {
      getTeam: vi.fn().mockReturnValue({
        execute: vi.fn()
          .mockResolvedValueOnce({ output: { raw: '{"result": "yes"}' }, tokensUsed: 5, raw: '{"result": "yes"}' })
          .mockResolvedValueOnce({ output: { raw: '{"result": "no"}' }, tokensUsed: 5, raw: '{"result": "no"}' }),
        parseOutput: vi.fn().mockReturnValue({}),
      }),
    } as unknown as TeamRegistry, makeWsManager());

    const stage = makeStage(
      makeSwarmConfig({ splitter: "chunks", cloneCount: 2, merger: "vote" }),
    );

    const result = await executor.execute(stage, "a\nb\nc\nd", makeContext(), "stage-1");
    expect(result).not.toBeNull();
    // Tie → llm_merge called → returns synthesis
    expect(result!.mergedOutput).toBe(synthesis);
    expect((gateway.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("unstructured output falls back to concatenate with console.warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const executor = new SwarmExecutor(makeGateway([]), {
      getTeam: vi.fn().mockReturnValue({
        execute: vi.fn()
          .mockResolvedValueOnce({ output: { raw: "just plain text output" }, tokensUsed: 5, raw: "just plain text output" })
          .mockResolvedValueOnce({ output: { raw: "more plain text" }, tokensUsed: 5, raw: "more plain text" }),
        parseOutput: vi.fn().mockReturnValue({}),
      }),
    } as unknown as TeamRegistry, makeWsManager());

    const stage = makeStage(
      makeSwarmConfig({ splitter: "chunks", cloneCount: 2, merger: "vote" }),
    );

    const result = await executor.execute(stage, "a\nb\nc\nd", makeContext(), "stage-1");
    expect(result).not.toBeNull();
    // Falls back to concatenate
    expect(result!.mergedOutput).toContain("## Clone");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("falling back to concatenate"));
    warnSpy.mockRestore();
  });
});

// ─── partial failure ──────────────────────────────────────────────────────────

describe("SwarmExecutor — partial failure", () => {
  it("1 of 3 clones fails — merge proceeds on 2 succeeded", async () => {
    const executor = new SwarmExecutor(makeGateway([]), makeFailingTeamRegistry(0), makeWsManager());
    const stage = makeStage(
      makeSwarmConfig({ splitter: "chunks", cloneCount: 3, merger: "concatenate" }),
    );

    const result = await executor.execute(stage, "line1\nline2\nline3", makeContext(), "stage-1");
    expect(result).not.toBeNull();
    expect(result!.succeededCount).toBe(2);
    expect(result!.failedCount).toBe(1);
    expect(result!.cloneResults).toHaveLength(3);
  });

  it("failed clone has status 'failed'", async () => {
    const executor = new SwarmExecutor(makeGateway([]), makeFailingTeamRegistry(1), makeWsManager());
    const stage = makeStage(
      makeSwarmConfig({ splitter: "chunks", cloneCount: 3, merger: "concatenate" }),
    );

    const result = await executor.execute(stage, "line1\nline2\nline3", makeContext(), "stage-1");
    expect(result).not.toBeNull();
    const failedClone = result!.cloneResults.find((r) => r.status === "failed");
    expect(failedClone).toBeDefined();
    expect(failedClone!.error).toBeDefined();
  });

  it("uses Promise.allSettled semantics — does not short-circuit on first failure", async () => {
    let execCount = 0;
    const registry: TeamRegistry = {
      getTeam: vi.fn().mockReturnValue({
        execute: vi.fn().mockImplementation(() => {
          execCount++;
          if (execCount === 1) return Promise.reject(new Error("first fails"));
          return Promise.resolve({ output: { raw: "ok" }, tokensUsed: 5, raw: "ok" } satisfies TeamResult);
        }),
        parseOutput: vi.fn().mockReturnValue({}),
      }),
    } as unknown as TeamRegistry;

    const executor = new SwarmExecutor(makeGateway([]), registry, makeWsManager());
    const stage = makeStage(makeSwarmConfig({ splitter: "chunks", cloneCount: 3, merger: "concatenate" }));
    const result = await executor.execute(stage, "a\nb\nc", makeContext(), "stage-1");

    expect(execCount).toBe(3); // All 3 ran
    expect(result!.succeededCount).toBe(2);
  });
});

// ─── all clones fail ──────────────────────────────────────────────────────────

describe("SwarmExecutor — all clones fail", () => {
  it("throws SwarmAllFailedError when all clones fail", async () => {
    const executor = new SwarmExecutor(makeGateway([]), makeAllFailingTeamRegistry(), makeWsManager());
    const stage = makeStage(makeSwarmConfig({ splitter: "chunks", cloneCount: 2, merger: "concatenate" }));

    await expect(
      executor.execute(stage, "some input", makeContext(), "stage-1"),
    ).rejects.toThrow(SwarmAllFailedError);
  });

  it("SwarmAllFailedError contains cloneResults", async () => {
    const executor = new SwarmExecutor(makeGateway([]), makeAllFailingTeamRegistry(), makeWsManager());
    const stage = makeStage(makeSwarmConfig({ splitter: "chunks", cloneCount: 2, merger: "concatenate" }));

    try {
      await executor.execute(stage, "some input", makeContext(), "stage-1");
      expect.fail("Should have thrown SwarmAllFailedError");
    } catch (err) {
      expect(err).toBeInstanceOf(SwarmAllFailedError);
      const swarmErr = err as SwarmAllFailedError;
      expect(swarmErr.cloneResults).toHaveLength(2);
      expect(swarmErr.cloneResults.every((r) => r.status === "failed")).toBe(true);
    }
  });

  it("error message contains clone count", async () => {
    const executor = new SwarmExecutor(makeGateway([]), makeAllFailingTeamRegistry(), makeWsManager());
    const stage = makeStage(makeSwarmConfig({ splitter: "chunks", cloneCount: 3, merger: "concatenate" }));

    try {
      await executor.execute(stage, "some input", makeContext(), "stage-1");
      expect.fail("Should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("3");
    }
  });
});

// ─── Zod schema validation ────────────────────────────────────────────────────

describe("SwarmConfigSchema — Zod validation", () => {
  it("cloneCount=1 is rejected (min 2)", () => {
    const result = SwarmConfigSchema.safeParse({
      enabled: true,
      cloneCount: 1,
      splitter: "chunks",
      merger: "concatenate",
    });
    expect(result.success).toBe(false);
  });

  it("cloneCount=0 is rejected", () => {
    const result = SwarmConfigSchema.safeParse({
      enabled: true,
      cloneCount: 0,
      splitter: "chunks",
      merger: "concatenate",
    });
    expect(result.success).toBe(false);
  });

  it("cloneCount=21 is rejected (max 20)", () => {
    const result = SwarmConfigSchema.safeParse({
      enabled: true,
      cloneCount: 21,
      splitter: "chunks",
      merger: "concatenate",
    });
    expect(result.success).toBe(false);
  });

  it("cloneCount=2 is accepted (minimum)", () => {
    const result = SwarmConfigSchema.safeParse({
      enabled: true,
      cloneCount: 2,
      splitter: "chunks",
      merger: "concatenate",
    });
    expect(result.success).toBe(true);
  });

  it("cloneCount=20 is accepted (maximum)", () => {
    const result = SwarmConfigSchema.safeParse({
      enabled: true,
      cloneCount: 20,
      splitter: "chunks",
      merger: "concatenate",
    });
    expect(result.success).toBe(true);
  });

  it("custom splitter with mismatched customClonePrompts length is rejected", () => {
    const result = SwarmConfigSchema.safeParse({
      enabled: true,
      cloneCount: 3,
      splitter: "custom",
      merger: "concatenate",
      customClonePrompts: ["prompt1", "prompt2"], // only 2, but cloneCount=3
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("customClonePrompts length must equal cloneCount");
    }
  });

  it("custom splitter with matching customClonePrompts length is accepted", () => {
    const result = SwarmConfigSchema.safeParse({
      enabled: true,
      cloneCount: 2,
      splitter: "custom",
      merger: "concatenate",
      customClonePrompts: ["prompt1", "prompt2"],
    });
    expect(result.success).toBe(true);
  });

  it("chunks splitter without customClonePrompts is accepted", () => {
    const result = SwarmConfigSchema.safeParse({
      enabled: true,
      cloneCount: 3,
      splitter: "chunks",
      merger: "llm_merge",
    });
    expect(result.success).toBe(true);
  });
});

describe("SwarmPerspectiveSchema — Zod validation", () => {
  it("valid perspective passes", () => {
    const result = SwarmPerspectiveSchema.safeParse({
      label: "Security Review",
      systemPromptSuffix: "Focus on security.",
    });
    expect(result.success).toBe(true);
  });

  it("empty label is rejected", () => {
    const result = SwarmPerspectiveSchema.safeParse({
      label: "",
      systemPromptSuffix: "Focus on security.",
    });
    expect(result.success).toBe(false);
  });
});

// ─── WS event broadcasting ────────────────────────────────────────────────────

describe("SwarmExecutor — WS event broadcasting", () => {
  it("broadcasts swarm:started event", async () => {
    const wsManager = makeWsManager();
    const executor = new SwarmExecutor(makeGateway([]), makeTeamRegistry(), wsManager);
    const stage = makeStage(makeSwarmConfig({ splitter: "chunks", cloneCount: 2 }));

    await executor.execute(stage, "line1\nline2", makeContext(), "stage-1");

    const calls = (wsManager.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls;
    const startedEvent = calls.find((c) => (c[1] as { type: string }).type === "swarm:started");
    expect(startedEvent).toBeDefined();
  });

  it("broadcasts swarm:clone:started for each clone", async () => {
    const wsManager = makeWsManager();
    const executor = new SwarmExecutor(makeGateway([]), makeTeamRegistry(), wsManager);
    const stage = makeStage(makeSwarmConfig({ splitter: "chunks", cloneCount: 3 }));

    await executor.execute(stage, "a\nb\nc", makeContext(), "stage-1");

    const calls = (wsManager.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls;
    const cloneStarted = calls.filter((c) => (c[1] as { type: string }).type === "swarm:clone:started");
    expect(cloneStarted).toHaveLength(3);
  });

  it("broadcasts swarm:clone:completed for each succeeded clone", async () => {
    const wsManager = makeWsManager();
    const executor = new SwarmExecutor(makeGateway([]), makeTeamRegistry(), wsManager);
    const stage = makeStage(makeSwarmConfig({ splitter: "chunks", cloneCount: 2 }));

    await executor.execute(stage, "a\nb", makeContext(), "stage-1");

    const calls = (wsManager.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls;
    const completed = calls.filter((c) => (c[1] as { type: string }).type === "swarm:clone:completed");
    expect(completed).toHaveLength(2);
  });

  it("broadcasts swarm:clone:failed for failed clones", async () => {
    const wsManager = makeWsManager();
    const executor = new SwarmExecutor(makeGateway([]), makeFailingTeamRegistry(0), wsManager);
    const stage = makeStage(makeSwarmConfig({ splitter: "chunks", cloneCount: 2 }));

    await executor.execute(stage, "a\nb", makeContext(), "stage-1");

    const calls = (wsManager.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls;
    const failedEvents = calls.filter((c) => (c[1] as { type: string }).type === "swarm:clone:failed");
    expect(failedEvents).toHaveLength(1);
  });

  it("broadcasts swarm:merging event before merge", async () => {
    const wsManager = makeWsManager();
    const executor = new SwarmExecutor(makeGateway([]), makeTeamRegistry(), wsManager);
    const stage = makeStage(makeSwarmConfig({ splitter: "chunks", cloneCount: 2 }));

    await executor.execute(stage, "a\nb", makeContext(), "stage-1");

    const calls = (wsManager.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls;
    const mergingEvent = calls.find((c) => (c[1] as { type: string }).type === "swarm:merging");
    expect(mergingEvent).toBeDefined();
  });

  it("broadcasts swarm:completed event at end", async () => {
    const wsManager = makeWsManager();
    const executor = new SwarmExecutor(makeGateway([]), makeTeamRegistry(), wsManager);
    const stage = makeStage(makeSwarmConfig({ splitter: "chunks", cloneCount: 2 }));

    await executor.execute(stage, "a\nb", makeContext(), "stage-1");

    const calls = (wsManager.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls;
    const completedEvent = calls.find((c) => (c[1] as { type: string }).type === "swarm:completed");
    expect(completedEvent).toBeDefined();
  });

  it("event sequence: started → clone:started×N → clone:completed×N → merging → completed", async () => {
    const wsManager = makeWsManager();
    const executor = new SwarmExecutor(makeGateway([]), makeTeamRegistry(), wsManager);
    const stage = makeStage(makeSwarmConfig({ splitter: "chunks", cloneCount: 2 }));

    await executor.execute(stage, "a\nb", makeContext(), "stage-1");

    const calls = (wsManager.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls;
    const types = calls.map((c) => (c[1] as { type: string }).type);

    const startedIdx = types.indexOf("swarm:started");
    const mergingIdx = types.indexOf("swarm:merging");
    const completedIdx = types.indexOf("swarm:completed");
    const cloneStartedIndices = types.map((t, i) => (t === "swarm:clone:started" ? i : -1)).filter((i) => i >= 0);

    expect(startedIdx).toBeLessThan(cloneStartedIndices[0]);
    expect(mergingIdx).toBeGreaterThan(Math.max(...cloneStartedIndices));
    expect(completedIdx).toBeGreaterThan(mergingIdx);
  });
});
