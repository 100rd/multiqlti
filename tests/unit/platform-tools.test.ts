import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock Storage ───────────────────────────────────────────────────────────

vi.mock("../../server/storage", () => {
  const fns = {
    getPipelines: vi.fn(),
    getPipeline: vi.fn(),
    createPipeline: vi.fn(),
    updatePipeline: vi.fn(),
    deletePipeline: vi.fn(),
    getPipelineRun: vi.fn(),
    createPipelineRun: vi.fn(),
    updatePipelineRun: vi.fn(),
    getWorkspaces: vi.fn(),
    getWorkspace: vi.fn(),
    createWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    getTriggers: vi.fn(),
    getTrigger: vi.fn(),
    createTrigger: vi.fn(),
    updateTrigger: vi.fn(),
    deleteTrigger: vi.fn(),
    getActiveModels: vi.fn(),
    getSkills: vi.fn(),
    upsertMemory: vi.fn(),
    searchMemories: vi.fn(),
  };
  return { storage: fns };
});

// ─── Imports (after mock declaration) ───────────────────────────────────────

import { storage } from "../../server/storage";

import {
  listPipelinesHandler,
  createPipelineHandler,
  updatePipelineHandler,
  deletePipelineHandler,
  runPipelineHandler,
  cancelRunHandler,
} from "../../server/tools/builtin/platform/pipelines";

import {
  listWorkspacesHandler,
  createWorkspaceHandler,
  deleteWorkspaceHandler,
} from "../../server/tools/builtin/platform/workspaces";

import {
  listTriggersHandler,
  createTriggerHandler,
  updateTriggerHandler,
  deleteTriggerHandler,
} from "../../server/tools/builtin/platform/triggers";

import {
  listModelsHandler,
  createMemoryHandler,
  searchMemoriesHandler,
  listSkillsHandler,
  createGuardrailHandler,
} from "../../server/tools/builtin/platform/utilities";

import { platformTools } from "../../server/tools/builtin/platform/index";

// ─── Typed mock accessor ────────────────────────────────────────────────────

const ms = storage as unknown as Record<string, ReturnType<typeof vi.fn>>;

// ─── Helpers ────────────────────────────────────────────────────────────────

function parse(result: string): Record<string, unknown> {
  return JSON.parse(result) as Record<string, unknown>;
}

