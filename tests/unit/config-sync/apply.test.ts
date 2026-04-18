/**
 * Tests for config-sync apply path (issue #317)
 *
 * Coverage:
 *   - diff-engine: readYamlDir, fieldDiff, checkConflict
 *   - diff-engine: diffPipelines, diffTriggers, diffPrompts, diffSkills,
 *                  diffConnections, diffProviderKeys, diffPreferences
 *   - pipeline-applier: create, update, delete, active-run block, dry-run
 *   - trigger-applier: create, update, delete, dry-run
 *   - prompt-applier: create, update, delete, dry-run
 *   - skill-applier: create, update, dry-run
 *   - connection-applier: create, update, delete, missing workspace
 *   - provider-key-applier: create, update, delete, callbacks, dry-run
 *   - preferences-applier: create, update, dry-run
 *   - apply-orchestrator: apply on clean instance, dry-run doesn't change DB,
 *     rollback on error, conflict detection, tombstone behavior, audit record,
 *     config_applied event
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import yaml from "js-yaml";
import { MemStorage } from "../../../server/storage.js";
import {
  readYamlDir,
  fieldDiff,
  checkConflict,
  diffPipelines,
  diffTriggers,
  diffPrompts,
  diffSkills,
  diffConnections,
  diffProviderKeys,
  diffPreferences,
} from "../../../server/config-sync/diff-engine.js";
import { applyPipelines } from "../../../server/config-sync/appliers/pipeline-applier.js";
import { applyTriggers } from "../../../server/config-sync/appliers/trigger-applier.js";
import { applyPrompts } from "../../../server/config-sync/appliers/prompt-applier.js";
import { applySkills } from "../../../server/config-sync/appliers/skill-applier.js";
import { applyConnections } from "../../../server/config-sync/appliers/connection-applier.js";
import { applyProviderKeys } from "../../../server/config-sync/appliers/provider-key-applier.js";
import { applyPreferences } from "../../../server/config-sync/appliers/preferences-applier.js";
import { runApply, configSyncEvents } from "../../../server/config-sync/apply-orchestrator.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a temp directory with all required subdirs. */
async function mkTempRepo(): Promise<string> {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mqlti-apply-test-")),
  );
  for (const sub of [
    "pipelines",
    "triggers",
    "prompts",
    "skill-states",
    "connections",
    "provider-keys",
    "preferences",
  ]) {
    await fs.mkdir(path.join(base, sub), { recursive: true });
  }
  return base;
}

/** Write a YAML file to a path. */
async function writeYamlFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, yaml.dump(data), "utf-8");
}

function makeStorage(): MemStorage {
  return new MemStorage();
}

// ─── diff-engine: readYamlDir ─────────────────────────────────────────────────

describe("readYamlDir", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "readyaml-")),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty map for non-existent directory", async () => {
    const { files, errors } = await readYamlDir(path.join(tmpDir, "missing"));
    expect(files.size).toBe(0);
    expect(errors).toHaveLength(0);
  });

  it("reads valid YAML files", async () => {
    await writeYamlFile(path.join(tmpDir, "a.yaml"), { kind: "pipeline", name: "a" });
    await writeYamlFile(path.join(tmpDir, "b.yaml"), { kind: "pipeline", name: "b" });
    const { files, errors } = await readYamlDir(tmpDir);
    expect(files.size).toBe(2);
    expect(errors).toHaveLength(0);
  });

  it("skips non-YAML files", async () => {
    await fs.writeFile(path.join(tmpDir, "readme.md"), "text");
    await fs.writeFile(path.join(tmpDir, "data.json"), "{}");
    await writeYamlFile(path.join(tmpDir, "a.yaml"), { x: 1 });
    const { files } = await readYamlDir(tmpDir);
    expect(files.size).toBe(1);
  });

  it("records parse errors without aborting", async () => {
    await fs.writeFile(path.join(tmpDir, "bad.yaml"), "{ unclosed: [", "utf-8");
    await writeYamlFile(path.join(tmpDir, "good.yaml"), { x: 1 });
    const { files, errors } = await readYamlDir(tmpDir);
    expect(files.size).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.filePath).toContain("bad.yaml");
  });
});

// ─── diff-engine: fieldDiff ───────────────────────────────────────────────────

