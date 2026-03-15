import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../../server/storage.js";

describe("MemStorage", () => {
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
  });

  // ─── Models ────────────────────────────────────────────────────────────────

  describe("Models", () => {
    it("createModel() returns a model with generated id and timestamps", async () => {
      const model = await storage.createModel({
        name: "Test Model",
        slug: "test-model",
        provider: "mock",
        contextLimit: 4096,
        isActive: true,
        capabilities: [],
      });

      expect(model.id).toBeTruthy();
      expect(model.name).toBe("Test Model");
      expect(model.slug).toBe("test-model");
      expect(model.provider).toBe("mock");
      expect(model.isActive).toBe(true);
    });

    it("getModels() returns all models", async () => {
      await storage.createModel({ name: "A", slug: "a", provider: "mock", contextLimit: 4096, isActive: true, capabilities: [] });
      await storage.createModel({ name: "B", slug: "b", provider: "mock", contextLimit: 4096, isActive: true, capabilities: [] });

      const models = await storage.getModels();
      expect(models).toHaveLength(2);
    });

    it("getActiveModels() returns only active models", async () => {
      await storage.createModel({ name: "Active", slug: "active", provider: "mock", contextLimit: 4096, isActive: true, capabilities: [] });
      await storage.createModel({ name: "Inactive", slug: "inactive", provider: "mock", contextLimit: 4096, isActive: false, capabilities: [] });

      const active = await storage.getActiveModels();
      expect(active).toHaveLength(1);
      expect(active[0].slug).toBe("active");
    });

    it("getActiveModels() returns empty array when no active models", async () => {
      await storage.createModel({ name: "Off", slug: "off", provider: "mock", contextLimit: 4096, isActive: false, capabilities: [] });
      const active = await storage.getActiveModels();
      expect(active).toHaveLength(0);
    });

    it("getModelBySlug() returns the correct model", async () => {
      await storage.createModel({ name: "Target", slug: "target-slug", provider: "mock", contextLimit: 4096, isActive: true, capabilities: [] });

      const found = await storage.getModelBySlug("target-slug");
      expect(found).toBeDefined();
      expect(found?.name).toBe("Target");
    });

    it("getModelBySlug() returns undefined for unknown slug", async () => {
      const found = await storage.getModelBySlug("nonexistent");
      expect(found).toBeUndefined();
    });
  });

  // ─── Pipelines ─────────────────────────────────────────────────────────────

  describe("Pipelines", () => {
    it("createPipeline() returns a pipeline with generated id", async () => {
      const pipeline = await storage.createPipeline({
        name: "My Pipeline",
        description: "A test pipeline",
        stages: [],
      });

      expect(pipeline.id).toBeTruthy();
      expect(pipeline.name).toBe("My Pipeline");
      expect(pipeline.description).toBe("A test pipeline");
      expect(pipeline.stages).toEqual([]);
      expect(pipeline.createdAt).toBeInstanceOf(Date);
    });

    it("getPipelines() returns all pipelines", async () => {
      await storage.createPipeline({ name: "P1", stages: [] });
      await storage.createPipeline({ name: "P2", stages: [] });

      const all = await storage.getPipelines();
      expect(all).toHaveLength(2);
    });

    it("getPipeline() returns the correct pipeline by id", async () => {
      const created = await storage.createPipeline({ name: "Specific", stages: [] });

      const found = await storage.getPipeline(created.id);
      expect(found).toBeDefined();
      expect(found?.name).toBe("Specific");
    });

    it("getPipeline() returns undefined for unknown id", async () => {
      const found = await storage.getPipeline("nonexistent-id");
      expect(found).toBeUndefined();
    });

    it("updatePipeline() updates fields and refreshes updatedAt", async () => {
      const pipeline = await storage.createPipeline({ name: "Original", stages: [] });
      const originalUpdatedAt = pipeline.updatedAt;

      // Small delay to ensure updatedAt changes
      await new Promise((r) => setTimeout(r, 5));

      const updated = await storage.updatePipeline(pipeline.id, { name: "Updated" });
      expect(updated.name).toBe("Updated");

      if (originalUpdatedAt && updated.updatedAt) {
        expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(originalUpdatedAt.getTime());
      }
    });

    it("updatePipeline() throws for unknown id", async () => {
      await expect(storage.updatePipeline("unknown", { name: "X" })).rejects.toThrow();
    });

    it("deletePipeline() removes the pipeline", async () => {
      const pipeline = await storage.createPipeline({ name: "ToDelete", stages: [] });
      await storage.deletePipeline(pipeline.id);

      const found = await storage.getPipeline(pipeline.id);
      expect(found).toBeUndefined();
    });

    it("getTemplates() returns only template pipelines", async () => {
      await storage.createPipeline({ name: "Regular", stages: [], isTemplate: false });
      await storage.createPipeline({ name: "Template", stages: [], isTemplate: true });

      const templates = await storage.getTemplates();
      expect(templates).toHaveLength(1);
      expect(templates[0].name).toBe("Template");
    });
  });

  // ─── Pipeline Runs ─────────────────────────────────────────────────────────

  describe("Pipeline Runs", () => {
    it("createPipelineRun() returns a run with generated id", async () => {
      const pipeline = await storage.createPipeline({ name: "P", stages: [] });
      const run = await storage.createPipelineRun({
        pipelineId: pipeline.id,
        status: "running",
        input: "test input",
        currentStageIndex: 0,
        startedAt: new Date(),
      });

      expect(run.id).toBeTruthy();
      expect(run.pipelineId).toBe(pipeline.id);
      expect(run.status).toBe("running");
      expect(run.input).toBe("test input");
    });

    it("getPipelineRun() returns the run by id", async () => {
      const pipeline = await storage.createPipeline({ name: "P", stages: [] });
      const run = await storage.createPipelineRun({
        pipelineId: pipeline.id,
        status: "pending",
        input: "input",
        currentStageIndex: 0,
      });

      const found = await storage.getPipelineRun(run.id);
      expect(found?.id).toBe(run.id);
    });

    it("getPipelineRun() returns undefined for unknown id", async () => {
      const found = await storage.getPipelineRun("nope");
      expect(found).toBeUndefined();
    });

    it("getPipelineRuns() filters by pipelineId", async () => {
      const p1 = await storage.createPipeline({ name: "P1", stages: [] });
      const p2 = await storage.createPipeline({ name: "P2", stages: [] });

      await storage.createPipelineRun({ pipelineId: p1.id, status: "pending", input: "a", currentStageIndex: 0 });
      await storage.createPipelineRun({ pipelineId: p1.id, status: "pending", input: "b", currentStageIndex: 0 });
      await storage.createPipelineRun({ pipelineId: p2.id, status: "pending", input: "c", currentStageIndex: 0 });

      const p1Runs = await storage.getPipelineRuns(p1.id);
      expect(p1Runs).toHaveLength(2);

      const p2Runs = await storage.getPipelineRuns(p2.id);
      expect(p2Runs).toHaveLength(1);
    });

    it("updatePipelineRun() updates status and other fields", async () => {
      const pipeline = await storage.createPipeline({ name: "P", stages: [] });
      const run = await storage.createPipelineRun({ pipelineId: pipeline.id, status: "pending", input: "i", currentStageIndex: 0 });

      const updated = await storage.updatePipelineRun(run.id, { status: "completed", completedAt: new Date() });
      expect(updated.status).toBe("completed");
      expect(updated.completedAt).toBeInstanceOf(Date);
    });
  });

  // ─── Stage Executions ──────────────────────────────────────────────────────

  describe("Stage Executions", () => {
    it("createStageExecution() returns a stage with generated id", async () => {
      const pipeline = await storage.createPipeline({ name: "P", stages: [] });
      const run = await storage.createPipelineRun({ pipelineId: pipeline.id, status: "running", input: "i", currentStageIndex: 0 });

      const stage = await storage.createStageExecution({
        runId: run.id,
        stageIndex: 0,
        teamId: "planning",
        modelSlug: "mock",
        status: "pending",
        input: {},
      });

      expect(stage.id).toBeTruthy();
      expect(stage.runId).toBe(run.id);
      expect(stage.stageIndex).toBe(0);
      expect(stage.teamId).toBe("planning");
    });

    it("getStageExecutions() returns all executions for a run", async () => {
      const pipeline = await storage.createPipeline({ name: "P", stages: [] });
      const run = await storage.createPipelineRun({ pipelineId: pipeline.id, status: "running", input: "i", currentStageIndex: 0 });

      await storage.createStageExecution({ runId: run.id, stageIndex: 0, teamId: "planning", modelSlug: "mock", status: "pending", input: {} });
      await storage.createStageExecution({ runId: run.id, stageIndex: 1, teamId: "architecture", modelSlug: "mock", status: "pending", input: {} });

      const executions = await storage.getStageExecutions(run.id);
      expect(executions).toHaveLength(2);
    });

    it("updateStageExecution() updates status and output", async () => {
      const pipeline = await storage.createPipeline({ name: "P", stages: [] });
      const run = await storage.createPipelineRun({ pipelineId: pipeline.id, status: "running", input: "i", currentStageIndex: 0 });
      const stage = await storage.createStageExecution({ runId: run.id, stageIndex: 0, teamId: "planning", modelSlug: "mock", status: "pending", input: {} });

      const updated = await storage.updateStageExecution(stage.id, {
        status: "completed",
        output: { summary: "Done" },
      });

      expect(updated.status).toBe("completed");
      expect(updated.output).toEqual({ summary: "Done" });
    });
  });
});
