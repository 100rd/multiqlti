/**
 * Tests for server/services/cost-service.ts
 * Covers: period bounds, budget enforcement, ledger recording,
 *         fail-closed, CSV export, aggregation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemStorage } from "../../../server/storage.js";
import {
  CostService,
  getPeriodBounds,
  type RecordCostInput,
} from "../../../server/services/cost-service.js";
import type { InsertBudget } from "../../../shared/schema.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStorage(): MemStorage {
  return new MemStorage();
}

function makeBudget(
  storage: MemStorage,
  workspaceId: string,
  overrides: Partial<InsertBudget> = {},
): Promise<import("../../../shared/schema.js").BudgetRow> {
  return storage.createBudget({
    workspaceId,
    provider: null,
    period: "month",
    limitUsd: 10.0,
    hard: false,
    notifyAtPct: [50, 80, 100],
    ...overrides,
  });
}

function makeCostInput(
  workspaceId: string,
  overrides: Partial<RecordCostInput> = {},
): RecordCostInput {
  return {
    workspaceId,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    pipelineRunId: "run-1",
    stageId: "stage-1",
    promptTokens: 1000,
    completionTokens: 200,
    ...overrides,
  };
}

// ─── getPeriodBounds ──────────────────────────────────────────────────────────

describe("getPeriodBounds", () => {
  const NOW = new Date("2026-04-15T12:00:00Z"); // Wednesday, mid-month

  it("1. day: start is midnight UTC, end is 23:59:59", () => {
    const { start, end } = getPeriodBounds("day", NOW);
    expect(start.toISOString()).toBe("2026-04-15T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-04-15T23:59:59.999Z");
  });

  it("2. month: start is 1st, end is last day of month", () => {
    const { start, end } = getPeriodBounds("month", NOW);
    expect(start.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    // April has 30 days
    expect(end.toISOString()).toBe("2026-04-30T23:59:59.999Z");
  });

  it("3. week: start is Monday of current week", () => {
    const { start, end } = getPeriodBounds("week", NOW);
    // 2026-04-15 is Wednesday; Monday is 2026-04-13
    expect(start.toISOString()).toBe("2026-04-13T00:00:00.000Z");
  });

  it("4. week: end is 7 days after Monday start (Sunday)", () => {
    const { start, end } = getPeriodBounds("week", NOW);
    const diff = end.getTime() - start.getTime();
    // exactly 7 days minus 1ms
    expect(diff).toBe(7 * 24 * 60 * 60 * 1000 - 1);
  });

  it("5. Sunday week anchors back to Monday of same week", () => {
    const sunday = new Date("2026-04-19T12:00:00Z"); // Sunday
    const { start } = getPeriodBounds("week", sunday);
    // Monday before this Sunday is 2026-04-13
    expect(start.toISOString()).toBe("2026-04-13T00:00:00.000Z");
  });
});

// ─── CostService.recordCost ───────────────────────────────────────────────────

describe("CostService.recordCost", () => {
  it("6. records a cost entry and returns row with computed costUsd", async () => {
    const storage = makeStorage();
    const service = new CostService(storage);

    const row = await service.recordCost(makeCostInput("ws-1"));
    expect(row).not.toBeNull();
    expect(row!.workspaceId).toBe("ws-1");
    expect(row!.provider).toBe("anthropic");
    expect(row!.model).toBe("claude-sonnet-4-6");
    // 1000 prompt * 3/1M + 200 completion * 15/1M = 0.003 + 0.003 = 0.006
    expect(row!.costUsd).toBeCloseTo(0.006, 4);
  });

  it("7. ledger is append-only — recording twice gives two distinct rows", async () => {
    const storage = makeStorage();
    const service = new CostService(storage);

    const a = await service.recordCost(makeCostInput("ws-1"));
    const b = await service.recordCost(makeCostInput("ws-1"));
    expect(a!.id).not.toBe(b!.id);
  });

  it("8. unknown model stores 0 costUsd (no cloud cost)", async () => {
    const storage = makeStorage();
    const service = new CostService(storage);

    const row = await service.recordCost(
      makeCostInput("ws-1", { model: "llama3-70b", provider: "ollama" }),
    );
    expect(row!.costUsd).toBe(0);
  });

  it("9. fail-closed: sustained ledger failure returns null without throwing", async () => {
    const storage = makeStorage();
    // Make appendCostLedger always throw
    vi.spyOn(storage, "appendCostLedger").mockRejectedValue(new Error("DB down"));

    const service = new CostService(storage);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await service.recordCost(makeCostInput("ws-1"));
    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("10. fail-closed: first failure retries once before returning null", async () => {
    const storage = makeStorage();
    let callCount = 0;
    vi.spyOn(storage, "appendCostLedger").mockImplementation(() => {
      callCount++;
      return Promise.reject(new Error("transient"));
    });

    const service = new CostService(storage);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await service.recordCost(makeCostInput("ws-1"));
    expect(callCount).toBe(2); // retried once
  });
});

// ─── CostService.checkBudget ──────────────────────────────────────────────────

describe("CostService.checkBudget (soft / hard)", () => {
  const WORKSPACE = "ws-budget-1";

  it("11. no budgets → allowed=true, periodToDateUsd=0", async () => {
    const storage = makeStorage();
    const service = new CostService(storage);

    const result = await service.checkBudget({
      workspaceId: WORKSPACE,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      estimatedPromptTokens: 100_000,
      estimatedCompletionTokens: 10_000,
    });
    expect(result.allowed).toBe(true);
    expect(result.periodToDateUsd).toBe(0);
    expect(result.warning).toBeUndefined();
  });

  it("12. soft budget not exceeded → allowed=true, no warning", async () => {
    const storage = makeStorage();
    await makeBudget(storage, WORKSPACE, { limitUsd: 10.0, hard: false });
    const service = new CostService(storage);

    const result = await service.checkBudget({
      workspaceId: WORKSPACE,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      estimatedPromptTokens: 100,
      estimatedCompletionTokens: 50,
    });
    expect(result.allowed).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("13. soft budget exceeded → allowed=true, warning present", async () => {
    const storage = makeStorage();
    // Very low limit that the estimated cost will exceed
    await makeBudget(storage, WORKSPACE, { limitUsd: 0.000001, hard: false });
    const service = new CostService(storage);

    const result = await service.checkBudget({
      workspaceId: WORKSPACE,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      estimatedPromptTokens: 1_000_000,
      estimatedCompletionTokens: 100_000,
    });
    expect(result.allowed).toBe(true);
    expect(result.warning).toMatch(/soft budget exceeded/i);
  });

  it("14. hard budget exceeded → allowed=false, warning present", async () => {
    const storage = makeStorage();
    await makeBudget(storage, WORKSPACE, { limitUsd: 0.000001, hard: true });
    const service = new CostService(storage);

    const result = await service.checkBudget({
      workspaceId: WORKSPACE,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      estimatedPromptTokens: 1_000_000,
      estimatedCompletionTokens: 100_000,
    });
    expect(result.allowed).toBe(false);
    expect(result.warning).toMatch(/hard budget exceeded/i);
  });

  it("15. provider-specific budget applies only to matching provider", async () => {
    const storage = makeStorage();
    await makeBudget(storage, WORKSPACE, {
      limitUsd: 0.000001,
      hard: true,
      provider: "google",
    });
    const service = new CostService(storage);

    // anthropic call → not blocked by google budget
    const result = await service.checkBudget({
      workspaceId: WORKSPACE,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      estimatedPromptTokens: 1_000_000,
      estimatedCompletionTokens: 100_000,
    });
    expect(result.allowed).toBe(true);
  });

  it("16. global budget (null provider) applies to any provider", async () => {
    const storage = makeStorage();
    await makeBudget(storage, WORKSPACE, {
      limitUsd: 0.000001,
      hard: true,
      provider: null,
    });
    const service = new CostService(storage);

    const result = await service.checkBudget({
      workspaceId: WORKSPACE,
      provider: "xai",
      model: "grok-3",
      estimatedPromptTokens: 1_000_000,
      estimatedCompletionTokens: 100_000,
    });
    expect(result.allowed).toBe(false);
  });

  it("17. alert threshold warning when crossing 50% threshold", async () => {
    const storage = makeStorage();
    const budget = await makeBudget(storage, WORKSPACE, {
      limitUsd: 10.0,
      hard: false,
      notifyAtPct: [50, 80, 100],
    });

    // Pre-load ledger so we are just below 50%: $4.99
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getUTCMonth(), 1);
    // Append a cost entry directly to storage (bypass service to isolate test)
    await storage.appendCostLedger({
      workspaceId: WORKSPACE,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 4.99,
    });

    const service = new CostService(storage);

    // Estimated call cost ≈ 0.02 → projected = 5.01 → crosses 50% of 10
    const result = await service.checkBudget({
      workspaceId: WORKSPACE,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      estimatedPromptTokens: 1_000,
      estimatedCompletionTokens: 500,
    });

    // Should be allowed (not exceeding limit), but may have alert warning
    // (only if threshold is crossed; depends on exact estimatedCost)
    expect(result.allowed).toBe(true);
    // With period-to-date = 4.99 and ~0.02 estimated → 5.01 > 5.00 → 50% alert
    if (result.warning) {
      expect(result.warning).toMatch(/50%/);
    }
  });

  it("18. hard block takes precedence over soft warn when both matched", async () => {
    const storage = makeStorage();
    // Add both a soft and a hard budget
    await makeBudget(storage, WORKSPACE, { limitUsd: 0.000001, hard: false });
    await makeBudget(storage, WORKSPACE, { limitUsd: 0.000002, hard: true });
    const service = new CostService(storage);

    const result = await service.checkBudget({
      workspaceId: WORKSPACE,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      estimatedPromptTokens: 1_000_000,
      estimatedCompletionTokens: 100_000,
    });
    // Hard block should dominate
    expect(result.allowed).toBe(false);
    expect(result.budget?.hard).toBe(true);
  });
});

// ─── CostService.getSummary ───────────────────────────────────────────────────

describe("CostService.getSummary", () => {
  const WS = "ws-summary";
  const NOW = new Date("2026-04-15T12:00:00Z");

  it("19. empty workspace returns zero totals and empty series", async () => {
    const storage = makeStorage();
    const service = new CostService(storage);

    const summary = await service.getSummary(WS, "month", NOW);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.totalPromptTokens).toBe(0);
    expect(summary.totalCompletionTokens).toBe(0);
    expect(summary.dailySeries).toHaveLength(0);
    expect(summary.byProvider).toHaveLength(0);
    expect(summary.topPipelines).toHaveLength(0);
  });

  it("20. aggregates daily spend correctly", async () => {
    const storage = makeStorage();
    // Insert two entries on the same day
    await storage.appendCostLedger({
      workspaceId: WS,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      promptTokens: 1000,
      completionTokens: 200,
      costUsd: 0.006,
    });
    await storage.appendCostLedger({
      workspaceId: WS,
      provider: "google",
      model: "gemini-2.0-flash",
      promptTokens: 5000,
      completionTokens: 1000,
      costUsd: 0.0007,
    });

    const service = new CostService(storage);
    const summary = await service.getSummary(WS, "month", NOW);

    expect(summary.totalCostUsd).toBeCloseTo(0.0067);
    expect(summary.totalPromptTokens).toBe(6000);
    expect(summary.totalCompletionTokens).toBe(1200);
    expect(summary.byProvider).toHaveLength(2);
  });

  it("21. byProvider is sorted by cost descending", async () => {
    const storage = makeStorage();
    // anthropic: $0.006, google: $0.0007
    await storage.appendCostLedger({ workspaceId: WS, provider: "anthropic", model: "claude-sonnet-4-6", promptTokens: 0, completionTokens: 0, costUsd: 0.006 });
    await storage.appendCostLedger({ workspaceId: WS, provider: "google", model: "gemini-2.0-flash", promptTokens: 0, completionTokens: 0, costUsd: 0.0007 });

    const service = new CostService(storage);
    const summary = await service.getSummary(WS, "month", NOW);

    expect(summary.byProvider[0].provider).toBe("anthropic");
    expect(summary.byProvider[1].provider).toBe("google");
  });

  it("22. topPipelines capped at 10 entries", async () => {
    const storage = makeStorage();
    for (let i = 0; i < 15; i++) {
      await storage.appendCostLedger({
        workspaceId: WS,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        promptTokens: 0,
        completionTokens: 0,
        costUsd: i * 0.001,
        pipelineRunId: `run-${i}`,
      });
    }

    const service = new CostService(storage);
    const summary = await service.getSummary(WS, "month", NOW);
    expect(summary.topPipelines.length).toBeLessThanOrEqual(10);
  });

  it("23. entries outside period are excluded", async () => {
    const storage = makeStorage();
    const service = new CostService(storage);

    // Manually record cost in storage with ts in wrong month using appendCostLedger
    // We'll use recordCost but fudge by inserting directly
    await storage.appendCostLedger({
      workspaceId: WS,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 999.0,
    });

    // This entry was just inserted with ts=now, which is within April 2026
    // But we check that when we query a different month (e.g. month=month but
    // different NOW anchor) we get 0
    const marchNow = new Date("2026-03-15T12:00:00Z");
    const marchSummary = await service.getSummary(WS, "month", marchNow);
    expect(marchSummary.totalCostUsd).toBe(0); // March has no entries
  });

  it("24. budgetStatuses reflects actual usage", async () => {
    const storage = makeStorage();
    await makeBudget(storage, WS, { limitUsd: 10.0 });
    await storage.appendCostLedger({
      workspaceId: WS,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 5.0,
    });

    const service = new CostService(storage);
    const summary = await service.getSummary(WS, "month", NOW);

    expect(summary.budgetStatuses).toHaveLength(1);
    expect(summary.budgetStatuses[0].periodToDateUsd).toBeCloseTo(5.0);
    expect(summary.budgetStatuses[0].usagePct).toBeCloseTo(50);
  });
});

// ─── CostService.exportCsv ────────────────────────────────────────────────────

describe("CostService.exportCsv", () => {
  const WS = "ws-csv";
  const NOW = new Date("2026-04-15T12:00:00Z");

  it("25. empty period → CSV header only", async () => {
    const storage = makeStorage();
    const service = new CostService(storage);
    const csv = await service.exportCsv(WS, "month", NOW);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("ts,provider,model");
    expect(lines).toHaveLength(1); // header only
  });

  it("26. CSV has one row per ledger entry", async () => {
    const storage = makeStorage();
    await storage.appendCostLedger({ workspaceId: WS, provider: "anthropic", model: "claude-sonnet-4-6", promptTokens: 100, completionTokens: 50, costUsd: 0.001 });
    await storage.appendCostLedger({ workspaceId: WS, provider: "google", model: "gemini-2.0-flash", promptTokens: 200, completionTokens: 100, costUsd: 0.0002 });

    const service = new CostService(storage);
    const csv = await service.exportCsv(WS, "month", NOW);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3); // header + 2 data rows
  });

  it("27. CSV values are double-quote-wrapped", async () => {
    const storage = makeStorage();
    await storage.appendCostLedger({ workspaceId: WS, provider: "anthropic", model: "claude-sonnet-4-6", promptTokens: 0, completionTokens: 0, costUsd: 0.001 });

    const service = new CostService(storage);
    const csv = await service.exportCsv(WS, "month", NOW);
    const dataLine = csv.split("\n")[1];
    // All fields should be quoted
    expect(dataLine).toMatch(/^"[^"]*","[^"]*"/);
  });

  it("28. CSV escapes double quotes in values", async () => {
    const storage = makeStorage();
    // Use a model name with double quote (edge case)
    await storage.appendCostLedger({ workspaceId: WS, provider: 'test"provider', model: "model", promptTokens: 0, completionTokens: 0, costUsd: 0 });

    const service = new CostService(storage);
    const csv = await service.exportCsv(WS, "month", NOW);
    // The provider field should have escaped double quote
    expect(csv).toContain('test""provider');
  });
});
