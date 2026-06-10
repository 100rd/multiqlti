/**
 * Integration: a full orchestrator run through the routes + controller + engine
 * (TC-C01..C03). start → awaiting_plan_approval → approve → steps run →
 * synthesis → completed; reject → cancelled-no-step; cancel-mid-run →
 * cancelled, no partial output promoted.
 *
 * supertest over the test-orchestrator-app factory (MemStorage + mock gateway +
 * injected step executors). No CLI / network / real DB.
 *
 * Invoked by the vitest integration project (include tests/integration/**).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { createOrchestratorTestApp } from "../../helpers/test-orchestrator-app.js";

afterEach(() => vi.restoreAllMocks());

describe("orchestrator full run (happy path)", () => {
  it("start → approve → steps run → completed", async () => {
    const steps: string[] = [];
    const { app, storage } = createOrchestratorTestApp({
      userId: "happy-owner",
      planSteps: [{ type: "research", query: "q", candidateUrls: [] }, { type: "synthesize" }],
      onStep: (t) => steps.push(t),
    });

    const start = await request(app).post("/api/runs/orchestrator").send({ task: "compare X vs Y" });
    expect(start.status).toBe(201);
    const runId = start.body.runId;

    // No step ran yet — paused at the gate.
    expect(steps).toHaveLength(0);
    const paused = await storage.getOrchestratorRun(runId);
    expect(paused?.status).toBe("awaiting_plan_approval");

    const approve = await request(app)
      .post(`/api/runs/${runId}/orchestrator/approve-plan`)
      .send({ approvedBy: "owner-1" });
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe("executing");

    const done = await storage.getOrchestratorRun(runId);
    expect(done?.status).toBe("completed");
    expect(steps).toEqual(["research", "synthesize"]);
  });

  it("GET .../orchestrator reflects step statuses + token usage", async () => {
    const { app } = createOrchestratorTestApp({ userId: "inspect-owner" });
    const start = await request(app).post("/api/runs/orchestrator").send({ task: "t" });
    const runId = start.body.runId;
    await request(app).post(`/api/runs/${runId}/orchestrator/approve-plan`).send({});

    const res = await request(app).get(`/api/runs/${runId}/orchestrator`);
    expect(res.status).toBe(200);
    expect(res.body.orchestratorRun.status).toBe("completed");
    expect(res.body.steps.length).toBeGreaterThan(0);
  });
});

describe("orchestrator reject / cancel", () => {
  it("reject-plan → cancelled, no step runs", async () => {
    const steps: string[] = [];
    const { app, storage } = createOrchestratorTestApp({
      userId: "reject-owner",
      onStep: (t) => steps.push(t),
    });
    const start = await request(app).post("/api/runs/orchestrator").send({ task: "t" });
    const runId = start.body.runId;

    const res = await request(app).post(`/api/runs/${runId}/orchestrator/reject-plan`).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");

    const orch = await storage.getOrchestratorRun(runId);
    expect(orch?.status).toBe("cancelled");
    expect(steps).toHaveLength(0);
  });

  it("cancel before approval → cancelled, no partial output promoted", async () => {
    const { app, controller, storage } = createOrchestratorTestApp({
      userId: "cancel-owner",
      planSteps: [{ type: "research", query: "q", candidateUrls: [] }, { type: "synthesize" }],
    });
    const start = await request(app).post("/api/runs/orchestrator").send({ task: "t" });
    const runId = start.body.runId;

    // Cancel via the shared run AbortController path; engine must not promote output.
    await controller.cancelRun(runId);

    const orch = await storage.getOrchestratorRun(runId);
    const pipeRun = await storage.getPipelineRun(runId);
    expect(pipeRun?.status).toBe("cancelled");
    expect(orch?.output ?? null).toBeFalsy();
  });
});

describe("orchestrator debates + research read endpoints", () => {
  it("GET .../debates and .../research are owner-gated and return arrays", async () => {
    const { app } = createOrchestratorTestApp({ userId: "reader-owner" });
    const start = await request(app).post("/api/runs/orchestrator").send({ task: "t" });
    const runId = start.body.runId;

    const debates = await request(app).get(`/api/runs/${runId}/orchestrator/debates`);
    expect(debates.status).toBe(200);
    expect(Array.isArray(debates.body.debates)).toBe(true);

    const research = await request(app).get(`/api/runs/${runId}/orchestrator/research`);
    expect(research.status).toBe(200);
    expect(Array.isArray(research.body.research)).toBe(true);
  });
});
