/**
 * Integration tests for Phase C: Governance approval gates + run export.
 *
 * Uses MemStorage + MockProvider (no DB, no real LLM calls).
 * Verifies:
 *  - Approval gate lifecycle: run pauses at awaiting_approval, approve unblocks it
 *  - Rejection terminates the run with status "rejected"
 *  - Run export produces markdown and ZIP with correct content-type
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createTestApp } from "../helpers/test-app.js";
import type { PipelineRun, StageExecution } from "../../shared/schema.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function waitForStatus(
  app: Express,
  runId: string,
  predicate: (status: string) => boolean,
  maxWaitMs = 15_000,
): Promise<PipelineRun & { stages: StageExecution[] }> {
  const startAt = Date.now();
  while (Date.now() - startAt < maxWaitMs) {
    const res = await request(app).get(`/api/runs/${runId}`);
    if (res.status === 200) {
      const run = res.body as PipelineRun & { stages: StageExecution[] };
      if (predicate(run.status)) return run;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  const res = await request(app).get(`/api/runs/${runId}`);
  return res.body as PipelineRun & { stages: StageExecution[] };
}

const terminal = (s: string) =>
  ["completed", "failed", "cancelled", "rejected"].includes(s);
const pendingApproval = (s: string) => s === "awaiting_approval" || s === "paused";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Governance — approval gates + run export", () => {
  let app: Express;
  let closeApp: () => Promise<void>;

  // Pipeline IDs for different test scenarios
  let singleApprovalPipelineId: string;
  let noApprovalPipelineId: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    closeApp = testApp.close;

    // Pipeline with approvalRequired on stage 0
    const res1 = await request(app)
      .post("/api/pipelines")
      .send({
        name: "Approval Gate Pipeline",
        stages: [
          { teamId: "planning", modelSlug: "mock", enabled: true, approvalRequired: true },
        ],
      });
    expect(res1.status).toBe(201);
    singleApprovalPipelineId = (res1.body as { id: string }).id;

    // Regular pipeline without approval gates (for export test)
    const res2 = await request(app)
      .post("/api/pipelines")
      .send({
        name: "No Approval Pipeline",
        stages: [
          { teamId: "planning", modelSlug: "mock", enabled: true },
        ],
      });
    expect(res2.status).toBe(201);
    noApprovalPipelineId = (res2.body as { id: string }).id;
  }, 30_000);

  afterAll(async () => {
    await closeApp();
  });

  // ─── Schema: approvalRequired persists ─────────────────────────────────────

  describe("Pipeline schema — approvalRequired field", () => {
    it("persists approvalRequired=true on a stage", async () => {
      const res = await request(app).get(`/api/pipelines/${singleApprovalPipelineId}`);
      expect(res.status).toBe(200);
      const stage = (res.body as { stages: Array<{ approvalRequired?: boolean }> }).stages[0];
      expect(stage.approvalRequired).toBe(true);
    });

    it("round-trips approvalRequired=false (defaults to false when omitted)", async () => {
      const res = await request(app).get(`/api/pipelines/${noApprovalPipelineId}`);
      expect(res.status).toBe(200);
      const stage = (res.body as { stages: Array<{ approvalRequired?: boolean }> }).stages[0];
      // Field may be false or absent — either is acceptable
      expect(stage.approvalRequired ?? false).toBe(false);
    });
  });

  // ─── Approval gate lifecycle ───────────────────────────────────────────────

  describe("POST /api/runs/:id/stages/:stageIndex/approve", () => {
    it("run pauses at awaiting_approval then completes after approve", async () => {
      const startRes = await request(app)
        .post("/api/runs")
        .send({ pipelineId: singleApprovalPipelineId, input: "Build an API" });
      expect(startRes.status).toBe(201);
      const runId = (startRes.body as { id: string }).id;

      // Wait until the pipeline pauses for approval
      const pausedRun = await waitForStatus(app, runId, pendingApproval, 15_000);
      expect(["awaiting_approval", "paused"]).toContain(pausedRun.status);

      // Approve stage 0
      const approveRes = await request(app)
        .post(`/api/runs/${runId}/stages/0/approve`)
        .send({ approvedBy: "test-reviewer" });
      expect(approveRes.status).toBe(200);
      expect(approveRes.body).toMatchObject({ message: expect.stringContaining("approved") });

      // Run should now complete
      const completedRun = await waitForStatus(app, runId, terminal, 15_000);
      expect(completedRun.status).toBe("completed");
    }, 30_000);

    it("returns 400 for a run with no pending approval at that stage", async () => {
      // Start and complete a normal run (no approval gate)
      const startRes = await request(app)
        .post("/api/runs")
        .send({ pipelineId: noApprovalPipelineId, input: "Simple task" });
      expect(startRes.status).toBe(201);
      const runId = (startRes.body as { id: string }).id;

      // Wait until complete, then try to approve — no approval is pending
      await waitForStatus(app, runId, terminal, 15_000);

      const approveRes = await request(app)
        .post(`/api/runs/${runId}/stages/0/approve`)
        .send({});
      expect(approveRes.status).toBe(400);
    }, 30_000);

    it("returns 400 for invalid (negative) stageIndex", async () => {
      const res = await request(app)
        .post("/api/runs/some-run-id/stages/-1/approve")
        .send({});
      expect(res.status).toBe(400);
    });
  });

  // ─── Rejection gate ────────────────────────────────────────────────────────

  describe("POST /api/runs/:id/stages/:stageIndex/reject", () => {
    it("run terminates with status=rejected after rejection", async () => {
      const startRes = await request(app)
        .post("/api/runs")
        .send({ pipelineId: singleApprovalPipelineId, input: "Design a database schema" });
      expect(startRes.status).toBe(201);
      const runId = (startRes.body as { id: string }).id;

      // Wait for approval pause
      const pausedRun = await waitForStatus(app, runId, pendingApproval, 15_000);
      expect(["awaiting_approval", "paused"]).toContain(pausedRun.status);

      // Reject stage 0
      const rejectRes = await request(app)
        .post(`/api/runs/${runId}/stages/0/reject`)
        .send({ reason: "Output quality was insufficient" });
      expect(rejectRes.status).toBe(200);
      expect(rejectRes.body).toMatchObject({ message: expect.stringContaining("rejected") });

      // Run should be in terminal rejected state
      const finalRun = await waitForStatus(app, runId, terminal, 15_000);
      expect(finalRun.status).toBe("rejected");
    }, 30_000);

    it("returns 400 for invalid (negative) stageIndex", async () => {
      const res = await request(app)
        .post("/api/runs/some-run-id/stages/-1/reject")
        .send({});
      expect(res.status).toBe(400);
    });
  });

  // ─── Run export ───────────────────────────────────────────────────────────

  describe("GET /api/runs/:id/export", () => {
    let completedRunId: string;

    beforeAll(async () => {
      // Create and wait for a completed run to export
      const startRes = await request(app)
        .post("/api/runs")
        .send({ pipelineId: noApprovalPipelineId, input: "Generate a project plan" });
      expect(startRes.status).toBe(201);
      completedRunId = (startRes.body as { id: string }).id;
      await waitForStatus(app, completedRunId, terminal, 15_000);
    }, 30_000);

    it("exports markdown with correct content-type", async () => {
      const res = await request(app)
        .get(`/api/runs/${completedRunId}/export?format=markdown`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/markdown/);
      expect(res.headers["content-disposition"]).toMatch(/\.md/);
      // Markdown should contain the run input somewhere
      expect(typeof res.text).toBe("string");
      expect(res.text.length).toBeGreaterThan(0);
    });

    it("exports ZIP with correct content-type", async () => {
      const res = await request(app)
        .get(`/api/runs/${completedRunId}/export?format=zip`)
        .buffer(true)
        .parse((_res, callback) => {
          const chunks: Buffer[] = [];
          _res.on("data", (c: Buffer) => chunks.push(c));
          _res.on("end", () => callback(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/zip/);
      expect(res.headers["content-disposition"]).toMatch(/\.zip/);
      // ZIP magic bytes: PK (0x50 0x4B)
      const buf = res.body as Buffer;
      expect(buf[0]).toBe(0x50);
      expect(buf[1]).toBe(0x4b);
    });

    it("returns 400 for invalid format", async () => {
      const res = await request(app)
        .get(`/api/runs/${completedRunId}/export?format=pdf`);
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown run id", async () => {
      const res = await request(app)
        .get("/api/runs/nonexistent-run/export?format=markdown");
      expect(res.status).toBe(404);
    });

    it("defaults format handling — missing format returns 400", async () => {
      const res = await request(app)
        .get(`/api/runs/${completedRunId}/export`);
      // No format param: enum parse fails → 400
      expect(res.status).toBe(400);
    });
  });
});