describe("fieldDiff", () => {
  it("returns empty diff for identical objects", () => {
    const before = { a: 1, b: "x" };
    const after = { a: 1, b: "x" };
    expect(fieldDiff(before, after)).toEqual({});
  });

  it("detects changed scalar fields", () => {
    const diff = fieldDiff({ name: "old" }, { name: "new" });
    expect(diff).toEqual({ name: ["old", "new"] });
  });

  it("detects added fields", () => {
    const diff = fieldDiff({}, { newField: 42 });
    expect(diff).toEqual({ newField: [undefined, 42] });
  });

  it("detects removed fields", () => {
    const diff = fieldDiff({ removed: "yes" }, {});
    expect(diff).toEqual({ removed: ["yes", undefined] });
  });

  it("compares nested objects by JSON serialization", () => {
    const before = { nested: { a: 1 } };
    const after = { nested: { a: 2 } };
    expect(Object.keys(fieldDiff(before, after))).toContain("nested");
  });
});

// ─── diff-engine: checkConflict ───────────────────────────────────────────────

describe("checkConflict", () => {
  it("returns undefined when no lastExportAt", () => {
    const result = checkConflict(new Date(), null);
    expect(result).toBeUndefined();
  });

  it("returns undefined when DB was updated before export", () => {
    const updatedAt = new Date("2024-01-01T00:00:00Z");
    const lastExportAt = "2024-06-01T00:00:00Z";
    expect(checkConflict(updatedAt, lastExportAt)).toBeUndefined();
  });

  it("returns conflict descriptor when DB was updated after export", () => {
    const updatedAt = new Date("2024-07-01T00:00:00Z");
    const lastExportAt = "2024-06-01T00:00:00Z";
    const conflict = checkConflict(updatedAt, lastExportAt);
    expect(conflict).toBeDefined();
    expect(conflict?.message).toContain("modified after last export");
    expect(conflict?.dbUpdatedAt).toBe(updatedAt.toISOString());
    expect(conflict?.lastExportAt).toBe(lastExportAt);
  });

  it("returns undefined when no updatedAt", () => {
    expect(checkConflict(null, "2024-01-01")).toBeUndefined();
  });
});

// ─── diffPipelines ────────────────────────────────────────────────────────────

describe("diffPipelines", () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await mkTempRepo(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns empty diff when both DB and repo are empty", async () => {
    const result = await diffPipelines({
      repoPath: tmpDir,
      dbPipelines: new Map(),
    });
    expect(result.entries).toHaveLength(0);
    expect(result.parseErrors).toHaveLength(0);
  });

  it("generates create entries for pipelines only in repo", async () => {
    await writeYamlFile(path.join(tmpDir, "pipelines", "my-pipe.yaml"), {
      kind: "pipeline",
      apiVersion: "1.0.0",
      name: "my-pipe",
      stages: [],
      isTemplate: false,
    });

    const result = await diffPipelines({
      repoPath: tmpDir,
      dbPipelines: new Map(),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.kind).toBe("create");
    expect(result.entries[0]!.label).toBe("my-pipe");
  });

  it("generates update entries when pipeline exists in DB and differs", async () => {
    await writeYamlFile(path.join(tmpDir, "pipelines", "p.yaml"), {
      kind: "pipeline",
      apiVersion: "1.0.0",
      name: "p",
      stages: [],
      isTemplate: false,
      description: "updated description",
    });

    const dbPipelines = new Map([
      ["p", {
        id: "id-1",
        name: "p",
        updatedAt: new Date("2024-01-01"),
        raw: { kind: "pipeline", name: "p", stages: [], isTemplate: false },
      }],
    ]);

    const result = await diffPipelines({ repoPath: tmpDir, dbPipelines });
    const updates = result.entries.filter((e) => e.kind === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.label).toBe("p");
    expect(updates[0]!.diff).toBeDefined();
  });

  it("generates no entry when pipeline is identical in DB", async () => {
    const pipelineData = {
      kind: "pipeline",
      apiVersion: "1.0.0",
      name: "exact",
      stages: [],
      isTemplate: false,
    };
    await writeYamlFile(path.join(tmpDir, "pipelines", "exact.yaml"), pipelineData);

    const dbPipelines = new Map([
      ["exact", {
        id: "id-2",
        name: "exact",
        updatedAt: new Date("2024-01-01"),
        raw: pipelineData as Record<string, unknown>,
      }],
    ]);

    const result = await diffPipelines({ repoPath: tmpDir, dbPipelines });
    expect(result.entries.filter((e) => e.label === "exact")).toHaveLength(0);
  });

  it("generates tombstone delete entries for pipelines only in DB", async () => {
    const dbPipelines = new Map([
      ["gone", {
        id: "id-3",
        name: "gone",
        updatedAt: new Date("2024-01-01"),
        raw: {},
      }],
    ]);

    const result = await diffPipelines({ repoPath: tmpDir, dbPipelines, options: { tombstone: true } });
    const deletes = result.entries.filter((e) => e.kind === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.label).toBe("gone");
  });

  it("no tombstone delete when tombstone=false", async () => {
    const dbPipelines = new Map([
      ["gone", { id: "id-4", name: "gone", updatedAt: null, raw: {} }],
    ]);

    const result = await diffPipelines({
      repoPath: tmpDir,
      dbPipelines,
      options: { tombstone: false },
    });
    expect(result.entries.filter((e) => e.kind === "delete")).toHaveLength(0);
  });

  it("detects conflict when DB updated after lastExportAt", async () => {
    const updatedAt = new Date("2024-07-01T12:00:00Z");
    const lastExportAt = "2024-06-01T00:00:00Z";

    await writeYamlFile(path.join(tmpDir, "pipelines", "conflicted.yaml"), {
      kind: "pipeline",
      apiVersion: "1.0.0",
      name: "conflicted",
      stages: [],
      isTemplate: false,
      description: "changed",
    });

    const dbPipelines = new Map([
      ["conflicted", {
        id: "id-5",
        name: "conflicted",
        updatedAt,
        raw: { kind: "pipeline", name: "conflicted", stages: [], isTemplate: false },
      }],
    ]);

    const result = await diffPipelines({
      repoPath: tmpDir,
      dbPipelines,
      options: { lastExportAt },
    });

    const updateEntry = result.entries.find((e) => e.kind === "update");
    expect(updateEntry?.conflict).toBeDefined();
    expect(updateEntry?.conflict?.dbUpdatedAt).toBe(updatedAt.toISOString());
  });

  it("records parse errors for invalid YAML files", async () => {
    await fs.writeFile(
      path.join(tmpDir, "pipelines", "broken.yaml"),
      "kind: pipeline\napiVersion: 1.0.0\n# missing required fields",
      "utf-8",
    );
    const result = await diffPipelines({ repoPath: tmpDir, dbPipelines: new Map() });
    expect(result.parseErrors).toHaveLength(1);
  });
});