function parseArray(result: string): Record<string, unknown>[] {
  return JSON.parse(result) as Record<string, unknown>[];
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Platform Tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("platformTools index", () => {
    it("exports all 18 platform tools", () => {
      expect(platformTools).toHaveLength(18);
    });

    it("all tools have unique names", () => {
      const names = platformTools.map((t) => t.definition.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it("all tools have platform tag", () => {
      for (const tool of platformTools) {
        expect(tool.definition.tags).toContain("platform");
      }
    });

    it("all tools have builtin source", () => {
      for (const tool of platformTools) {
        expect(tool.definition.source).toBe("builtin");
      }
    });
  });

  // ─── Pipeline Tools ─────────────────────────────────────────────────────

  describe("list_pipelines", () => {
    it("returns formatted list when pipelines exist", async () => {
      ms["getPipelines"].mockResolvedValue([
        { id: "p1", name: "Build", description: "CI pipeline" },
        { id: "p2", name: "Deploy", description: null },
      ]);
      const result = parseArray(await listPipelinesHandler.execute({}));
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: "p1", name: "Build", description: "CI pipeline" });
    });

    it("returns message when no pipelines exist", async () => {
      ms["getPipelines"].mockResolvedValue([]);
      const result = await listPipelinesHandler.execute({});
      expect(result).toBe("No pipelines found.");
    });
  });

  describe("create_pipeline", () => {
    it("creates pipeline with valid input", async () => {
      ms["createPipeline"].mockResolvedValue({ id: "new-1", name: "Test" });
      const result = parse(
        await createPipelineHandler.execute({
          name: "Test",
          stages: [{ teamId: "development" }],
        }),
      );
      expect(result).toEqual({ id: "new-1", name: "Test", created: true });
      expect(ms["createPipeline"]).toHaveBeenCalledWith({
        name: "Test",
        description: null,
        stages: [{ teamId: "development" }],
      });
    });

    it("rejects empty name", async () => {
      await expect(
        createPipelineHandler.execute({ name: "", stages: [{}] }),
      ).rejects.toThrow();
    });

    it("rejects empty stages array", async () => {
      await expect(
        createPipelineHandler.execute({ name: "X", stages: [] }),
      ).rejects.toThrow();
    });
  });

  describe("update_pipeline", () => {
    it("updates existing pipeline", async () => {
      ms["getPipeline"].mockResolvedValue({ id: "p1", name: "Old" });
      ms["updatePipeline"].mockResolvedValue({ id: "p1", name: "New" });
      const result = parse(
        await updatePipelineHandler.execute({ id: "p1", name: "New" }),
      );
      expect(result).toEqual({ id: "p1", name: "New", updated: true });
    });

    it("returns error for non-existent pipeline", async () => {
      ms["getPipeline"].mockResolvedValue(undefined);
      const result = parse(await updatePipelineHandler.execute({ id: "missing" }));
      expect(result["error"]).toContain("not found");
    });
  });

  describe("delete_pipeline (confirmation protocol)", () => {
    it("returns confirmation prompt on first call without confirmed=true", async () => {
      const result = parse(await deletePipelineHandler.execute({ id: "p1" }));
      expect(result["needsConfirmation"]).toBe(true);
      expect(result["action"]).toBe("Delete pipeline");
      expect(result["details"]).toContain("p1");
      expect(ms["deletePipeline"]).not.toHaveBeenCalled();
    });

    it("executes deletion when confirmed=true and pipeline exists", async () => {
      ms["getPipeline"].mockResolvedValue({ id: "p1", name: "X" });
      ms["deletePipeline"].mockResolvedValue(undefined);
      const result = parse(
        await deletePipelineHandler.execute({ id: "p1", confirmed: true }),
      );
      expect(result).toEqual({ id: "p1", deleted: true });
      expect(ms["deletePipeline"]).toHaveBeenCalledWith("p1");
    });

    it("returns error when confirmed but pipeline not found", async () => {
      ms["getPipeline"].mockResolvedValue(undefined);
      const result = parse(
        await deletePipelineHandler.execute({ id: "gone", confirmed: true }),
      );
      expect(result["error"]).toContain("not found");
    });

    it("does not execute when confirmed is false", async () => {
      const result = parse(
        await deletePipelineHandler.execute({ id: "p1", confirmed: false }),
      );
      expect(result["needsConfirmation"]).toBe(true);
      expect(ms["deletePipeline"]).not.toHaveBeenCalled();
    });
  });

  describe("run_pipeline", () => {
    it("creates a run for existing pipeline", async () => {
      ms["getPipeline"].mockResolvedValue({ id: "p1" });
      ms["createPipelineRun"].mockResolvedValue({ id: "run-1" });
      const result = parse(
        await runPipelineHandler.execute({ pipelineId: "p1", input: "Go" }),
      );
      expect(result["runId"]).toBe("run-1");
      expect(result["status"]).toBe("pending");
    });

    it("returns error for non-existent pipeline", async () => {
      ms["getPipeline"].mockResolvedValue(undefined);
      const result = parse(
        await runPipelineHandler.execute({ pipelineId: "nope" }),
      );
      expect(result["error"]).toContain("not found");
    });
  });

  describe("cancel_run (confirmation protocol)", () => {
    it("returns confirmation on first call", async () => {
      const result = parse(await cancelRunHandler.execute({ runId: "r1" }));
      expect(result["needsConfirmation"]).toBe(true);
      expect(result["action"]).toBe("Cancel pipeline run");
    });

    it("cancels active run when confirmed", async () => {
      ms["getPipelineRun"].mockResolvedValue({ id: "r1", status: "running" });
      ms["updatePipelineRun"].mockResolvedValue({ id: "r1", status: "cancelled" });
      const result = parse(
        await cancelRunHandler.execute({ runId: "r1", confirmed: true }),
      );
      expect(result["cancelled"]).toBe(true);
    });

    it("cancels pending run when confirmed", async () => {
      ms["getPipelineRun"].mockResolvedValue({ id: "r1", status: "pending" });
      ms["updatePipelineRun"].mockResolvedValue({ id: "r1", status: "cancelled" });
      const result = parse(
        await cancelRunHandler.execute({ runId: "r1", confirmed: true }),
      );
      expect(result["cancelled"]).toBe(true);
    });

    it("rejects cancel on non-active run", async () => {
      ms["getPipelineRun"].mockResolvedValue({ id: "r1", status: "completed" });
      const result = parse(
        await cancelRunHandler.execute({ runId: "r1", confirmed: true }),
      );
      expect(result["error"]).toContain("not active");
    });

    it("returns error for non-existent run", async () => {
      ms["getPipelineRun"].mockResolvedValue(undefined);
      const result = parse(
        await cancelRunHandler.execute({ runId: "gone", confirmed: true }),
      );
      expect(result["error"]).toContain("not found");
    });
  });

  // ─── Workspace Tools ────────────────────────────────────────────────────

  describe("list_workspaces", () => {
    it("returns workspaces", async () => {
      ms["getWorkspaces"].mockResolvedValue([
        { id: "w1", name: "My Repo", type: "local", path: "/code", status: "active" },
      ]);
      const result = parseArray(await listWorkspacesHandler.execute({}));
      expect(result).toHaveLength(1);
      expect(result[0]["name"]).toBe("My Repo");
    });

    it("returns message when empty", async () => {
      ms["getWorkspaces"].mockResolvedValue([]);
      expect(await listWorkspacesHandler.execute({})).toBe("No workspaces found.");
    });
  });

  describe("create_workspace", () => {
    it("creates workspace with valid input", async () => {
      ms["createWorkspace"].mockResolvedValue({ id: "w1", name: "Repo" });
      const result = parse(
        await createWorkspaceHandler.execute({
          name: "Repo",
          type: "local",
          path: "/code/repo",
        }),
      );
      expect(result).toEqual({ id: "w1", name: "Repo", created: true });
    });

    it("passes default branch when not specified", async () => {
      ms["createWorkspace"].mockResolvedValue({ id: "w1", name: "R" });
      await createWorkspaceHandler.execute({ name: "R", type: "remote", path: "/x" });
      expect(ms["createWorkspace"]).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "main" }),
      );
    });

    it("rejects invalid type", async () => {
      await expect(
        createWorkspaceHandler.execute({ name: "X", type: "invalid", path: "/x" }),
      ).rejects.toThrow();
    });
  });

  describe("delete_workspace (confirmation protocol)", () => {
    it("returns confirmation on first call", async () => {
      const result = parse(await deleteWorkspaceHandler.execute({ id: "w1" }));
      expect(result["needsConfirmation"]).toBe(true);
    });

    it("deletes when confirmed and exists", async () => {
      ms["getWorkspace"].mockResolvedValue({ id: "w1" });
      ms["deleteWorkspace"].mockResolvedValue(undefined);
      const result = parse(
        await deleteWorkspaceHandler.execute({ id: "w1", confirmed: true }),
      );
      expect(result["deleted"]).toBe(true);
    });

    it("returns error when workspace not found", async () => {
      ms["getWorkspace"].mockResolvedValue(null);
      const result = parse(
        await deleteWorkspaceHandler.execute({ id: "gone", confirmed: true }),
      );
      expect(result["error"]).toContain("not found");
    });
  });

  // ─── Trigger Tools ──────────────────────────────────────────────────────

  describe("list_triggers", () => {
    it("returns triggers for pipeline", async () => {
      ms["getTriggers"].mockResolvedValue([
        { id: "t1", type: "webhook", enabled: true, config: {} },
      ]);
      const result = parseArray(
        await listTriggersHandler.execute({ pipelineId: "p1" }),
      );
      expect(result).toHaveLength(1);
      expect(result[0]["type"]).toBe("webhook");
    });

    it("returns message when no triggers", async () => {
      ms["getTriggers"].mockResolvedValue([]);
      const result = await listTriggersHandler.execute({ pipelineId: "p1" });
      expect(result).toContain("No triggers found");
    });

    it("rejects missing pipelineId", async () => {
      await expect(listTriggersHandler.execute({})).rejects.toThrow();
    });
  });

  describe("create_trigger", () => {
    it("creates trigger for existing pipeline", async () => {
      ms["getPipeline"].mockResolvedValue({ id: "p1" });
      ms["createTrigger"].mockResolvedValue({ id: "t1", type: "schedule" });
      const result = parse(
        await createTriggerHandler.execute({
          pipelineId: "p1",
          type: "schedule",
          config: { cron: "0 9 * * 1" },
        }),
      );
      expect(result).toEqual({ id: "t1", type: "schedule", created: true });
    });

    it("returns error for non-existent pipeline", async () => {
      ms["getPipeline"].mockResolvedValue(undefined);
      const result = parse(
        await createTriggerHandler.execute({ pipelineId: "nope", type: "webhook" }),
      );
      expect(result["error"]).toContain("not found");
    });

    it("rejects invalid trigger type", async () => {
      await expect(
        createTriggerHandler.execute({ pipelineId: "p1", type: "invalid" }),
      ).rejects.toThrow();
    });
  });

  describe("update_trigger", () => {
    it("updates existing trigger", async () => {
      ms["getTrigger"].mockResolvedValue({ id: "t1", type: "webhook" });
      ms["updateTrigger"].mockResolvedValue({ id: "t1", type: "webhook" });
      const result = parse(
        await updateTriggerHandler.execute({ id: "t1", enabled: false }),
      );
      expect(result["updated"]).toBe(true);
    });

    it("returns error for non-existent trigger", async () => {
      ms["getTrigger"].mockResolvedValue(undefined);
      const result = parse(await updateTriggerHandler.execute({ id: "nope" }));
      expect(result["error"]).toContain("not found");
    });
  });

  describe("delete_trigger (confirmation protocol)", () => {
    it("returns confirmation on first call", async () => {
      const result = parse(await deleteTriggerHandler.execute({ id: "t1" }));
      expect(result["needsConfirmation"]).toBe(true);
      expect(result["action"]).toBe("Delete trigger");
    });

    it("deletes when confirmed", async () => {
      ms["getTrigger"].mockResolvedValue({ id: "t1" });
      ms["deleteTrigger"].mockResolvedValue(undefined);
      const result = parse(
        await deleteTriggerHandler.execute({ id: "t1", confirmed: true }),
      );
      expect(result["deleted"]).toBe(true);
    });

    it("returns error when trigger not found", async () => {
      ms["getTrigger"].mockResolvedValue(undefined);
      const result = parse(
        await deleteTriggerHandler.execute({ id: "gone", confirmed: true }),
      );
      expect(result["error"]).toContain("not found");
    });
  });

  // ─── Utility Tools ──────────────────────────────────────────────────────

  describe("list_models", () => {
    it("returns active models", async () => {
      ms["getActiveModels"].mockResolvedValue([
        { slug: "gpt-4", name: "GPT-4", provider: "openai", isActive: true },
      ]);
      const result = parseArray(await listModelsHandler.execute({}));
      expect(result[0]["slug"]).toBe("gpt-4");
    });

    it("returns message when no models", async () => {
      ms["getActiveModels"].mockResolvedValue([]);
      expect(await listModelsHandler.execute({})).toBe("No models available.");
    });
  });

  describe("create_memory", () => {
    it("saves memory with valid input", async () => {
      ms["upsertMemory"].mockResolvedValue({ id: 1, key: "api-pattern" });
      const result = parse(
        await createMemoryHandler.execute({
          key: "api-pattern",
          content: "Always use REST for public APIs",
          type: "decision",
          tags: ["api"],
        }),
      );
      expect(result).toEqual({ id: 1, key: "api-pattern", saved: true });
      expect(ms["upsertMemory"]).toHaveBeenCalledWith({
        scope: "global",
        type: "decision",
        key: "api-pattern",
        content: "Always use REST for public APIs",
        tags: ["api"],
        confidence: 1.0,
      });
    });

    it("defaults to fact type when not specified", async () => {
      ms["upsertMemory"].mockResolvedValue({ id: 2, key: "test" });
      await createMemoryHandler.execute({ key: "test", content: "Hello" });
      expect(ms["upsertMemory"]).toHaveBeenCalledWith(
        expect.objectContaining({ type: "fact" }),
      );
    });

    it("rejects empty key", async () => {
      await expect(
        createMemoryHandler.execute({ key: "", content: "x" }),
      ).rejects.toThrow();
    });

    it("rejects empty content", async () => {
      await expect(
        createMemoryHandler.execute({ key: "k", content: "" }),
      ).rejects.toThrow();
    });
  });

  describe("search_memories", () => {
    it("returns matching memories", async () => {
      ms["searchMemories"].mockResolvedValue([
        { id: 1, key: "k1", type: "fact", content: "Hello", confidence: 0.9 },
      ]);
      const result = parseArray(
        await searchMemoriesHandler.execute({ query: "hello" }),
      );
      expect(result).toHaveLength(1);
    });

    it("returns message when no matches", async () => {
      ms["searchMemories"].mockResolvedValue([]);
      const result = await searchMemoriesHandler.execute({ query: "xyz" });
      expect(result).toContain("No memories found");
    });

    it("rejects empty query", async () => {
      await expect(searchMemoriesHandler.execute({ query: "" })).rejects.toThrow();
    });
  });

  describe("list_skills", () => {
    it("returns skills", async () => {
      ms["getSkills"].mockResolvedValue([
        { id: "s1", name: "Summarize", teamId: "planning", description: "Summarize text" },
      ]);
      const result = parseArray(await listSkillsHandler.execute({}));
      expect(result[0]["name"]).toBe("Summarize");
    });

    it("returns message when empty", async () => {
      ms["getSkills"].mockResolvedValue([]);
      expect(await listSkillsHandler.execute({})).toBe("No skills found.");
    });
  });

  describe("create_guardrail", () => {
    it("adds guardrail to existing pipeline stage", async () => {
      ms["getPipeline"].mockResolvedValue({
        id: "p1",
        stages: [{ teamId: "development" }, { teamId: "testing" }],
      });
      ms["updatePipeline"].mockResolvedValue({ id: "p1" });

      const result = parse(
        await createGuardrailHandler.execute({
          pipelineId: "p1",
          stageIndex: 0,
          guardrailType: "word_count",
          config: { maxWords: 500 },
        }),
      );
      expect(result["added"]).toBe(true);
      expect(result["stageIndex"]).toBe(0);

      const updateCall = ms["updatePipeline"].mock.calls[0] as [string, Record<string, unknown>];
      const updatedStages = updateCall[1]["stages"] as Record<string, unknown>[];
      expect(updatedStages[0]["guardrails"]).toEqual([
        { type: "word_count", maxWords: 500 },
      ]);
    });

    it("appends to existing guardrails", async () => {
      ms["getPipeline"].mockResolvedValue({
        id: "p1",
        stages: [{ teamId: "dev", guardrails: [{ type: "format_check" }] }],
      });
      ms["updatePipeline"].mockResolvedValue({ id: "p1" });

      await createGuardrailHandler.execute({
        pipelineId: "p1",
        stageIndex: 0,
        guardrailType: "keyword_block",
        config: { keywords: ["secret"] },
      });

      const updateCall = ms["updatePipeline"].mock.calls[0] as [string, Record<string, unknown>];
      const updatedStages = updateCall[1]["stages"] as Record<string, unknown>[];
      const guardrails = updatedStages[0]["guardrails"] as Record<string, unknown>[];
      expect(guardrails).toHaveLength(2);
    });

    it("returns error for non-existent pipeline", async () => {
      ms["getPipeline"].mockResolvedValue(undefined);
      const result = parse(
        await createGuardrailHandler.execute({
          pipelineId: "nope",
          stageIndex: 0,
          guardrailType: "format_check",
        }),
      );
      expect(result["error"]).toContain("not found");
    });

    it("returns error for out-of-range stage index", async () => {
      ms["getPipeline"].mockResolvedValue({
        id: "p1",
        stages: [{ teamId: "development" }],
      });
      const result = parse(
        await createGuardrailHandler.execute({
          pipelineId: "p1",
          stageIndex: 5,
          guardrailType: "keyword_block",
        }),
      );
      expect(result["error"]).toContain("out of range");
    });
  });
});

// ─── Confirmation Protocol Tests ────────────────────────────────────────────

describe("Confirmation Protocol (withConfirmation wrapper)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const destructiveTools = [
    { handler: deletePipelineHandler, name: "delete_pipeline", idField: "id" },
    { handler: cancelRunHandler, name: "cancel_run", idField: "runId" },
    { handler: deleteWorkspaceHandler, name: "delete_workspace", idField: "id" },
    { handler: deleteTriggerHandler, name: "delete_trigger", idField: "id" },
  ];

  for (const { handler, name, idField } of destructiveTools) {
    it(`${name}: has 'destructive' tag`, () => {
      expect(handler.definition.tags).toContain("destructive");
    });

    it(`${name}: returns needsConfirmation when confirmed is undefined`, async () => {
      const result = parse(await handler.execute({ [idField]: "test-id" }));
      expect(result["needsConfirmation"]).toBe(true);
      expect(typeof result["action"]).toBe("string");
      expect(typeof result["details"]).toBe("string");
    });

    it(`${name}: returns needsConfirmation when confirmed is false`, async () => {
      const result = parse(
        await handler.execute({ [idField]: "test-id", confirmed: false }),
      );
      expect(result["needsConfirmation"]).toBe(true);
    });
  }
});
