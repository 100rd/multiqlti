/**
 * Unit tests for server/pipeline/guardrail-runner.ts
 *
 * All validator calls are mocked. Tests verify policy enforcement, retry logic,
 * fallback behaviour, and result metadata accuracy.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyGuardrails, GuardrailError } from "../../../server/pipeline/guardrail-runner.js";
import type { GuardrailRunnerOptions } from "../../../server/pipeline/guardrail-runner.js";
import type { GuardrailValidator } from "../../../server/pipeline/guardrail-validator.js";
import type { StageGuardrail, GuardrailResult } from "../../../shared/types.js";
import type { WsManager } from "../../../server/ws/manager.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWsManager(): WsManager {
  return {
    broadcastToRun: vi.fn(),
  } as unknown as WsManager;
}

function makeGuardrail(
  overrides: Partial<StageGuardrail> = {},
): StageGuardrail {
  return {
    id: "g1",
    type: "regex",
    config: { pattern: ".*" },
    onFail: "fail",
    maxRetries: 1,
    enabled: true,
    ...overrides,
  };
}

function makePassResult(guardrailId = "g1"): GuardrailResult {
  return { guardrailId, passed: true, attempts: 1 };
}

function makeFailResult(guardrailId = "g1", reason = "validation failed"): GuardrailResult {
  return { guardrailId, passed: false, reason, attempts: 1 };
}

function makeValidator(results: GuardrailResult[]): GuardrailValidator {
  let callIndex = 0;
  return {
    validate: vi.fn().mockImplementation(() => {
      const result = results[callIndex] ?? results[results.length - 1];
      callIndex++;
      return Promise.resolve(result);
    }),
  } as unknown as GuardrailValidator;
}

function makeOptions(
  overrides: Partial<GuardrailRunnerOptions> & {
    guardrails?: StageGuardrail[];
    validator?: GuardrailValidator;
    executeStage?: () => Promise<string>;
  } = {},
): GuardrailRunnerOptions {
  return {
    stageId: "stage-1",
    runId: "run-1",
    guardrails: overrides.guardrails ?? [],
    validator: overrides.validator ?? makeValidator([makePassResult()]),
    wsManager: overrides.wsManager ?? makeWsManager(),
    executeStage: overrides.executeStage ?? vi.fn<[], Promise<string>>().mockResolvedValue("retried output"),
    ...overrides,
  };
}

// ─── Empty guardrails ─────────────────────────────────────────────────────────

describe("applyGuardrails — empty guardrails", () => {
  it("returns original output when guardrails array is empty", async () => {
    const result = await applyGuardrails("original output", makeOptions({ guardrails: [] }));
    expect(result.output).toBe("original output");
  });

  it("returns empty guardrailResults when no guardrails", async () => {
    const result = await applyGuardrails("output", makeOptions({ guardrails: [] }));
    expect(result.guardrailResults).toEqual([]);
  });
});

// ─── Disabled guardrails ──────────────────────────────────────────────────────

describe("applyGuardrails — disabled guardrail", () => {
  it("skips disabled guardrails entirely", async () => {
    const validator = makeValidator([makeFailResult()]);
    const guardrail = makeGuardrail({ enabled: false, onFail: "fail" });
    const result = await applyGuardrails("output", makeOptions({ guardrails: [guardrail], validator }));
    expect(validator.validate).not.toHaveBeenCalled();
    expect(result.output).toBe("output");
  });

  it("returns empty results when all guardrails are disabled", async () => {
    const g1 = makeGuardrail({ id: "g1", enabled: false });
    const g2 = makeGuardrail({ id: "g2", enabled: false });
    const result = await applyGuardrails("out", makeOptions({ guardrails: [g1, g2] }));
    expect(result.guardrailResults).toHaveLength(0);
  });
});

// ─── Passing guardrails ───────────────────────────────────────────────────────

describe("applyGuardrails — passing guardrails", () => {
  it("passes through output unchanged when guardrail passes", async () => {
    const validator = makeValidator([makePassResult()]);
    const guardrail = makeGuardrail();
    const result = await applyGuardrails("clean output", makeOptions({ guardrails: [guardrail], validator }));
    expect(result.output).toBe("clean output");
  });

  it("records passed guardrail in results", async () => {
    const validator = makeValidator([makePassResult("g1")]);
    const guardrail = makeGuardrail({ id: "g1" });
    const result = await applyGuardrails("output", makeOptions({ guardrails: [guardrail], validator }));
    expect(result.guardrailResults).toHaveLength(1);
    expect(result.guardrailResults[0].passed).toBe(true);
  });

  it("processes all guardrails in order when all pass", async () => {
    const g1 = makeGuardrail({ id: "g1" });
    const g2 = makeGuardrail({ id: "g2" });
    const validator = makeValidator([makePassResult("g1"), makePassResult("g2")]);
    const result = await applyGuardrails("output", makeOptions({ guardrails: [g1, g2], validator }));
    expect(result.guardrailResults).toHaveLength(2);
  });

  it("broadcasts guardrail:checking for each enabled guardrail", async () => {
    const wsManager = makeWsManager();
    const validator = makeValidator([makePassResult()]);
    const guardrail = makeGuardrail();
    await applyGuardrails("output", makeOptions({ guardrails: [guardrail], validator, wsManager }));
    expect(wsManager.broadcastToRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ type: "guardrail:checking" }),
    );
  });

  it("broadcasts guardrail:passed when guardrail passes", async () => {
    const wsManager = makeWsManager();
    const validator = makeValidator([makePassResult()]);
    const guardrail = makeGuardrail();
    await applyGuardrails("output", makeOptions({ guardrails: [guardrail], validator, wsManager }));
    expect(wsManager.broadcastToRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ type: "guardrail:passed" }),
    );
  });
});

// ─── onFail: skip ────────────────────────────────────────────────────────────

describe("applyGuardrails — onFail: skip", () => {
  it("continues with original output when guardrail fails and onFail is 'skip'", async () => {
    const validator = makeValidator([makeFailResult()]);
    const guardrail = makeGuardrail({ onFail: "skip" });
    const result = await applyGuardrails("original", makeOptions({ guardrails: [guardrail], validator }));
    expect(result.output).toBe("original");
  });

  it("records failure in guardrailResults with onFail: skip", async () => {
    const validator = makeValidator([makeFailResult("g1", "bad output")]);
    const guardrail = makeGuardrail({ id: "g1", onFail: "skip" });
    const result = await applyGuardrails("out", makeOptions({ guardrails: [guardrail], validator }));
    expect(result.guardrailResults[0].passed).toBe(false);
  });

  it("continues to next guardrail after skip", async () => {
    const g1 = makeGuardrail({ id: "g1", onFail: "skip" });
    const g2 = makeGuardrail({ id: "g2", onFail: "fail" });
    const validator = makeValidator([makeFailResult("g1"), makePassResult("g2")]);
    const result = await applyGuardrails("out", makeOptions({ guardrails: [g1, g2], validator }));
    expect(result.guardrailResults).toHaveLength(2);
  });

  it("does not throw when guardrail fails with onFail: skip", async () => {
    const validator = makeValidator([makeFailResult()]);
    const guardrail = makeGuardrail({ onFail: "skip" });
    await expect(
      applyGuardrails("output", makeOptions({ guardrails: [guardrail], validator })),
    ).resolves.not.toThrow();
  });
});

// ─── onFail: fallback ─────────────────────────────────────────────────────────

describe("applyGuardrails — onFail: fallback", () => {
  it("replaces output with fallbackValue when guardrail fails", async () => {
    const validator = makeValidator([makeFailResult()]);
    const guardrail = makeGuardrail({ onFail: "fallback", fallbackValue: "safe default" });
    const result = await applyGuardrails("bad output", makeOptions({ guardrails: [guardrail], validator }));
    expect(result.output).toBe("safe default");
  });

  it("replaces output with empty string when fallbackValue is undefined", async () => {
    const validator = makeValidator([makeFailResult()]);
    const guardrail = makeGuardrail({ onFail: "fallback", fallbackValue: undefined });
    const result = await applyGuardrails("bad output", makeOptions({ guardrails: [guardrail], validator }));
    expect(result.output).toBe("");
  });

  it("records failure in guardrailResults with onFail: fallback", async () => {
    const validator = makeValidator([makeFailResult("g1")]);
    const guardrail = makeGuardrail({ id: "g1", onFail: "fallback", fallbackValue: "fallback" });
    const result = await applyGuardrails("out", makeOptions({ guardrails: [guardrail], validator }));
    expect(result.guardrailResults[0].passed).toBe(false);
  });

  it("does not throw when guardrail fails with onFail: fallback", async () => {
    const validator = makeValidator([makeFailResult()]);
    const guardrail = makeGuardrail({ onFail: "fallback", fallbackValue: "safe" });
    await expect(
      applyGuardrails("bad", makeOptions({ guardrails: [guardrail], validator })),
    ).resolves.not.toThrow();
  });

  it("subsequent guardrail receives the fallback output", async () => {
    const g1 = makeGuardrail({ id: "g1", onFail: "fallback", fallbackValue: "fallback value" });
    const g2 = makeGuardrail({ id: "g2", onFail: "fail" });
    const validator = makeValidator([makeFailResult("g1"), makePassResult("g2")]);
    const result = await applyGuardrails("original", makeOptions({ guardrails: [g1, g2], validator }));
    expect(result.output).toBe("fallback value");
  });
});

// ─── onFail: fail ─────────────────────────────────────────────────────────────

describe("applyGuardrails — onFail: fail", () => {
  it("throws GuardrailError when guardrail fails and onFail is 'fail'", async () => {
    const validator = makeValidator([makeFailResult("g1", "schema violation")]);
    const guardrail = makeGuardrail({ id: "g1", onFail: "fail" });
    await expect(
      applyGuardrails("bad output", makeOptions({ guardrails: [guardrail], validator })),
    ).rejects.toThrow(GuardrailError);
  });

  it("GuardrailError.guardrailId matches the failed guardrail id", async () => {
    const validator = makeValidator([makeFailResult("my-guard")]);
    const guardrail = makeGuardrail({ id: "my-guard", onFail: "fail" });
    try {
      await applyGuardrails("bad", makeOptions({ guardrails: [guardrail], validator }));
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GuardrailError);
      expect((err as GuardrailError).guardrailId).toBe("my-guard");
    }
  });

  it("GuardrailError.stageId matches the stageId option", async () => {
    const validator = makeValidator([makeFailResult("g1")]);
    const guardrail = makeGuardrail({ id: "g1", onFail: "fail" });
    try {
      await applyGuardrails("bad", makeOptions({ guardrails: [guardrail], validator, stageId: "stage-99" }));
      expect.fail("Should have thrown");
    } catch (err) {
      expect((err as GuardrailError).stageId).toBe("stage-99");
    }
  });

  it("GuardrailError message includes the guardrail id", async () => {
    const validator = makeValidator([makeFailResult("guard-x")]);
    const guardrail = makeGuardrail({ id: "guard-x", onFail: "fail" });
    try {
      await applyGuardrails("bad", makeOptions({ guardrails: [guardrail], validator }));
      expect.fail("Should have thrown");
    } catch (err) {
      expect((err as GuardrailError).message).toContain("guard-x");
    }
  });

  it("records failure result before throwing", async () => {
    const validator = makeValidator([makeFailResult("g1")]);
    const guardrail = makeGuardrail({ id: "g1", onFail: "fail" });
    // We just check it throws — the result is not returned on throw path
    await expect(
      applyGuardrails("bad", makeOptions({ guardrails: [guardrail], validator })),
    ).rejects.toBeInstanceOf(GuardrailError);
  });
});

// ─── onFail: retry ────────────────────────────────────────────────────────────

describe("applyGuardrails — onFail: retry", () => {
  it("calls executeStage on failure when onFail is 'retry'", async () => {
    const executeStage = vi.fn<[], Promise<string>>().mockResolvedValue("retried output");
    const validator = makeValidator([makeFailResult(), makePassResult()]);
    const guardrail = makeGuardrail({ onFail: "retry", maxRetries: 1 });
    await applyGuardrails("first output", makeOptions({ guardrails: [guardrail], validator, executeStage }));
    expect(executeStage).toHaveBeenCalledOnce();
  });

  it("returns new output after successful retry", async () => {
    const executeStage = vi.fn<[], Promise<string>>().mockResolvedValue("retried output");
    const validator = makeValidator([makeFailResult(), makePassResult()]);
    const guardrail = makeGuardrail({ onFail: "retry", maxRetries: 1 });
    const result = await applyGuardrails("first output", makeOptions({ guardrails: [guardrail], validator, executeStage }));
    expect(result.output).toBe("retried output");
  });

  it("throws GuardrailError after maxRetries exhausted", async () => {
    const executeStage = vi.fn<[], Promise<string>>().mockResolvedValue("still bad");
    // All calls fail
    const validator = makeValidator([makeFailResult(), makeFailResult(), makeFailResult()]);
    const guardrail = makeGuardrail({ onFail: "retry", maxRetries: 2 });
    await expect(
      applyGuardrails("bad", makeOptions({ guardrails: [guardrail], validator, executeStage })),
    ).rejects.toBeInstanceOf(GuardrailError);
  });

  it("calls executeStage up to maxRetries times on persistent failure", async () => {
    const executeStage = vi.fn<[], Promise<string>>().mockResolvedValue("bad");
    const validator = makeValidator([
      makeFailResult(), makeFailResult(), makeFailResult(), makeFailResult(),
    ]);
    const guardrail = makeGuardrail({ onFail: "retry", maxRetries: 2 });
    try {
      await applyGuardrails("bad", makeOptions({ guardrails: [guardrail], validator, executeStage }));
    } catch {
      // expected
    }
    expect(executeStage).toHaveBeenCalledTimes(2);
  });

  it("broadcasts guardrail:retrying event on each retry attempt", async () => {
    const wsManager = makeWsManager();
    const executeStage = vi.fn<[], Promise<string>>().mockResolvedValue("still bad");
    const validator = makeValidator([makeFailResult(), makeFailResult(), makeFailResult()]);
    const guardrail = makeGuardrail({ onFail: "retry", maxRetries: 2 });
    try {
      await applyGuardrails("bad", makeOptions({ guardrails: [guardrail], validator, executeStage, wsManager }));
    } catch {
      // expected
    }
    const retryBroadcasts = (wsManager.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => (call[1] as { type: string }).type === "guardrail:retrying",
    );
    expect(retryBroadcasts.length).toBeGreaterThanOrEqual(1);
  });

  it("GuardrailError message mentions retries when retries exhausted", async () => {
    const executeStage = vi.fn<[], Promise<string>>().mockResolvedValue("bad");
    const validator = makeValidator([makeFailResult(), makeFailResult(), makeFailResult()]);
    const guardrail = makeGuardrail({ id: "g-retry", onFail: "retry", maxRetries: 2 });
    try {
      await applyGuardrails("bad", makeOptions({ guardrails: [guardrail], validator, executeStage }));
      expect.fail("Should have thrown");
    } catch (err) {
      expect((err as GuardrailError).message).toMatch(/retries|retry/i);
    }
  });
});

// ─── GuardrailRunResult metadata ──────────────────────────────────────────────

describe("applyGuardrails — GuardrailRunResult metadata", () => {
  it("guardrailResults array length matches number of processed guardrails", async () => {
    const g1 = makeGuardrail({ id: "g1" });
    const g2 = makeGuardrail({ id: "g2" });
    const validator = makeValidator([makePassResult("g1"), makePassResult("g2")]);
    const result = await applyGuardrails("out", makeOptions({ guardrails: [g1, g2], validator }));
    expect(result.guardrailResults).toHaveLength(2);
  });

  it("guardrailResult entries have guardrailId, passed, and attempts fields", async () => {
    const validator = makeValidator([makePassResult("g1")]);
    const guardrail = makeGuardrail({ id: "g1" });
    const result = await applyGuardrails("out", makeOptions({ guardrails: [guardrail], validator }));
    const entry = result.guardrailResults[0];
    expect(entry).toHaveProperty("guardrailId");
    expect(entry).toHaveProperty("passed");
    expect(entry).toHaveProperty("attempts");
  });

  it("excludes disabled guardrails from guardrailResults", async () => {
    const g1 = makeGuardrail({ id: "g1", enabled: true });
    const g2 = makeGuardrail({ id: "g2", enabled: false });
    const validator = makeValidator([makePassResult("g1")]);
    const result = await applyGuardrails("out", makeOptions({ guardrails: [g1, g2], validator }));
    expect(result.guardrailResults).toHaveLength(1);
    expect(result.guardrailResults[0].guardrailId).toBe("g1");
  });
});

// ─── WS event broadcasting ────────────────────────────────────────────────────

describe("applyGuardrails — WS events", () => {
  it("broadcasts guardrail:failed when a guardrail fails (non-retry path)", async () => {
    const wsManager = makeWsManager();
    const validator = makeValidator([makeFailResult("g1")]);
    const guardrail = makeGuardrail({ id: "g1", onFail: "skip" });
    await applyGuardrails("out", makeOptions({ guardrails: [guardrail], validator, wsManager }));
    expect(wsManager.broadcastToRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ type: "guardrail:failed" }),
    );
  });

  it("passes stageId in broadcast payload", async () => {
    const wsManager = makeWsManager();
    const validator = makeValidator([makePassResult()]);
    const guardrail = makeGuardrail();
    await applyGuardrails("out", makeOptions({
      guardrails: [guardrail],
      validator,
      wsManager,
      stageId: "my-stage",
    }));
    const calls = (wsManager.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls;
    const payloadStageIds = calls.map((c) => (c[1] as { payload: { stageId: string } }).payload.stageId);
    expect(payloadStageIds.every((id) => id === "my-stage")).toBe(true);
  });
});