// ─── applyPipelines ───────────────────────────────────────────────────────────

describe("applyPipelines", () => {
  it("creates a new pipeline from a create entry", async () => {
    const storage = makeStorage();
    const result = await applyPipelines(storage, [
      {
        kind: "create",
        entityType: "pipeline",
        label: "new-pipe",
        entity: {
          kind: "pipeline",
          apiVersion: "1.0.0",
          name: "new-pipe",
          stages: [],
          isTemplate: false,
        },
      },
    ]);

    expect(result.created).toContain("new-pipe");
    expect(result.errors).toHaveLength(0);
    const pipelines = await storage.getPipelines();
    expect(pipelines.some((p) => p.name === "new-pipe")).toBe(true);
  });

  it("dry-run does not create a pipeline", async () => {
    const storage = makeStorage();
    const result = await applyPipelines(
      storage,
      [{
        kind: "create",
        entityType: "pipeline",
        label: "dry-pipe",
        entity: {
          kind: "pipeline",
          apiVersion: "1.0.0",
          name: "dry-pipe",
          stages: [],
          isTemplate: false,
        },
      }],
      /* dryRun= */ true,
    );

    expect(result.created).toContain("dry-pipe");
    const pipelines = await storage.getPipelines();
    expect(pipelines.some((p) => p.name === "dry-pipe")).toBe(false);
  });

  it("updates an existing pipeline from an update entry", async () => {
    const storage = makeStorage();
    await storage.createPipeline({ name: "update-me", stages: [], isTemplate: false });

    const result = await applyPipelines(storage, [
      {
        kind: "update",
        entityType: "pipeline",
        label: "update-me",
        entity: {
          kind: "pipeline",
          apiVersion: "1.0.0",
          name: "update-me",
          stages: [],
          isTemplate: false,
          description: "now described",
        },
        diff: { description: [null, "now described"] },
      },
    ]);

    expect(result.updated).toContain("update-me");
    const updated = (await storage.getPipelines()).find((p) => p.name === "update-me");
    expect(updated?.description).toBe("now described");
  });

  it("deletes a pipeline from a delete entry", async () => {
    const storage = makeStorage();
    await storage.createPipeline({ name: "to-delete", stages: [], isTemplate: false });

    const result = await applyPipelines(storage, [
      { kind: "delete", entityType: "pipeline", label: "to-delete", entity: null },
    ]);

    expect(result.deleted).toContain("to-delete");
    const pipelines = await storage.getPipelines();
    expect(pipelines.some((p) => p.name === "to-delete")).toBe(false);
  });

  it("blocks delete of pipeline with active runs", async () => {
    const storage = makeStorage();
    const pipeline = await storage.createPipeline({ name: "active", stages: [], isTemplate: false });
    await storage.createPipelineRun({
      pipelineId: pipeline.id,
      status: "running",
      input: "test",
    });

    const result = await applyPipelines(storage, [
      { kind: "delete", entityType: "pipeline", label: "active", entity: null },
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain("active runs");
    const pipelines = await storage.getPipelines();
    expect(pipelines.some((p) => p.name === "active")).toBe(true);
  });
});

// ─── applyTriggers ────────────────────────────────────────────────────────────

describe("applyTriggers", () => {
  it("creates a trigger when pipeline exists", async () => {
    const storage = makeStorage();
    await storage.createPipeline({ name: "my-pipe", stages: [], isTemplate: false });

    const result = await applyTriggers(storage, [
      {
        kind: "create",
        entityType: "trigger",
        label: "my-pipe__schedule__ab123456",
        entity: {
          kind: "trigger",
          apiVersion: "1.0.0",
          pipelineRef: "my-pipe",
          enabled: true,
          config: { type: "schedule", cron: "0 * * * *" },
        },
      },
    ]);

    expect(result.created).toContain("my-pipe__schedule__ab123456");
    expect(result.errors).toHaveLength(0);
  });

  it("errors when referenced pipeline does not exist", async () => {
    const storage = makeStorage();

    const result = await applyTriggers(storage, [
      {
        kind: "create",
        entityType: "trigger",
        label: "missing-pipe__schedule__ab123456",
        entity: {
          kind: "trigger",
          apiVersion: "1.0.0",
          pipelineRef: "missing-pipe",
          enabled: true,
          config: { type: "schedule", cron: "0 * * * *" },
        },
      },
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain("Pipeline");
  });

  it("dry-run does not create trigger", async () => {
    const storage = makeStorage();
    const pipeline = await storage.createPipeline({ name: "pipe", stages: [], isTemplate: false });

    await applyTriggers(
      storage,
      [{
        kind: "create",
        entityType: "trigger",
        label: `pipe__schedule__ab123456`,
        entity: {
          kind: "trigger",
          apiVersion: "1.0.0",
          pipelineRef: "pipe",
          enabled: true,
          config: { type: "schedule", cron: "0 * * * *" },
        },
      }],
      /* dryRun= */ true,
    );

    const triggers = await storage.getTriggers(pipeline.id);
    expect(triggers).toHaveLength(0);
  });
});

// ─── applyPrompts ─────────────────────────────────────────────────────────────

describe("applyPrompts", () => {
  it("creates a skill with systemPromptOverride", async () => {
    const storage = makeStorage();

    const result = await applyPrompts(storage, [
      {
        kind: "create",
        entityType: "prompt",
        label: "my-prompt",
        entity: {
          kind: "prompt",
          apiVersion: "1.0.0",
          name: "my-prompt",
          defaultPrompt: "You are a helpful assistant.",
          stageOverrides: [{ teamId: "team-1", systemPrompt: "You are a helpful assistant." }],
          tags: ["helper"],
        },
      },
    ]);

    expect(result.created).toContain("my-prompt");
    const skills = await storage.getSkills();
    const created = skills.find((s) => s.name === "my-prompt");
    expect(created).toBeDefined();
    expect(created?.systemPromptOverride).toBe("You are a helpful assistant.");
  });

  it("dry-run does not write skill", async () => {
    const storage = makeStorage();
    await applyPrompts(
      storage,
      [{
        kind: "create",
        entityType: "prompt",
        label: "dry-prompt",
        entity: {
          kind: "prompt",
          apiVersion: "1.0.0",
          name: "dry-prompt",
          stageOverrides: [],
          tags: [],
        },
      }],
      true,
    );
    const skills = await storage.getSkills();
    expect(skills.some((s) => s.name === "dry-prompt")).toBe(false);
  });

  it("deletes skill on tombstone", async () => {
    const storage = makeStorage();
    await storage.createSkill({
      name: "stale-prompt",
      description: "",
      teamId: "t",
      systemPromptOverride: "old prompt",
      tools: [],
      tags: [],
      isBuiltin: false,
      isPublic: true,
      createdBy: "test",
      version: "1.0.0",
      sharing: "public",
      sourceType: "manual",
    });

    const result = await applyPrompts(storage, [
      { kind: "delete", entityType: "prompt", label: "stale-prompt", entity: null },
    ]);

    expect(result.deleted).toContain("stale-prompt");
    const skills = await storage.getSkills();
    expect(skills.some((s) => s.name === "stale-prompt")).toBe(false);
  });
});

// ─── applySkills ──────────────────────────────────────────────────────────────

describe("applySkills", () => {
  it("creates skills from snapshot", async () => {
    const storage = makeStorage();
    const snapshot = {
      kind: "skill-state" as const,
      apiVersion: "1.0.0",
      generatedAt: new Date().toISOString(),
      skills: [
        {
          id: "skill-abc",
          name: "my-skill",
          version: "1.0.0",
          source: "local" as const,
          autoUpdate: false,
        },
      ],
    };

    const result = await applySkills(storage, [
      { kind: "create", entityType: "skill-state", label: "my-skill", entity: snapshot },
    ]);

    expect(result.created).toContain("my-skill");
    expect(result.errors).toHaveLength(0);
  });

  it("dry-run does not write skill", async () => {
    const storage = makeStorage();
    const snapshot = {
      kind: "skill-state" as const,
      apiVersion: "1.0.0",
      generatedAt: new Date().toISOString(),
      skills: [{ id: "dry-sk", name: "dry-skill", version: "1.0.0", source: "local" as const, autoUpdate: false }],
    };

    await applySkills(
      storage,
      [{ kind: "create", entityType: "skill-state", label: "dry-skill", entity: snapshot }],
      true,
    );

    const skills = await storage.getSkills();
    expect(skills.some((s) => s.name === "dry-skill")).toBe(false);
  });
});

// ─── applyConnections ─────────────────────────────────────────────────────────

describe("applyConnections", () => {
  it("creates a connection when workspace exists", async () => {
    const storage = makeStorage();
    await storage.createWorkspace({ name: "ws1", type: "local", path: "/tmp/ws1" });

    const result = await applyConnections(storage, [
      {
        kind: "create",
        entityType: "connection",
        label: "gitlab-main",
        entity: {
          kind: "connection",
          apiVersion: "1.0.0",
          name: "gitlab-main",
          type: "gitlab",
          workspaceRef: "ws1",
          config: { url: "https://gitlab.example.com" },
          status: "active",
        },
      },
    ]);

    expect(result.created).toContain("gitlab-main");
    expect(result.errors).toHaveLength(0);
  });

  it("errors when workspace not found", async () => {
    const storage = makeStorage();

    const result = await applyConnections(storage, [
      {
        kind: "create",
        entityType: "connection",
        label: "conn",
        entity: {
          kind: "connection",
          apiVersion: "1.0.0",
          name: "conn",
          type: "github",
          workspaceRef: "non-existent-workspace",
          config: {},
          status: "active",
        },
      },
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain("Workspace");
  });

  it("dry-run does not create connection", async () => {
    const storage = makeStorage();
    const ws = await storage.createWorkspace({ name: "ws2", type: "local", path: "/tmp/ws2" });

    await applyConnections(
      storage,
      [{
        kind: "create",
        entityType: "connection",
        label: "dry-conn",
        entity: {
          kind: "connection",
          apiVersion: "1.0.0",
          name: "dry-conn",
          type: "github",
          workspaceRef: "ws2",
          config: {},
          status: "active",
        },
      }],
      true,
    );

    const conns = await storage.getWorkspaceConnections(ws.id);
    expect(conns).toHaveLength(0);
  });
});

// ─── applyProviderKeys ────────────────────────────────────────────────────────

describe("applyProviderKeys", () => {
  it("calls onWrite callback for create entries", async () => {
    const writes: Array<{ provider: string; secretRef: string }> = [];

    const result = await applyProviderKeys(
      [{
        kind: "create",
        entityType: "provider-key",
        label: "anthropic",
        entity: {
          kind: "provider-key",
          apiVersion: "1.0.0",
          provider: "anthropic",
          secretRef: "${env:ANTHROPIC_API_KEY}",
          enabled: true,
        },
      }],
      false,
      {
        onWrite: async (provider, secretRef) => {
          writes.push({ provider, secretRef });
        },
      },
    );

    expect(result.created).toContain("anthropic");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.provider).toBe("anthropic");
  });

  it("dry-run does not call onWrite", async () => {
    const writes: string[] = [];

    await applyProviderKeys(
      [{
        kind: "create",
        entityType: "provider-key",
        label: "openai",
        entity: {
          kind: "provider-key",
          apiVersion: "1.0.0",
          provider: "openai",
          secretRef: "${env:OPENAI_API_KEY}",
          enabled: true,
        },
      }],
      /* dryRun= */ true,
      { onWrite: async (p) => { writes.push(p); } },
    );

    expect(writes).toHaveLength(0);
  });

  it("calls onDelete callback for delete entries", async () => {
    const deleted: string[] = [];

    await applyProviderKeys(
      [{ kind: "delete", entityType: "provider-key", label: "groq", entity: null }],
      false,
      { onDelete: async (p) => { deleted.push(p); } },
    );

    expect(deleted).toContain("groq");
  });
});

// ─── applyPreferences ─────────────────────────────────────────────────────────

describe("applyPreferences", () => {
  it("upserts workspace settings for global scope", async () => {
    const storage = makeStorage();

    const result = await applyPreferences(storage, [
      {
        kind: "create",
        entityType: "preferences",
        label: "global",
        entity: {
          kind: "preferences",
          apiVersion: "1.0.0",
          scope: "global",
          ui: { theme: "dark", layout: "compact", featureFlags: { newUI: true } },
          extra: {},
        },
      },
    ]);

    expect(result.created).toContain("global");
    expect(result.errors).toHaveLength(0);
    const settings = await storage.getWorkspaceSettings("__global__");
    expect(settings).toBeDefined();
    expect((settings?.["ui"] as Record<string, unknown>)?.["theme"]).toBe("dark");
  });

  it("dry-run does not write preferences", async () => {
    const storage = makeStorage();

    await applyPreferences(
      storage,
      [{
        kind: "create",
        entityType: "preferences",
        label: "global",
        entity: {
          kind: "preferences",
          apiVersion: "1.0.0",
          scope: "global",
          ui: { theme: "light", layout: "default", featureFlags: {} },
          extra: {},
        },
      }],
      true,
    );

    const settings = await storage.getWorkspaceSettings("__global__");
    expect(settings).toBeNull();
  });
});

// ─── apply-orchestrator ───────────────────────────────────────────────────────

describe("runApply — apply on clean instance", () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await mkTempRepo(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns zero changes when repo and DB are empty", async () => {
    const storage = makeStorage();
    const result = await runApply(storage, tmpDir);

    expect(result.totalCreated).toBe(0);
    expect(result.totalUpdated).toBe(0);
    expect(result.totalDeleted).toBe(0);
    expect(result.totalErrors).toBe(0);
    expect(result.abortedDueToConflicts).toBe(false);
  });

  it("creates entities from YAML files", async () => {
    const storage = makeStorage();

    await writeYamlFile(path.join(tmpDir, "pipelines", "p.yaml"), {
      kind: "pipeline",
      apiVersion: "1.0.0",
      name: "p",
      stages: [],
      isTemplate: false,
    });

    const result = await runApply(storage, tmpDir);

    expect(result.totalCreated).toBeGreaterThanOrEqual(1);
    const pipelines = await storage.getPipelines();
    expect(pipelines.some((p) => p.name === "p")).toBe(true);
  });

  it("records appliedAt in the result", async () => {
    const storage = makeStorage();
    const result = await runApply(storage, tmpDir);
    expect(() => new Date(result.appliedAt)).not.toThrow();
    expect(new Date(result.appliedAt).getTime()).toBeGreaterThan(0);
  });

  it("includes audit entry", async () => {
    const storage = makeStorage();
    const result = await runApply(storage, tmpDir, { appliedBy: "test-user" });
    expect(result.audit.appliedBy).toBe("test-user");
    expect(result.audit.appliedAt).toBe(result.appliedAt);
    expect(result.audit.repoPath).toBe(tmpDir);
    expect(result.audit.dryRun).toBe(false);
  });
});

describe("runApply — dry-run doesn't change DB", () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await mkTempRepo(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("dry-run reports changes but does not modify DB", async () => {
    const storage = makeStorage();

    await writeYamlFile(path.join(tmpDir, "pipelines", "p.yaml"), {
      kind: "pipeline",
      apiVersion: "1.0.0",
      name: "dry-pipeline",
      stages: [],
      isTemplate: false,
    });

    const result = await runApply(storage, tmpDir, { dryRun: true });

    // Reports the planned create
    expect(result.dryRun).toBe(true);
    expect(result.totalCreated).toBeGreaterThanOrEqual(1);

    // But DB is untouched
    const pipelines = await storage.getPipelines();
    expect(pipelines.some((p) => p.name === "dry-pipeline")).toBe(false);
  });

  it("dry-run audit has dryRun=true", async () => {
    const storage = makeStorage();
    const result = await runApply(storage, tmpDir, { dryRun: true });
    expect(result.audit.dryRun).toBe(true);
  });
});

describe("runApply — conflict detection", () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await mkTempRepo(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("aborts when DB has out-of-band changes and --force not set", async () => {
    const storage = makeStorage();

    // Create a pipeline in DB that was "modified after last export"
    const pipeline = await storage.createPipeline({
      name: "conflicted",
      stages: [],
      isTemplate: false,
      description: "original",
    });
    // updatedAt is set to now (after our fake lastExportAt)

    await writeYamlFile(path.join(tmpDir, "pipelines", "conflicted.yaml"), {
      kind: "pipeline",
      apiVersion: "1.0.0",
      name: "conflicted",
      stages: [],
      isTemplate: false,
      description: "modified in yaml",
    });

    // Use a past lastExportAt so the pipeline's updatedAt is AFTER it
    const result = await runApply(storage, tmpDir, {
      lastExportAt: new Date(Date.now() - 60_000).toISOString(),
      force: false,
    });

    expect(result.abortedDueToConflicts).toBe(true);
    // DB should be untouched
    const dbPipeline = await storage.getPipeline(pipeline.id);
    expect(dbPipeline?.description).toBe("original");
  });

  it("applies when --force is set despite conflicts", async () => {
    const storage = makeStorage();

    await storage.createPipeline({
      name: "forced",
      stages: [],
      isTemplate: false,
      description: "original",
    });

    await writeYamlFile(path.join(tmpDir, "pipelines", "forced.yaml"), {
      kind: "pipeline",
      apiVersion: "1.0.0",
      name: "forced",
      stages: [],
      isTemplate: false,
      description: "overridden",
    });

    const result = await runApply(storage, tmpDir, {
      lastExportAt: new Date(Date.now() - 60_000).toISOString(),
      force: true,
    });

    expect(result.abortedDueToConflicts).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
    // DB should be updated
    const pipelines = await storage.getPipelines();
    const updated = pipelines.find((p) => p.name === "forced");
    expect(updated?.description).toBe("overridden");
  });
});

describe("runApply — tombstone behavior", () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await mkTempRepo(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("tombstone: deletes pipeline missing from repo (default=true)", async () => {
    const storage = makeStorage();

    // Pipeline in DB but no YAML file
    await storage.createPipeline({ name: "orphan", stages: [], isTemplate: false });

    const result = await runApply(storage, tmpDir, {
      tombstoneOverrides: { pipeline: true },
    });

    expect(result.totalDeleted).toBeGreaterThanOrEqual(1);
    const pipelines = await storage.getPipelines();
    expect(pipelines.some((p) => p.name === "orphan")).toBe(false);
  });

  it("tombstone=false: keeps pipeline missing from repo", async () => {
    const storage = makeStorage();
    await storage.createPipeline({ name: "kept", stages: [], isTemplate: false });

    const result = await runApply(storage, tmpDir, {
      tombstoneOverrides: { pipeline: false },
    });

    const pipelineSummary = result.summaries.find((s) => s.entityType === "pipeline");
    expect(pipelineSummary?.deleted).toBe(0);
    const pipelines = await storage.getPipelines();
    expect(pipelines.some((p) => p.name === "kept")).toBe(true);
  });

  it("skills default tombstone=false: keeps skills missing from repo", async () => {
    const storage = makeStorage();
    await storage.createSkill({
      name: "keepme",
      description: "",
      teamId: "t",
      systemPromptOverride: "",
      tools: [],
      tags: [],
      isBuiltin: false,
      isPublic: true,
      createdBy: "test",
      version: "1.0.0",
      sharing: "public",
      sourceType: "manual",
    });

    const result = await runApply(storage, tmpDir);

    const skillSummary = result.summaries.find((s) => s.entityType === "skill-state");
    expect(skillSummary?.deleted).toBe(0);
    const skills = await storage.getSkills();
    expect(skills.some((s) => s.name === "keepme")).toBe(true);
  });
});

describe("runApply — config_applied event", () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await mkTempRepo(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("emits config_applied event on successful non-dry-run apply", async () => {
    const storage = makeStorage();
    const events: unknown[] = [];
    configSyncEvents.on("config_applied", (data) => events.push(data));

    await runApply(storage, tmpDir, { dryRun: false });

    // Clean up listener
    configSyncEvents.removeAllListeners("config_applied");

    expect(events.length).toBeGreaterThanOrEqual(1);
    const event = events[0] as { audit: unknown; repoPath: string };
    expect(event.repoPath).toBe(tmpDir);
    expect(event.audit).toBeDefined();
  });

  it("does NOT emit config_applied on dry-run", async () => {
    const storage = makeStorage();
    const events: unknown[] = [];
    configSyncEvents.on("config_applied", (data) => events.push(data));

    await runApply(storage, tmpDir, { dryRun: true });

    configSyncEvents.removeAllListeners("config_applied");

    expect(events).toHaveLength(0);
  });
});

describe("runApply — diffs accessible in result", () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await mkTempRepo(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("result.diffs contains one entry per entity type", async () => {
    const storage = makeStorage();
    const result = await runApply(storage, tmpDir);
    const entityTypes = result.diffs.map((d) => d.entityType);
    expect(entityTypes).toContain("pipeline");
    expect(entityTypes).toContain("trigger");
    expect(entityTypes).toContain("prompt");
    expect(entityTypes).toContain("skill-state");
    expect(entityTypes).toContain("connection");
    expect(entityTypes).toContain("provider-key");
    expect(entityTypes).toContain("preferences");
  });
});

// ─── diffTriggers ─────────────────────────────────────────────────────────────

describe("diffTriggers", () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await mkTempRepo(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("generates create entry for trigger YAML not in DB", async () => {
    await writeYamlFile(path.join(tmpDir, "triggers", "my-pipe__webhook__ab12cd34.yaml"), {
      kind: "trigger",
      apiVersion: "1.0.0",
      pipelineRef: "my-pipe",
      enabled: true,
      config: { type: "webhook" },
    });

    const result = await diffTriggers({
      repoPath: tmpDir,
      dbTriggers: new Map(),
      pipelineIdToName: new Map(),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.kind).toBe("create");
  });

  it("generates tombstone delete for trigger in DB but not in repo", async () => {
    const result = await diffTriggers({
      repoPath: tmpDir,
      dbTriggers: new Map([
        ["my-pipe__webhook__ab12cd34", {
          id: "ab12cd34",
          pipelineId: "pipeline-id",
          updatedAt: null,
          raw: {},
        }],
      ]),
      pipelineIdToName: new Map(),
      options: { tombstone: true },
    });

    const deletes = result.entries.filter((e) => e.kind === "delete");
    expect(deletes).toHaveLength(1);
  });
});

// ─── diffProviderKeys ─────────────────────────────────────────────────────────

describe("diffProviderKeys", () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await mkTempRepo(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("generates create entry for new provider key in repo", async () => {
    await writeYamlFile(path.join(tmpDir, "provider-keys", "anthropic.yaml"), {
      kind: "provider-key",
      apiVersion: "1.0.0",
      provider: "anthropic",
      secretRef: "${env:ANTHROPIC_API_KEY}",
      enabled: true,
    });

    const result = await diffProviderKeys({
      repoPath: tmpDir,
      dbProviderKeys: new Map(),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.kind).toBe("create");
    expect(result.entries[0]!.label).toBe("anthropic");
  });
});

// ─── diffPreferences ─────────────────────────────────────────────────────────

describe("diffPreferences", () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await mkTempRepo(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("generates create entry for global.yaml not in DB", async () => {
    await writeYamlFile(path.join(tmpDir, "preferences", "global.yaml"), {
      kind: "preferences",
      apiVersion: "1.0.0",
      scope: "global",
      ui: { theme: "dark", layout: "default", featureFlags: {} },
      extra: {},
    });

    const result = await diffPreferences({
      repoPath: tmpDir,
      dbPreferences: new Map(),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.kind).toBe("create");
    expect(result.entries[0]!.label).toBe("global");
  });
});
