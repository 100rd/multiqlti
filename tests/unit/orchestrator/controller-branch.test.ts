/**
 * Unit tests for the PipelineController orchestrator branch (T10).
 *
 * Covers: startOrchestratorRun creates the pipelineRuns + orchestrator_runs rows
 * and pauses at awaiting_plan_approval (no steps run); L1 kill-switch refusal
 * when config disabled; approvePlan resumes execution; rejectPlan → cancelled
 * (no steps). Deterministic doubles.
 *
 * Invoked by vitest unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemStorage } from "../../../server/storage.js";
import { PipelineController } from "../../../server/controller/pipeline-controller.js";
import { OrchestratorAgent } from "../../../server/orchestrator/orchestrator-agent.js";
import type {
  StepExecutors,
  OrchestratorModels,
} from "../../../server/orchestrator/orchestrator-agent.js";
import { configLoader } from "../../../server/config/loader.js";

const MODELS: OrchestratorModels = {
  planModelSlug: "claude-opus",
  synthesizeModelSlug: "claude-opus",
  proposerModelSlug: "claude-opus",
  criticModelSlug: "gemini-flash",
  judgeModelSlug: "claude-opus",
};

const wsManager = { broadcastToRun: vi.fn() } as never;
const teamRegistry = {} as never;

function planGateway(steps: Array<Record<string, unknown>>) {
  return {
    complete: vi.fn(async () => ({
      content: JSON.stringify({ steps }),
      tokensUsed: 1,
      modelSlug: "claude-opus",
      finishReason: "stop",
    })),
    resolveProvider: vi.fn(async () => "anthropic"),
  } as never;
}

function makeExecutors(onStep: (t: string) => void): StepExecutors {
  const mk = (t: string) =>
    vi.fn(async () => {
      onStep(t);
      return { output: {}, tokensUsed: 0 };
    });
  return {
    research: mk("research"),
    analyzeCode: mk("analyze-code"),
    debate: mk("debate"),
    ground: mk("ground"),
    synthesize: mk("synthesize"),
  } as unknown as StepExecutors;
}

function enableOrchestrator(enabled: boolean) {
  const base = configLoader.get();
  vi.spyOn(configLoader, "get").mockReturnValue({
    ...base,
    pipeline: {
      ...base.pipeline,
      orchestrator: { ...base.pipeline.orchestrator, enabled },
    },
  } as never);
}

function buildController(storage: MemStorage, agent: OrchestratorAgent) {
  return new PipelineController(
    storage,
    teamRegistry,
    wsManager,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    agent,
  );
}

describe("PipelineController orchestrator branch", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("L1: refuses to start when the kill-switch is disabled", async () => {
    enableOrchestrator(false);
    const storage = new MemStorage();
    const ran: string[] = [];
    const agent = new OrchestratorAgent({
      storage,
      wsManager,
      gateway: planGateway([{ type: "ground", query: "g" }]),
      stepExecutors: makeExecutors((t) => ran.push(t)),
      models: MODELS,
    });
    const controller = buildController(storage, agent);

    await expect(
      controller.startOrchestratorRun({ task: "t" }, "user-1", undefined),
    ).rejects.toThrow(/disabled|orchestrator/i);
  });

  it("starts → awaiting_plan_approval, persists rows, runs NO step", async () => {
    enableOrchestrator(true);
    const storage = new MemStorage();
    const ran: string[] = [];
    const agent = new OrchestratorAgent({
      storage,
      wsManager,
      gateway: planGateway([{ type: "ground", query: "g" }, { type: "synthesize" }]),
      stepExecutors: makeExecutors((t) => ran.push(t)),
      models: MODELS,
    });
    const controller = buildController(storage, agent);

    const result = await controller.startOrchestratorRun({ task: "t" }, "user-1", undefined);

    expect(result.run.id).toBeTruthy();
    const orch = await storage.getOrchestratorRun(result.run.id);
    expect(orch?.status).toBe("awaiting_plan_approval");
    expect(ran).toHaveLength(0);
  });

  it("approvePlan resumes execution and completes", async () => {
    enableOrchestrator(true);
    const storage = new MemStorage();
    const ran: string[] = [];
    const agent = new OrchestratorAgent({
      storage,
      wsManager,
      gateway: planGateway([{ type: "ground", query: "g" }, { type: "synthesize" }]),
      stepExecutors: makeExecutors((t) => ran.push(t)),
      models: MODELS,
    });
    const controller = buildController(storage, agent);
    const { run } = await controller.startOrchestratorRun({ task: "t" }, "user-1", undefined);

    await controller.approvePlan(run.id, "user-1");
    const orch = await storage.getOrchestratorRun(run.id);
    expect(orch?.status).toBe("completed");
    expect(ran).toContain("ground");
  });

  it("rejectPlan → cancelled, runs no step", async () => {
    enableOrchestrator(true);
    const storage = new MemStorage();
    const ran: string[] = [];
    const agent = new OrchestratorAgent({
      storage,
      wsManager,
      gateway: planGateway([{ type: "ground", query: "g" }]),
      stepExecutors: makeExecutors((t) => ran.push(t)),
      models: MODELS,
    });
    const controller = buildController(storage, agent);
    const { run } = await controller.startOrchestratorRun({ task: "t" }, "user-1", undefined);

    await controller.rejectPlan(run.id);
    const orch = await storage.getOrchestratorRun(run.id);
    expect(orch?.status).toBe("cancelled");
    expect(ran).toHaveLength(0);
  });
});
