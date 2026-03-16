import { describe, it, expect } from "vitest";
import {
  evaluateAutoApproveConditions,
  type GateEvaluationInput,
} from "../../server/services/approval-gate-evaluator";
import type { StageExecution, LlmRequest } from "@shared/schema";
import type { ApprovalGateConfig } from "@shared/types";

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeStageExecution(overrides: Partial<StageExecution> = {}): StageExecution {
  return {
    id: "se-1",
    runId: "run-1",
    stageIndex: 0,
    teamId: "development",
    modelSlug: "gpt-4",
    status: "completed",
    input: {},
    output: null,
    tokensUsed: 100,
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: new Date("2026-01-01T00:05:00Z"),
    sandboxResult: null,
    thoughtTree: null,
    approvalStatus: null,
    approvedAt: null,
    approvedBy: null,
    rejectionReason: null,
    dagStageId: null,
    approvalGateConfig: null,
    autoApprovalReason: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeLlmRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    id: 1,
    runId: "run-1",
    stageExecutionId: "se-1",
    modelSlug: "gpt-4",
    provider: "mock",
    messages: [],
    systemPrompt: null,
    temperature: null,
    maxTokens: null,
    responseContent: "",
    inputTokens: 500,
    outputTokens: 200,
    totalTokens: 700,
    latencyMs: 1000,
    estimatedCostUsd: 0.10,
    status: "success",
    errorMessage: null,
    teamId: "development",
    tags: [],
    createdAt: new Date(),
    ...overrides,
  };
}

