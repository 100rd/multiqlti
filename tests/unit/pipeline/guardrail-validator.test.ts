/**
 * Unit tests for GuardrailValidator and applyGuardrails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GuardrailValidator } from "../../../server/pipeline/guardrail-validator.js";
import { applyGuardrails, GuardrailError } from "../../../server/pipeline/guardrail-runner.js";
import type { Gateway } from "../../../server/gateway/index.js";
import type { StageGuardrail } from "../../../shared/types.js";
import type { WsManager } from "../../../server/ws/manager.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGateway(responseContent: string): Gateway {
  return {
    complete: vi.fn().mockResolvedValue({
      content: responseContent,
      tokensUsed: 5,
      modelSlug: "mock",
      finishReason: "stop",
    }),
    stream: vi.fn(),
    completeWithTools: vi.fn(),
  } as unknown as Gateway;
}

function makeWsManager(): WsManager {
  return {
    broadcastToRun: vi.fn(),
  } as unknown as WsManager;
}

function guardrail(overrides: Partial<StageGuardrail> = {}): StageGuardrail {
  return {
    id: "g1",
    type: "json_schema",
    config: {},
    onFail: "fail",
    maxRetries: 1,
    enabled: true,
    ...overrides,
  };
}

// ─── json_schema ──────────────────────────────────────────────────────────────

describe("GuardrailValidator — json_schema", () => {
  let validator: GuardrailValidator;

  beforeEach(() => {
    validator = new GuardrailValidator(makeGateway("YES"));
  });

  it("passes when all required fields are present", async () => {
    const output = JSON.stringify({ techStack: "React", components: ["Header"] });
    const g = guardrail({
      type: "json_schema",
      config: { schema: { required: ["techStack", "components"] } },
    });
    const result = await validator.validate(output, g);
    expect(result.passed).toBe(true);
  });

  it("fails when a required field is missing", async () => {
    const output = JSON.stringify({ techStack: "React" });
    const g = guardrail({
      type: "json_schema",
      config: { schema: { required: ["techStack", "components"] } },
    });
    const result = await validator.validate(output, g);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/components/);
  });

  it("fails when output is not valid JSON", async () => {
    const g = guardrail({
      type: "json_schema",
      config: { schema: { required: ["techStack"] } },
    });
    const result = await validator.validate("not json", g);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/valid JSON/);
  });

  it("fails when output JSON is an array not an object", async () => {
    const g = guardrail({
      type: "json_schema",
      config: { schema: { required: ["techStack"] } },
    });
    const result = await validator.validate("[1,2,3]", g);
    expect(result.passed).toBe(false);
  });

  it("fails on type mismatch when properties.type is defined", async () => {
    const output = JSON.stringify({ count: "not-a-number" });
    const g = guardrail({
      type: "json_schema",
      config: {
        schema: {
          required: ["count"],
          properties: { count: { type: "number" } },
        },
      },
    });
    const result = await validator.validate(output, g);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/count/);
  });

  it("passes with no required fields constraint", async () => {
    const g = guardrail({ type: "json_schema", config: { schema: {} } });
    const result = await validator.validate('{"anything": true}', g);
    expect(result.passed).toBe(true);
  });
});

// ─── regex ────────────────────────────────────────────────────────────────────

describe("GuardrailValidator — regex", () => {
  let validator: GuardrailValidator;

  beforeEach(() => {
    validator = new GuardrailValidator(makeGateway("YES"));
  });

  it("passes when output matches pattern", async () => {
    const g = guardrail({ type: "regex", config: { pattern: "techStack" } });
    const result = await validator.validate("The techStack is React", g);
    expect(result.passed).toBe(true);
  });

  it("fails when output does not match pattern", async () => {
    const g = guardrail({ type: "regex", config: { pattern: "techStack" } });
    const result = await validator.validate("No matching content", g);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/pattern/);
  });

  it("fails gracefully on invalid regex pattern", async () => {
    const g = guardrail({ type: "regex", config: { pattern: "[invalid" } });
    const result = await validator.validate("any output", g);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/invalid regex/i);
  });
});

// ─── custom ───────────────────────────────────────────────────────────────────

describe("GuardrailValidator — custom", () => {
  let validator: GuardrailValidator;

  beforeEach(() => {
    validator = new GuardrailValidator(makeGateway("YES"));
  });

  it("passes when expression returns true", async () => {
    const g = guardrail({
      type: "custom",
      config: { validatorCode: "output.includes('techStack')" },
    });
    const result = await validator.validate("techStack: React", g);
    expect(result.passed).toBe(true);
  });

  it("fails when expression returns false", async () => {
    const g = guardrail({
      type: "custom",
      config: { validatorCode: "output.includes('techStack')" },
    });
    const result = await validator.validate("no match here", g);
    expect(result.passed).toBe(false);
  });

  it("fails gracefully when expression throws", async () => {
    // Use a function call that throws — throw is a statement, not an expression,
    // so we wrap it in an IIFE inside the expression
    const g = guardrail({
      type: "custom",
      config: { validatorCode: "(() => { throw new Error('boom') })()" },
    });
    const result = await validator.validate("any", g);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/boom/);
  });

  it("rejects oversized code (> 500 chars)", async () => {
    const g = guardrail({
      type: "custom",
      config: { validatorCode: "x".repeat(501) },
    });
    const result = await validator.validate("any", g);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/max length/i);
  });
});

// ─── llm_check ────────────────────────────────────────────────────────────────

describe("GuardrailValidator — llm_check", () => {
  it("passes when LLM responds with YES", async () => {
    const validator = new GuardrailValidator(makeGateway("YES — looks good"));
    const g = guardrail({
      type: "llm_check",
      config: { llmPrompt: "Is this valid?", llmModelSlug: "mock" },
    });
    const result = await validator.validate("some output", g);
    expect(result.passed).toBe(true);
  });

  it("fails when LLM responds with NO", async () => {
    const validator = new GuardrailValidator(makeGateway("NO — invalid format"));
    const g = guardrail({
      type: "llm_check",
      config: { llmPrompt: "Is this valid?", llmModelSlug: "mock" },
    });
    const result = await validator.validate("some output", g);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/NO/i);
  });
});

// ─── applyGuardrails — onFail policies ───────────────────────────────────────

describe("applyGuardrails — onFail policies", () => {
  const wsManager = makeWsManager();

  it("continues past a passed guardrail", async () => {
    const validator = new GuardrailValidator(makeGateway("YES"));
    const g = guardrail({ type: "regex", config: { pattern: "hello" }, onFail: "fail" });

    const result = await applyGuardrails("hello world", {
      stageId: "stage-1",
      runId: "run-1",
      guardrails: [g],
      validator,
      wsManager,
      executeStage: vi.fn(),
    });

    expect(result.output).toBe("hello world");
    expect(result.guardrailResults).toHaveLength(1);
    expect(result.guardrailResults[0].passed).toBe(true);
  });

  it("onFail: fail — throws GuardrailError", async () => {
    const validator = new GuardrailValidator(makeGateway("YES"));
    const g = guardrail({ type: "regex", config: { pattern: "NOTPRESENT" }, onFail: "fail" });

    await expect(
      applyGuardrails("hello", {
        stageId: "stage-1",
        runId: "run-1",
        guardrails: [g],
        validator,
        wsManager,
        executeStage: vi.fn(),
      }),
    ).rejects.toThrowError(GuardrailError);
  });

  it("onFail: skip — records failure and continues with original output", async () => {
    const validator = new GuardrailValidator(makeGateway("YES"));
    const g = guardrail({ type: "regex", config: { pattern: "NOTPRESENT" }, onFail: "skip" });

    const result = await applyGuardrails("hello", {
      stageId: "stage-1",
      runId: "run-1",
      guardrails: [g],
      validator,
      wsManager,
      executeStage: vi.fn(),
    });

    expect(result.output).toBe("hello");
    expect(result.guardrailResults[0].passed).toBe(false);
  });

  it("onFail: fallback — replaces output with fallbackValue", async () => {
    const validator = new GuardrailValidator(makeGateway("YES"));
    const g = guardrail({
      type: "regex",
      config: { pattern: "NOTPRESENT" },
      onFail: "fallback",
      fallbackValue: "DEFAULT_OUTPUT",
    });

    const result = await applyGuardrails("hello", {
      stageId: "stage-1",
      runId: "run-1",
      guardrails: [g],
      validator,
      wsManager,
      executeStage: vi.fn(),
    });

    expect(result.output).toBe("DEFAULT_OUTPUT");
  });

  it("onFail: retry — retries up to maxRetries then fails", async () => {
    const validator = new GuardrailValidator(makeGateway("YES"));
    // Guardrail always fails (regex won't match)
    const g = guardrail({
      type: "regex",
      config: { pattern: "IMPOSSIBLE" },
      onFail: "retry",
      maxRetries: 2,
    });

    const executeStage = vi.fn().mockResolvedValue("still no match");

    await expect(
      applyGuardrails("initial", {
        stageId: "stage-1",
        runId: "run-1",
        guardrails: [g],
        validator,
        wsManager,
        executeStage,
      }),
    ).rejects.toThrowError(GuardrailError);

    // Should have been called maxRetries times
    expect(executeStage).toHaveBeenCalledTimes(2);
  });

  it("onFail: retry — succeeds if retry output passes", async () => {
    const validator = new GuardrailValidator(makeGateway("YES"));
    const g = guardrail({
      type: "regex",
      config: { pattern: "SUCCESS" },
      onFail: "retry",
      maxRetries: 2,
    });

    // First call returns passing output
    const executeStage = vi.fn().mockResolvedValue("SUCCESS content");

    const result = await applyGuardrails("initial failure", {
      stageId: "stage-1",
      runId: "run-1",
      guardrails: [g],
      validator,
      wsManager,
      executeStage,
    });

    expect(result.output).toBe("SUCCESS content");
    expect(executeStage).toHaveBeenCalledTimes(1);
  });

  it("skips disabled guardrails", async () => {
    const validator = new GuardrailValidator(makeGateway("YES"));
    const g = guardrail({
      type: "regex",
      config: { pattern: "IMPOSSIBLE" },
      onFail: "fail",
      enabled: false,
    });

    const result = await applyGuardrails("hello", {
      stageId: "stage-1",
      runId: "run-1",
      guardrails: [g],
      validator,
      wsManager,
      executeStage: vi.fn(),
    });

    expect(result.output).toBe("hello");
    expect(result.guardrailResults).toHaveLength(0);
  });
});
