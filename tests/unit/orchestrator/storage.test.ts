/**
 * Unit tests for MemStorage orchestrator methods (T2).
 *
 * Covers round-trip CRUD for the 4 orchestrator tables, update semantics,
 * step ordering by stepIndex, and run-scoped isolation. Cascade-delete +
 * UNIQUE(runId,stepIndex) at the DB level are exercised in the PG integration
 * suite; here we pin the in-memory contract the engine depends on.
 *
 * Invoked by vitest unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../../../server/storage.js";

describe("MemStorage — orchestrator tables", () => {
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
  });

  it("createOrchestratorRun() generates id + timestamps and round-trips by runId", async () => {
    const run = await storage.createOrchestratorRun({
      runId: "run-1",
      task: "Compare inference frameworks",
      needs: "latency + cost",
      workspaceId: null,
      status: "planning",
    });
    expect(run.id).toBeTruthy();
    expect(run.task).toBe("Compare inference frameworks");
    expect(run.totalTokensUsed).toBe(0);

    const fetched = await storage.getOrchestratorRun("run-1");
    expect(fetched?.id).toBe(run.id);
  });

  it("updateOrchestratorRun() merges fields immutably", async () => {
    await storage.createOrchestratorRun({ runId: "run-1", task: "t", status: "planning" });
    await storage.updateOrchestratorRun("run-1", {
      status: "awaiting_plan_approval",
      totalTokensUsed: 123,
    });
    const fetched = await storage.getOrchestratorRun("run-1");
    expect(fetched?.status).toBe("awaiting_plan_approval");
    expect(fetched?.totalTokensUsed).toBe(123);
  });

  it("getOrchestratorSteps() returns steps ordered by stepIndex, scoped per run", async () => {
    await storage.createOrchestratorStep({
      runId: "run-1",
      stepIndex: 1,
      type: "debate",
      args: { type: "debate", question: "x" },
      status: "pending",
    });
    await storage.createOrchestratorStep({
      runId: "run-1",
      stepIndex: 0,
      type: "research",
      args: { type: "research", query: "q", candidateUrls: [] },
      status: "pending",
    });
    await storage.createOrchestratorStep({
      runId: "run-2",
      stepIndex: 0,
      type: "ground",
      args: { type: "ground", query: "g" },
      status: "pending",
    });

    const steps = await storage.getOrchestratorSteps("run-1");
    expect(steps.map((s) => s.stepIndex)).toEqual([0, 1]);
    expect(steps.map((s) => s.type)).toEqual(["research", "debate"]);
  });

  it("updateOrchestratorStep() updates by step id", async () => {
    const step = await storage.createOrchestratorStep({
      runId: "run-1",
      stepIndex: 0,
      type: "research",
      args: { type: "research", query: "q", candidateUrls: [] },
      status: "pending",
    });
    await storage.updateOrchestratorStep(step.id, {
      status: "completed",
      tokensUsed: 50,
      output: { ok: true },
    });
    const [updated] = await storage.getOrchestratorSteps("run-1");
    expect(updated.status).toBe("completed");
    expect(updated.tokensUsed).toBe(50);
  });

  it("createOrchestratorDebate() + getOrchestratorDebates() round-trip", async () => {
    await storage.createOrchestratorDebate({
      runId: "run-1",
      stepId: "step-1",
      question: "Which framework?",
      rounds: [],
      judgeVerdict: "Use vLLM",
      providerDiversityScore: 1,
      recommendation: "vLLM",
      confidence: 0.8,
      dissent: ["TGI is simpler"],
    });
    const debates = await storage.getOrchestratorDebates("run-1");
    expect(debates).toHaveLength(1);
    expect(debates[0].recommendation).toBe("vLLM");
    expect(await storage.getOrchestratorDebates("run-other")).toEqual([]);
  });

  it("createOrchestratorResearch() + getOrchestratorResearch() round-trip", async () => {
    await storage.createOrchestratorResearch({
      runId: "run-1",
      stepId: "step-1",
      query: "framework latency",
      findings: [{ claim: "vLLM is fast", sourceUrl: "https://opentofu.org/x", snippet: "..." }],
      sourcesFetched: 1,
      sourcesSkipped: 2,
    });
    const research = await storage.getOrchestratorResearch("run-1");
    expect(research).toHaveLength(1);
    expect(research[0].sourcesSkipped).toBe(2);
    expect(research[0].findings[0].sourceUrl).toBe("https://opentofu.org/x");
  });
});