function makeInput(
  gateConfig: ApprovalGateConfig,
  stageOverrides?: Partial<StageExecution>,
  llmRequests?: LlmRequest[],
): GateEvaluationInput {
  return {
    gateConfig,
    stageExecution: makeStageExecution(stageOverrides),
    stageLlmRequests: llmRequests ?? [makeLlmRequest()],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("evaluateAutoApproveConditions", () => {
  describe("non-auto gate types", () => {
    it("returns false for manual gate type", () => {
      const result = evaluateAutoApproveConditions(
        makeInput({ type: "manual" }),
      );
      expect(result.shouldAutoApprove).toBe(false);
      expect(result.reason).toContain("No auto-approve conditions");
    });

    it("returns false for timeout gate type", () => {
      const result = evaluateAutoApproveConditions(
        makeInput({ type: "timeout", timeoutMinutes: 5 }),
      );
      expect(result.shouldAutoApprove).toBe(false);
    });

    it("returns false for auto gate with empty conditions", () => {
      const result = evaluateAutoApproveConditions(
        makeInput({ type: "auto", conditions: [] }),
      );
      expect(result.shouldAutoApprove).toBe(false);
    });
  });

  describe("cost conditions", () => {
    it("auto-approves when cost is below threshold", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          { type: "auto", conditions: [{ field: "cost", operator: "lt", value: 0.50 }] },
          {},
          [makeLlmRequest({ estimatedCostUsd: 0.10 })],
        ),
      );
      expect(result.shouldAutoApprove).toBe(true);
      expect(result.reason).toContain("All conditions met");
    });

    it("rejects when cost exceeds threshold", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          { type: "auto", conditions: [{ field: "cost", operator: "lt", value: 0.05 }] },
          {},
          [makeLlmRequest({ estimatedCostUsd: 0.10 })],
        ),
      );
      expect(result.shouldAutoApprove).toBe(false);
      expect(result.reason).toContain("Conditions not met");
    });

    it("sums costs across multiple LLM requests", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          { type: "auto", conditions: [{ field: "cost", operator: "lte", value: 0.30 }] },
          {},
          [
            makeLlmRequest({ estimatedCostUsd: 0.10 }),
            makeLlmRequest({ id: 2, estimatedCostUsd: 0.15 }),
          ],
        ),
      );
      expect(result.shouldAutoApprove).toBe(true);
    });

    it("handles null cost values", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          { type: "auto", conditions: [{ field: "cost", operator: "lt", value: 1.0 }] },
          {},
          [makeLlmRequest({ estimatedCostUsd: null })],
        ),
      );
      expect(result.shouldAutoApprove).toBe(true);
    });
  });

  describe("token conditions", () => {
    it("auto-approves when tokens are within limit", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          { type: "auto", conditions: [{ field: "tokens", operator: "lte", value: 1000 }] },
          {},
          [makeLlmRequest({ totalTokens: 700 })],
        ),
      );
      expect(result.shouldAutoApprove).toBe(true);
    });

    it("rejects when tokens exceed limit", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          { type: "auto", conditions: [{ field: "tokens", operator: "lt", value: 500 }] },
          {},
          [makeLlmRequest({ totalTokens: 700 })],
        ),
      );
      expect(result.shouldAutoApprove).toBe(false);
    });
  });

  describe("duration conditions", () => {
    it("auto-approves when duration is within limit", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          { type: "auto", conditions: [{ field: "duration", operator: "lt", value: 600000 }] },
          {
            startedAt: new Date("2026-01-01T00:00:00Z"),
            completedAt: new Date("2026-01-01T00:05:00Z"), // 5 minutes = 300000ms
          },
        ),
      );
      expect(result.shouldAutoApprove).toBe(true);
    });

    it("rejects when duration exceeds limit", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          { type: "auto", conditions: [{ field: "duration", operator: "lt", value: 60000 }] },
          {
            startedAt: new Date("2026-01-01T00:00:00Z"),
            completedAt: new Date("2026-01-01T00:05:00Z"),
          },
        ),
      );
      expect(result.shouldAutoApprove).toBe(false);
    });
  });

  describe("status conditions", () => {
    it("auto-approves when status matches", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          { type: "auto", conditions: [{ field: "status", operator: "eq", value: "completed" }] },
          { status: "completed" },
        ),
      );
      expect(result.shouldAutoApprove).toBe(true);
    });

    it("rejects when status does not match", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          { type: "auto", conditions: [{ field: "status", operator: "eq", value: "completed" }] },
          { status: "failed" },
        ),
      );
      expect(result.shouldAutoApprove).toBe(false);
    });
  });

  describe("multiple conditions (AND logic)", () => {
    it("auto-approves when all conditions pass", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          {
            type: "auto",
            conditions: [
              { field: "cost", operator: "lt", value: 1.0 },
              { field: "tokens", operator: "lte", value: 2000 },
              { field: "status", operator: "eq", value: "completed" },
            ],
          },
          { status: "completed" },
          [makeLlmRequest({ estimatedCostUsd: 0.10, totalTokens: 700 })],
        ),
      );
      expect(result.shouldAutoApprove).toBe(true);
    });

    it("rejects when any condition fails", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          {
            type: "auto",
            conditions: [
              { field: "cost", operator: "lt", value: 0.05 }, // will fail
              { field: "tokens", operator: "lte", value: 2000 }, // will pass
            ],
          },
          {},
          [makeLlmRequest({ estimatedCostUsd: 0.10 })],
        ),
      );
      expect(result.shouldAutoApprove).toBe(false);
      expect(result.reason).toContain("cost");
    });
  });

  describe("operator coverage", () => {
    it("supports gt operator", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          { type: "auto", conditions: [{ field: "tokens", operator: "gt", value: 100 }] },
          {},
          [makeLlmRequest({ totalTokens: 700 })],
        ),
      );
      expect(result.shouldAutoApprove).toBe(true);
    });

    it("supports gte operator", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          { type: "auto", conditions: [{ field: "tokens", operator: "gte", value: 700 }] },
          {},
          [makeLlmRequest({ totalTokens: 700 })],
        ),
      );
      expect(result.shouldAutoApprove).toBe(true);
    });

    it("supports eq operator for numbers", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          { type: "auto", conditions: [{ field: "tokens", operator: "eq", value: 700 }] },
          {},
          [makeLlmRequest({ totalTokens: 700 })],
        ),
      );
      expect(result.shouldAutoApprove).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles empty LLM requests (cost = 0)", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          { type: "auto", conditions: [{ field: "cost", operator: "lt", value: 1.0 }] },
          {},
          [],
        ),
      );
      expect(result.shouldAutoApprove).toBe(true);
    });

    it("handles missing timestamps (duration = 0)", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          { type: "auto", conditions: [{ field: "duration", operator: "lt", value: 60000 }] },
          { startedAt: null, completedAt: null },
        ),
      );
      expect(result.shouldAutoApprove).toBe(true);
    });

    it("reason includes details about each condition", () => {
      const result = evaluateAutoApproveConditions(
        makeInput(
          {
            type: "auto",
            conditions: [
              { field: "cost", operator: "lt", value: 0.50 },
            ],
          },
          {},
          [makeLlmRequest({ estimatedCostUsd: 0.10 })],
        ),
      );
      expect(result.reason).toContain("PASS");
      expect(result.reason).toContain("cost");
      expect(result.reason).toContain("lt");
    });
  });
});
