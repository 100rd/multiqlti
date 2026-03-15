/**
 * Integration tests for the Strategy API.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createFullTestApp } from "../helpers/test-app-full.js";
import { EXECUTION_STRATEGY_PRESETS } from "../../shared/constants.js";

describe("Strategy API", () => {
  let app: Express;
  let closeApp: () => Promise<void>;
  let pipelineId: string;

  beforeAll(async () => {
    const testApp = await createFullTestApp();
    app = testApp.app;
    closeApp = testApp.close;

    // Create a pipeline with stages for strategy tests
    const res = await request(app)
      .post("/api/pipelines")
      .send({
        name: "Strategy Test Pipeline",
        description: "Used for strategy API tests",
        stages: [
          { teamId: "planning", modelSlug: "mock", enabled: true },
          { teamId: "architecture", modelSlug: "mock", enabled: true },
        ],
      });
    expect(res.status).toBe(201);
    pipelineId = res.body.id as string;
  });

  afterAll(async () => {
    await closeApp();
  });

  // GET /api/strategies/presets ─────────────────────────────────────────────────

  it("GET /api/strategies/presets → 5 presets with id, label, stageStrategies", async () => {
    const res = await request(app).get("/api/strategies/presets");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(EXECUTION_STRATEGY_PRESETS.length);

    for (const preset of res.body as Array<{ id: string; label: string; stageStrategies: unknown }>) {
      expect(preset.id).toBeTruthy();
      expect(preset.label).toBeTruthy();
      expect(typeof preset.stageStrategies).toBe("object");
    }
  });

  it("presets include 'single', 'quality_max', 'balanced_multi', 'cost_optimized_multi'", async () => {
    const res = await request(app).get("/api/strategies/presets");
    const ids = (res.body as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain("single");
    expect(ids).toContain("quality_max");
    expect(ids).toContain("balanced_multi");
  });

  // PATCH /api/pipelines/:id/stages/0/strategy ─────────────────────────────────

  it("PATCH /api/pipelines/:id/stages/0/strategy with valid MoA body → 200", async () => {
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}/stages/0/strategy`)
      .send({
        type: "moa",
        proposers: [
          { modelSlug: "mock", role: "primary", temperature: 0.7 },
          { modelSlug: "mock", role: "secondary", temperature: 0.5 },
        ],
        aggregator: { modelSlug: "mock" },
      });

    expect(res.status).toBe(200);
    const stages = res.body.stages as Array<{ executionStrategy?: { type: string } }>;
    expect(stages[0].executionStrategy?.type).toBe("moa");
  });

  it("PATCH /api/pipelines/:id/stages/0/strategy with valid debate body → 200", async () => {
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}/stages/0/strategy`)
      .send({
        type: "debate",
        participants: [
          { modelSlug: "mock", role: "proposer" },
          { modelSlug: "mock", role: "critic" },
        ],
        judge: { modelSlug: "mock" },
        rounds: 2,
      });

    expect(res.status).toBe(200);
    const stages = res.body.stages as Array<{ executionStrategy?: { type: string } }>;
    expect(stages[0].executionStrategy?.type).toBe("debate");
  });

  it("PATCH /api/pipelines/:id/stages/0/strategy with 'single' → removes strategy", async () => {
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}/stages/0/strategy`)
      .send({ type: "single" });

    expect(res.status).toBe(200);
    const stages = res.body.stages as Array<{ executionStrategy?: unknown }>;
    expect(stages[0].executionStrategy).toBeUndefined();
  });

  it("PATCH /api/pipelines/:id/stages/0/strategy with invalid body → 400", async () => {
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}/stages/0/strategy`)
      .send({ type: "unknown_strategy_type" });

    expect(res.status).toBe(400);
  });

  it("PATCH /api/pipelines/:id/stages/0/strategy with out-of-bounds index → 400", async () => {
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}/stages/99/strategy`)
      .send({ type: "single" });

    expect(res.status).toBe(400);
  });

  it("PATCH /api/pipelines/:id/stages/0/strategy for unknown pipeline → 404", async () => {
    const res = await request(app)
      .patch("/api/pipelines/nonexistent-id/stages/0/strategy")
      .send({ type: "single" });

    expect(res.status).toBe(404);
  });

  // PATCH /api/pipelines/:id/execution-preset ──────────────────────────────────

  it("PATCH /api/pipelines/:id/execution-preset with valid presetId → 200", async () => {
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}/execution-preset`)
      .send({ presetId: "single" });

    expect(res.status).toBe(200);
  });

  it("PATCH /api/pipelines/:id/execution-preset with unknown presetId → 404", async () => {
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}/execution-preset`)
      .send({ presetId: "nonexistent-preset" });

    expect(res.status).toBe(404);
  });
});
