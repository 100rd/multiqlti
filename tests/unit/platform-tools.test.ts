import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock Storage ───────────────────────────────────────────────────────────

vi.mock("../../server/storage", () => {
  const fns = {
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
  };
  return { storage: fns };
});

// ─── Imports (after mock declaration) ───────────────────────────────────────

import { storage } from "../../server/storage";

import {
  listWorkspacesHandler,
  createWorkspaceHandler,
  deleteWorkspaceHandler,
} from "../../server/tools/builtin/platform/workspaces";

import {
  updateTriggerHandler,
  deleteTriggerHandler,
} from "../../server/tools/builtin/platform/triggers";

import {
  listModelsHandler,
  listSkillsHandler,
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
    it("exports all 7 platform tools", () => {
      expect(platformTools).toHaveLength(7);
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

});

// ─── Confirmation Protocol Tests ────────────────────────────────────────────

describe("Confirmation Protocol (withConfirmation wrapper)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const destructiveTools = [
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
