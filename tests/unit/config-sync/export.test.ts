/**
 * Tests for config-sync export path (issue #316)
 *
 * Coverage:
 *   - yaml-writer: atomic write, idempotent output, sortKeysDeep
 *   - pipeline-exporter: roundtrip, slug generation, audit comment
 *   - trigger-exporter: per-pipeline triggers, secret marker
 *   - prompt-exporter: skill with systemPromptOverride
 *   - skill-exporter: lock-file snapshot
 *   - connection-exporter: public vs secret separation
 *   - provider-key-exporter: no key material in YAML
 *   - preferences-exporter: global + per-workspace
 *   - export-orchestrator: all exporters run, summary, idempotency
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import yaml from "js-yaml";
import { MemStorage } from "../../../server/storage.js";
import { runExport } from "../../../server/config-sync/export-orchestrator.js";
import { writeYaml, sortKeysDeep } from "../../../server/config-sync/exporters/yaml-writer.js";
import { sanitizeSlug, buildAuditComment } from "../../../server/config-sync/exporters/pipeline-exporter.js";
import { exportPipelines } from "../../../server/config-sync/exporters/pipeline-exporter.js";
import { exportTriggers } from "../../../server/config-sync/exporters/trigger-exporter.js";
import { exportPrompts } from "../../../server/config-sync/exporters/prompt-exporter.js";
import { exportSkills } from "../../../server/config-sync/exporters/skill-exporter.js";
import { exportConnections } from "../../../server/config-sync/exporters/connection-exporter.js";
import { exportProviderKeys } from "../../../server/config-sync/exporters/provider-key-exporter.js";
import { exportPreferences } from "../../../server/config-sync/exporters/preferences-exporter.js";
import {
  PipelineConfigEntitySchema,
  TriggerConfigEntitySchema,
  PromptConfigEntitySchema,
  SkillStateConfigEntitySchema,
  ConnectionConfigEntitySchema,
  ProviderKeyConfigEntitySchema,
  PreferencesConfigEntitySchema,
} from "../../../shared/config-sync/schemas.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Create a temp directory with all required subdirs. */
async function mkTempRepo(): Promise<string> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mqlti-export-test-")));
  for (const sub of ["pipelines", "triggers", "prompts", "skill-states", "connections", "provider-keys", "preferences"]) {
    await fs.mkdir(path.join(base, sub), { recursive: true });
  }
  return base;
}

/** Read and YAML-parse a file from disk. */
async function readYaml(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf-8");
  return yaml.load(raw);
}

/** Return the file content as a string. */
async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

/**
 * Strip lines that should be excluded from idempotency comparison:
 *  - Comment lines (start with '# ') — may contain timestamps
 *  - generatedAt lines (skill-state snapshot time — changes every run by design)
 */
function normaliseForIdempotency(content: string): string {
  return content
    .split("\n")
    .filter((l) => !l.startsWith("# ") && !l.trimStart().startsWith("generatedAt:"))
    .join("\n");
}

// ─── MemStorage factory helpers ───────────────────────────────────────────────

function makeStorage(): MemStorage {
  return new MemStorage();
}

// ─── yaml-writer tests ────────────────────────────────────────────────────────

describe("sortKeysDeep", () => {
  it("sorts top-level object keys alphabetically", () => {
    const input = { z: 1, a: 2, m: 3 };
    const result = sortKeysDeep(input) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["a", "m", "z"]);
  });

  it("sorts nested object keys recursively", () => {
    const input = { b: { y: 1, x: 2 }, a: { d: 3, c: 4 } };
    const result = sortKeysDeep(input) as Record<string, Record<string, unknown>>;
    expect(Object.keys(result)).toEqual(["a", "b"]);
    expect(Object.keys(result["a"]!)).toEqual(["c", "d"]);
    expect(Object.keys(result["b"]!)).toEqual(["x", "y"]);
  });

  it("preserves array order", () => {
    const input = { items: [3, 1, 2] };
    const result = sortKeysDeep(input) as { items: number[] };
    expect(result.items).toEqual([3, 1, 2]);
  });

  it("handles arrays of objects — sorts keys within each element", () => {
    const input = { items: [{ z: 1, a: 2 }, { y: 3, b: 4 }] };
    const result = sortKeysDeep(input) as { items: Array<Record<string, unknown>> };
    expect(Object.keys(result.items[0]!)).toEqual(["a", "z"]);
    expect(Object.keys(result.items[1]!)).toEqual(["b", "y"]);
  });

  it("passes primitives through unchanged", () => {
    expect(sortKeysDeep(42)).toBe(42);
    expect(sortKeysDeep("hello")).toBe("hello");
    expect(sortKeysDeep(null)).toBeNull();
    expect(sortKeysDeep(true)).toBe(true);
  });
});

describe("writeYaml", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "write-yaml-test-")),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a valid YAML file", async () => {
    const outPath = path.join(tmpDir, "test.yaml");
    await writeYaml(outPath, { kind: "pipeline", name: "foo" });
    const parsed = await readYaml(outPath);
    expect(parsed).toEqual({ kind: "pipeline", name: "foo" });
  });

  it("prepends comment lines when provided", async () => {
    const outPath = path.join(tmpDir, "with-comment.yaml");
    await writeYaml(outPath, { x: 1 }, { comment: "line1\nline2" });
    const content = await readFile(outPath);
    expect(content).toMatch(/^# line1\n# line2\n/);
  });

  it("creates parent directories if they do not exist", async () => {
    const outPath = path.join(tmpDir, "nested", "deep", "file.yaml");
    await writeYaml(outPath, { ok: true });
    const parsed = await readYaml(outPath);
    expect(parsed).toEqual({ ok: true });
  });

  it("produces identical content on repeated writes (idempotent)", async () => {
    const outPath = path.join(tmpDir, "idem.yaml");
    const data = { z: 1, a: 2, nested: { y: 3, x: 4 } };
    await writeYaml(outPath, data);
    const first = await readFile(outPath);
    await writeYaml(outPath, data);
    const second = await readFile(outPath);
    expect(first).toBe(second);
  });

  it("sorts keys for deterministic output regardless of insertion order", async () => {
    const outPath1 = path.join(tmpDir, "order1.yaml");
    const outPath2 = path.join(tmpDir, "order2.yaml");
    await writeYaml(outPath1, { z: 1, a: 2 });
    await writeYaml(outPath2, { a: 2, z: 1 });
    const c1 = await readFile(outPath1);
    const c2 = await readFile(outPath2);
    expect(c1).toBe(c2);
  });
});

// ─── sanitizeSlug / buildAuditComment ────────────────────────────────────────

describe("sanitizeSlug", () => {
  it("lowercases and replaces non-slug chars", () => {
    expect(sanitizeSlug("My Pipeline Name!", "abc-def")).toBe("my-pipeline-name");
  });

  it("collapses consecutive dashes", () => {
    expect(sanitizeSlug("a  b  c", "x")).toBe("a-b-c");
  });

  it("falls back to first 8 chars of id when name is empty", () => {
    expect(sanitizeSlug("", "abcdefgh12")).toBe("abcdefgh");
  });

  it("truncates slug to 80 chars", () => {
    const long = "a".repeat(200);
    expect(sanitizeSlug(long, "id").length).toBeLessThanOrEqual(80);
  });
});

describe("buildAuditComment", () => {
  it("includes kind and id", () => {
    const c = buildAuditComment({ kind: "pipeline", id: "p1" });
    expect(c).toContain("kind: pipeline");
    expect(c).toContain("id: p1");
  });

  it("includes createdAt and updatedAt when provided", () => {
    const ts = new Date("2025-01-01T00:00:00Z");
    const c = buildAuditComment({ kind: "trigger", id: "t1", createdAt: ts, updatedAt: ts });
    expect(c).toContain("created_at: 2025-01-01T00:00:00.000Z");
    expect(c).toContain("updated_at: 2025-01-01T00:00:00.000Z");
  });
});

// ─── pipeline-exporter tests ──────────────────────────────────────────────────

describe("exportPipelines", () => {
  let tmpDir: string;
  let store: MemStorage;

  beforeEach(async () => {
    tmpDir = await mkTempRepo();
    store = makeStorage();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("exports an empty pipeline set without errors", async () => {
    const result = await exportPipelines(store, tmpDir);
    expect(result.exported).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("exports a pipeline to YAML and validates schema", async () => {
    await store.createPipeline({
      name: "My Test Pipeline",
      description: "A test pipeline",
      stages: [
        {
          teamId: "team-a",
          modelSlug: "claude-sonnet",
          enabled: true,
        },
      ],
      isTemplate: false,
    });

    const result = await exportPipelines(store, tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.exported).toHaveLength(1);

    const parsed = await readYaml(result.exported[0]!);
    const validated = PipelineConfigEntitySchema.parse(parsed);
    expect(validated.kind).toBe("pipeline");
    expect(validated.name).toBe("My Test Pipeline");
    expect(validated.stages).toHaveLength(1);
    expect(validated.stages[0]!.teamId).toBe("team-a");
  });

  it("generates slug from pipeline name", async () => {
    await store.createPipeline({ name: "Prod Deploy", stages: [] });
    const result = await exportPipelines(store, tmpDir);
    expect(result.exported[0]).toMatch(/prod-deploy\.yaml$/);
  });

  it("writes audit comment with created_at", async () => {
    await store.createPipeline({ name: "Audit Test", stages: [] });
    const result = await exportPipelines(store, tmpDir);
    const content = await readFile(result.exported[0]!);
    expect(content).toContain("# created_at:");
  });

  it("produces byte-identical YAML on second export (idempotent)", async () => {
    await store.createPipeline({
      name: "Idem Pipeline",
      description: "test",
      stages: [{ teamId: "t", modelSlug: "m", enabled: true }],
    });

    const r1 = await exportPipelines(store, tmpDir);
    const c1 = await readFile(r1.exported[0]!);

    const r2 = await exportPipelines(store, tmpDir);
    const c2 = await readFile(r2.exported[0]!);

    // Body (skip audit comment timestamp which varies)
    // The YAML body section should be identical; sort order ensures this
    const body1 = c1.split("\n").filter((l) => !l.startsWith("# ")).join("\n");
    const body2 = c2.split("\n").filter((l) => !l.startsWith("# ")).join("\n");
    expect(body1).toBe(body2);
  });

  it("exports multiple pipelines", async () => {
    await store.createPipeline({ name: "Pipeline A", stages: [] });
    await store.createPipeline({ name: "Pipeline B", stages: [] });
    const result = await exportPipelines(store, tmpDir);
    expect(result.exported).toHaveLength(2);
  });

  it("does not export pipeline runs (ephemeral)", async () => {
    const pipeline = await store.createPipeline({ name: "Run Test", stages: [] });
    await store.createPipelineRun({
      pipelineId: pipeline.id,
      status: "completed",
      input: "test",
    });
    const result = await exportPipelines(store, tmpDir);
    expect(result.exported).toHaveLength(1);
    // No run data in the YAML
    const parsed = await readYaml(result.exported[0]!) as Record<string, unknown>;
    expect(parsed["runs"]).toBeUndefined();
    expect(parsed["status"]).toBeUndefined();
  });
});

// ─── trigger-exporter tests ───────────────────────────────────────────────────

describe("exportTriggers", () => {
  let tmpDir: string;
  let store: MemStorage;

  beforeEach(async () => {
    tmpDir = await mkTempRepo();
    store = makeStorage();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("exports no files when no pipelines exist", async () => {
    const result = await exportTriggers(store, tmpDir);
    expect(result.exported).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("exports a schedule trigger to YAML", async () => {
    const pipeline = await store.createPipeline({ name: "Scheduled Pipeline", stages: [] });
    await store.createTrigger({
      pipelineId: pipeline.id,
      type: "schedule",
      config: { type: "schedule", cron: "0 9 * * *" } as unknown as import("@shared/types").TriggerConfig,
      enabled: true,
    });

    const result = await exportTriggers(store, tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.exported).toHaveLength(1);

    const parsed = await readYaml(result.exported[0]!);
    const validated = TriggerConfigEntitySchema.parse(parsed);
    expect(validated.kind).toBe("trigger");
    expect(validated.pipelineRef).toBe("Scheduled Pipeline");
    expect(validated.config.type).toBe("schedule");
  });

  it("exports a webhook trigger to YAML", async () => {
    const pipeline = await store.createPipeline({ name: "Webhook Pipeline", stages: [] });
    await store.createTrigger({
      pipelineId: pipeline.id,
      type: "webhook",
      config: { type: "webhook" } as unknown as import("@shared/types").TriggerConfig,
      enabled: true,
    });

    const result = await exportTriggers(store, tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.exported).toHaveLength(1);

    const parsed = await readYaml(result.exported[0]!);
    const validated = TriggerConfigEntitySchema.parse(parsed);
    expect(validated.config.type).toBe("webhook");
  });

  it("writes .has-secret marker file when trigger has secretEncrypted", async () => {
    const pipeline = await store.createPipeline({ name: "Secret Pipeline", stages: [] });
    await store.createTrigger({
      pipelineId: pipeline.id,
      type: "webhook",
      config: { type: "webhook" } as unknown as import("@shared/types").TriggerConfig,
      enabled: true,
      secretEncrypted: "encrypted-value",
    });

    const result = await exportTriggers(store, tmpDir);
    expect(result.exported).toHaveLength(1);

    const slug = path.basename(result.exported[0]!, ".yaml");
    const markerPath = path.join(tmpDir, "triggers", `${slug}.has-secret`);
    const markerContent = await readFile(markerPath);
    expect(markerContent).toContain("secretEncrypted");
  });

  it("does not include secretEncrypted in YAML output", async () => {
    const pipeline = await store.createPipeline({ name: "No Leak Pipeline", stages: [] });
    await store.createTrigger({
      pipelineId: pipeline.id,
      type: "webhook",
      config: { type: "webhook" } as unknown as import("@shared/types").TriggerConfig,
      enabled: true,
      secretEncrypted: "super-secret",
    });

    const result = await exportTriggers(store, tmpDir);
    const content = await readFile(result.exported[0]!);
    expect(content).not.toContain("super-secret");
    expect(content).not.toContain("secretEncrypted");
  });
});

// ─── prompt-exporter tests ────────────────────────────────────────────────────

describe("exportPrompts", () => {
  let tmpDir: string;
  let store: MemStorage;

  beforeEach(async () => {
    tmpDir = await mkTempRepo();
    store = makeStorage();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("exports no prompts when no skills exist", async () => {
    const result = await exportPrompts(store, tmpDir);
    expect(result.exported).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("skips skills without systemPromptOverride", async () => {
    await store.createSkill({
      name: "No Prompt Skill",
      teamId: "team-a",
      systemPromptOverride: "",
    });
    const result = await exportPrompts(store, tmpDir);
    expect(result.exported).toHaveLength(0);
  });

  it("exports skill with systemPromptOverride to prompt YAML", async () => {
    await store.createSkill({
      name: "Research Skill",
      teamId: "team-research",
      systemPromptOverride: "You are a research assistant.",
      description: "Helps with research",
      tags: ["research", "ai"],
    });

    const result = await exportPrompts(store, tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.exported).toHaveLength(1);

    const parsed = await readYaml(result.exported[0]!);
    const validated = PromptConfigEntitySchema.parse(parsed);
    expect(validated.kind).toBe("prompt");
    expect(validated.name).toBe("Research Skill");
    expect(validated.defaultPrompt).toBe("You are a research assistant.");
    expect(validated.tags).toContain("research");
  });

  it("does not export workspace code (systemPromptOverride is exported as prompt content, not code)", async () => {
    // The distinction: prompts export the *override text*, not any compiled/workspace code.
    // Workspace code is excluded.
    await store.createSkill({
      name: "Skill With Prompt",
      teamId: "t",
      systemPromptOverride: "Simple prompt text",
    });
    const result = await exportPrompts(store, tmpDir);
    const parsed = await readYaml(result.exported[0]!) as Record<string, unknown>;
    // No workspace code fields should appear
    expect(parsed["workspaceCode"]).toBeUndefined();
    expect(parsed["compiledCode"]).toBeUndefined();
  });
});

// ─── skill-exporter tests ─────────────────────────────────────────────────────

describe("exportSkills", () => {
  let tmpDir: string;
  let store: MemStorage;

  beforeEach(async () => {
    tmpDir = await mkTempRepo();
    store = makeStorage();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("exports an empty skill-state snapshot file", async () => {
    const result = await exportSkills(store, tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.exported).toHaveLength(1);
    expect(result.exported[0]).toMatch(/skill-state\.yaml$/);

    const parsed = await readYaml(result.exported[0]!);
    const validated = SkillStateConfigEntitySchema.parse(parsed);
    expect(validated.kind).toBe("skill-state");
    expect(validated.skills).toHaveLength(0);
  });

  it("includes installed skills in the snapshot", async () => {
    await store.createSkill({
      name: "Code Skill",
      teamId: "team-dev",
      systemPromptOverride: "You write code.",
      version: "1.2.0",
      isBuiltin: false,
    });

    const result = await exportSkills(store, tmpDir);
    const parsed = await readYaml(result.exported[0]!);
    const validated = SkillStateConfigEntitySchema.parse(parsed);
    expect(validated.skills).toHaveLength(1);
    expect(validated.skills[0]!.name).toBe("Code Skill");
    expect(validated.skills[0]!.version).toBe("1.2.0");
  });

  it("marks builtin skills with source=builtin", async () => {
    await store.createSkill({
      name: "Builtin Skill",
      teamId: "system",
      systemPromptOverride: "",
      isBuiltin: true,
    });

    const result = await exportSkills(store, tmpDir);
    const parsed = await readYaml(result.exported[0]!);
    const validated = SkillStateConfigEntitySchema.parse(parsed);
    expect(validated.skills[0]!.source).toBe("builtin");
  });

  it("produces a valid generatedAt ISO timestamp", async () => {
    const result = await exportSkills(store, tmpDir);
    const parsed = await readYaml(result.exported[0]!) as Record<string, unknown>;
    expect(typeof parsed["generatedAt"]).toBe("string");
    expect(() => new Date(parsed["generatedAt"] as string)).not.toThrow();
  });

  it("sorts skills by id for deterministic order", async () => {
    await store.createSkill({ name: "Z Skill", teamId: "t", systemPromptOverride: "" });
    await store.createSkill({ name: "A Skill", teamId: "t", systemPromptOverride: "" });
    await store.createSkill({ name: "M Skill", teamId: "t", systemPromptOverride: "" });

    const result = await exportSkills(store, tmpDir);
    const parsed = await readYaml(result.exported[0]!) as Record<string, unknown>;
    const skills = (parsed as Record<string, Array<{ id: string }>>)["skills"] ?? [];
    const ids = skills.map((s) => s.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("skill list content is idempotent (excluding generatedAt snapshot timestamp)", async () => {
    await store.createSkill({ name: "Stable", teamId: "t", systemPromptOverride: "", version: "2.0.0" });

    const r1 = await exportSkills(store, tmpDir);
    const parsed1 = await readYaml(r1.exported[0]!) as Record<string, unknown>;

    const r2 = await exportSkills(store, tmpDir);
    const parsed2 = await readYaml(r2.exported[0]!) as Record<string, unknown>;

    // skills array should be identical
    expect(parsed1["skills"]).toEqual(parsed2["skills"]);
    expect(parsed1["kind"]).toBe(parsed2["kind"]);
    expect(parsed1["apiVersion"]).toBe(parsed2["apiVersion"]);
  });
});

// ─── connection-exporter tests ────────────────────────────────────────────────

describe("exportConnections", () => {
  let tmpDir: string;
  let store: MemStorage;

  beforeEach(async () => {
    tmpDir = await mkTempRepo();
    store = makeStorage();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("exports no files when no workspaces exist", async () => {
    const result = await exportConnections(store, tmpDir);
    expect(result.exported).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("exports a github connection to YAML (public config only)", async () => {
    const ws = await store.createWorkspace({ name: "prod-ws", type: "remote", path: "/prod" });
    await store.createWorkspaceConnection({
      workspaceId: ws.id,
      type: "github",
      name: "GitHub Main",
      config: { host: "https://api.github.com", org: "acme" },
    });

    const result = await exportConnections(store, tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.exported).toHaveLength(1);

    const parsed = await readYaml(result.exported[0]!);
    const validated = ConnectionConfigEntitySchema.parse(parsed);
    expect(validated.kind).toBe("connection");
    expect(validated.name).toBe("GitHub Main");
    expect(validated.type).toBe("github");
    // Config preserved
    expect((validated.config as Record<string, unknown>)["org"]).toBe("acme");
  });

  it("never includes secrets or hasSecrets flag in YAML", async () => {
    const ws = await store.createWorkspace({ name: "ws", type: "local", path: "/ws" });
    await store.createWorkspaceConnection({
      workspaceId: ws.id,
      type: "gitlab",
      name: "GitLab Private",
      config: { host: "https://gitlab.com" },
      secrets: { token: "super-secret-token" },
    });

    const result = await exportConnections(store, tmpDir);
    const content = await readFile(result.exported[0]!);
    expect(content).not.toContain("super-secret-token");
    expect(content).not.toContain("secretsEncrypted");
    expect(content).not.toContain("hasSecrets");
  });

  it("writes .has-secret marker when connection hasSecrets", async () => {
    const ws = await store.createWorkspace({ name: "ws2", type: "local", path: "/ws2" });
    await store.createWorkspaceConnection({
      workspaceId: ws.id,
      type: "aws",
      name: "AWS Prod",
      config: { region: "us-east-1" },
      secrets: { accessKey: "AKID", secretKey: "secret" },
    });

    const result = await exportConnections(store, tmpDir);
    expect(result.exported).toHaveLength(1);

    const slug = path.basename(result.exported[0]!, ".yaml");
    const markerPath = path.join(tmpDir, "connections", `${slug}.has-secret`);
    await expect(fs.access(markerPath)).resolves.toBeUndefined();
  });

  it("skips connections with unknown types", async () => {
    const ws = await store.createWorkspace({ name: "ws3", type: "local", path: "/ws3" });
    // Use a type not in the known list
    (store as unknown as {
      workspaceConnectionsMap: Map<string, import("@shared/types").WorkspaceConnection>
    }).workspaceConnectionsMap.set("custom-conn-id", {
      id: "custom-conn-id",
      workspaceId: ws.id,
      type: "unknown_type" as import("@shared/types").ConnectionType,
      name: "Custom Connection",
      config: {},
      hasSecrets: false,
      status: "active",
      lastTestedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: null,
    });

    const result = await exportConnections(store, tmpDir);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain("unknown_type");
  });
});

// ─── provider-key-exporter tests ──────────────────────────────────────────────

describe("exportProviderKeys", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkTempRepo();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("exports no files when no rows provided", async () => {
    const result = await exportProviderKeys([], tmpDir);
    expect(result.exported).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("exports a provider key reference YAML without key material", async () => {
    const rows = [
      {
        id: "pk-1",
        provider: "anthropic",
        apiKeyEncrypted: "ENCRYPTED_KEY_MATERIAL",
        createdAt: new Date("2025-01-01T00:00:00Z"),
        updatedAt: new Date("2025-06-01T00:00:00Z"),
      },
    ];

    const result = await exportProviderKeys(rows, tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.exported).toHaveLength(1);

    const parsed = await readYaml(result.exported[0]!);
    const validated = ProviderKeyConfigEntitySchema.parse(parsed);
    expect(validated.kind).toBe("provider-key");
    expect(validated.provider).toBe("anthropic");
    expect(validated.secretRef).toMatch(/^\${file:/);

    // SECURITY: no key material in the file
    const content = await readFile(result.exported[0]!);
    expect(content).not.toContain("ENCRYPTED_KEY_MATERIAL");
  });

  it("writes .has-secret marker for each exported provider key", async () => {
    const rows = [
      {
        id: "pk-2",
        provider: "openai",
        apiKeyEncrypted: "ENCRYPTED",
        createdAt: null,
        updatedAt: null,
      },
    ];

    await exportProviderKeys(rows, tmpDir);
    const markerPath = path.join(tmpDir, "provider-keys", "openai.has-secret");
    await expect(fs.access(markerPath)).resolves.toBeUndefined();
  });

  it("skips unknown provider names", async () => {
    const rows = [
      {
        id: "pk-unknown",
        provider: "unknown-provider",
        apiKeyEncrypted: "x",
        createdAt: null,
        updatedAt: null,
      },
    ];

    const result = await exportProviderKeys(rows, tmpDir);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain("unknown-provider");
  });

  it("exports multiple providers to separate files", async () => {
    const rows = [
      { id: "a", provider: "anthropic", apiKeyEncrypted: "enc1", createdAt: null, updatedAt: null },
      { id: "b", provider: "openai", apiKeyEncrypted: "enc2", createdAt: null, updatedAt: null },
    ];

    const result = await exportProviderKeys(rows, tmpDir);
    expect(result.exported).toHaveLength(2);
  });

  it("produces idempotent output for same provider key", async () => {
    const rows = [
      { id: "c", provider: "mistral", apiKeyEncrypted: "enc", createdAt: null, updatedAt: null },
    ];

    await exportProviderKeys(rows, tmpDir);
    const c1 = await readFile(path.join(tmpDir, "provider-keys", "mistral.yaml"));

    await exportProviderKeys(rows, tmpDir);
    const c2 = await readFile(path.join(tmpDir, "provider-keys", "mistral.yaml"));

    // YAML body should be identical (comment has no variable timestamp)
    expect(c1).toBe(c2);
  });
});

// ─── preferences-exporter tests ───────────────────────────────────────────────

describe("exportPreferences", () => {
  let tmpDir: string;
  let store: MemStorage;

  beforeEach(async () => {
    tmpDir = await mkTempRepo();
    store = makeStorage();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("always writes global.yaml even with no workspaces", async () => {
    const result = await exportPreferences(store, tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.exported.some((f) => f.endsWith("global.yaml"))).toBe(true);

    const globalPath = path.join(tmpDir, "preferences", "global.yaml");
    const parsed = await readYaml(globalPath);
    const validated = PreferencesConfigEntitySchema.parse(parsed);
    expect(validated.kind).toBe("preferences");
    expect(validated.scope).toBe("global");
  });

  it("exports workspace settings when present", async () => {
    const ws = await store.createWorkspace({ name: "my-workspace", type: "local", path: "/ws" });
    await store.upsertWorkspaceSettings(ws.id, {
      ui: { theme: "dark", layout: "compact", featureFlags: { betaFeature: true } },
    });

    const result = await exportPreferences(store, tmpDir);
    const wsFiles = result.exported.filter((f) => !f.endsWith("global.yaml"));
    expect(wsFiles).toHaveLength(1);

    const parsed = await readYaml(wsFiles[0]!);
    const validated = PreferencesConfigEntitySchema.parse(parsed);
    expect(validated.scope).toBe("user");
    expect(validated.ui.theme).toBe("dark");
    expect(validated.ui.layout).toBe("compact");
    expect(validated.ui.featureFlags["betaFeature"]).toBe(true);
  });

  it("coerces unknown theme to system default", async () => {
    const ws = await store.createWorkspace({ name: "ws-bad-theme", type: "local", path: "/x" });
    await store.upsertWorkspaceSettings(ws.id, { ui: { theme: "rainbow" } });

    const result = await exportPreferences(store, tmpDir);
    const wsFiles = result.exported.filter((f) => !f.endsWith("global.yaml"));
    const parsed = await readYaml(wsFiles[0]!);
    const validated = PreferencesConfigEntitySchema.parse(parsed);
    expect(validated.ui.theme).toBe("system");
  });

  it("skips workspaces with null settings", async () => {
    await store.createWorkspace({ name: "no-settings-ws", type: "local", path: "/y" });
    const result = await exportPreferences(store, tmpDir);
    // Only global.yaml should be written
    expect(result.exported).toHaveLength(1);
    expect(result.exported[0]).toMatch(/global\.yaml$/);
  });
});

// ─── export-orchestrator tests ────────────────────────────────────────────────

describe("runExport (orchestrator)", () => {
  let tmpDir: string;
  let store: MemStorage;

  beforeEach(async () => {
    tmpDir = await mkTempRepo();
    store = makeStorage();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("runs all exporters and returns a summary", async () => {
    const result = await runExport(store, tmpDir);
    expect(result.exportedAt).toBeTruthy();
    expect(result.repoPath).toBe(tmpDir);
    expect(result.exporters.map((e) => e.name)).toContain("pipelines");
    expect(result.exporters.map((e) => e.name)).toContain("triggers");
    expect(result.exporters.map((e) => e.name)).toContain("prompts");
    expect(result.exporters.map((e) => e.name)).toContain("skills");
    expect(result.exporters.map((e) => e.name)).toContain("connections");
    expect(result.exporters.map((e) => e.name)).toContain("provider-keys");
    expect(result.exporters.map((e) => e.name)).toContain("preferences");
  });

  it("aggregate summary counts match per-exporter data", async () => {
    await store.createPipeline({ name: "Pipeline 1", stages: [] });
    await store.createPipeline({ name: "Pipeline 2", stages: [] });

    const result = await runExport(store, tmpDir);
    const pipelineExp = result.exporters.find((e) => e.name === "pipelines")!;
    expect(pipelineExp.exported).toHaveLength(2);

    expect(result.summary.totalExported).toBe(
      result.exporters.reduce((s, e) => s + e.exported.length, 0),
    );
    expect(result.summary.totalErrors).toBe(
      result.exporters.reduce((s, e) => s + e.errors.length, 0),
    );
  });

  it("is idempotent: running export twice produces equivalent files (excluding snapshot timestamps)", async () => {
    await store.createPipeline({
      name: "Stable Pipeline",
      description: "stable",
      stages: [{ teamId: "t", modelSlug: "m", enabled: true }],
    });
    await store.createSkill({
      name: "Stable Skill",
      teamId: "t",
      systemPromptOverride: "stable prompt",
    });

    const r1 = await runExport(store, tmpDir);
    const filePaths1 = r1.exporters.flatMap((e) => e.exported);

    // Collect normalised file contents after first export
    const contents1 = new Map<string, string>();
    for (const fp of filePaths1) {
      contents1.set(fp, normaliseForIdempotency(await readFile(fp)));
    }

    const r2 = await runExport(store, tmpDir);
    const filePaths2 = r2.exporters.flatMap((e) => e.exported);

    for (const fp of filePaths2) {
      const c2 = normaliseForIdempotency(await readFile(fp));
      const c1 = contents1.get(fp);
      if (c1 !== undefined) {
        expect(c2).toBe(c1);
      }
    }
  });

  it("continues exporting other types when one exporter has per-entity errors", async () => {
    // Create a pipeline with an invalid stage (will fail Zod validation but pipeline
    // creation succeeds because MemStorage doesn't validate)
    await store.createPipeline({
      name: "", // empty name — will fail PipelineConfigEntitySchema
      stages: [],
    });
    await store.createPipeline({ name: "Valid Pipeline", stages: [] });

    const result = await runExport(store, tmpDir);
    const pipelineExp = result.exporters.find((e) => e.name === "pipelines")!;
    // One error, one success
    expect(pipelineExp.errors).toHaveLength(1);
    expect(pipelineExp.exported).toHaveLength(1);
    // Other exporters still ran
    expect(result.exporters.find((e) => e.name === "preferences")!.exported).toHaveLength(1);
  });

  it("uses providerKeyRows option when provided", async () => {
    const rows = [
      { id: "pk", provider: "groq", apiKeyEncrypted: "enc", createdAt: null, updatedAt: null },
    ];

    const result = await runExport(store, tmpDir, { providerKeyRows: rows });
    const pkExp = result.exporters.find((e) => e.name === "provider-keys")!;
    expect(pkExp.exported).toHaveLength(1);
    expect(pkExp.exported[0]).toMatch(/groq\.yaml$/);
  });

  it("schema compliance: all exported YAML files parse against their schema", async () => {
    await store.createPipeline({
      name: "Schema Check Pipeline",
      stages: [{ teamId: "team", modelSlug: "model", enabled: true }],
    });
    const pipeline = (await store.getPipelines())[0]!;
    await store.createTrigger({
      pipelineId: pipeline.id,
      type: "schedule",
      config: { type: "schedule", cron: "0 0 * * *" } as unknown as import("@shared/types").TriggerConfig,
      enabled: true,
    });
    await store.createSkill({
      name: "Schema Skill",
      teamId: "t",
      systemPromptOverride: "prompt",
    });
    const ws = await store.createWorkspace({ name: "schema-ws", type: "local", path: "/s" });
    await store.createWorkspaceConnection({
      workspaceId: ws.id,
      type: "kubernetes",
      name: "K8s Cluster",
      config: { server: "https://k8s.example.com" },
    });
    await store.upsertWorkspaceSettings(ws.id, { ui: { theme: "light" } });

    const result = await runExport(store, tmpDir);
    expect(result.summary.totalErrors).toBe(0);

    // Validate every exported YAML against the appropriate schema
    for (const exp of result.exporters) {
      for (const filePath of exp.exported) {
        const parsed = await readYaml(filePath);
        const kind = (parsed as Record<string, unknown>)["kind"];

        let schema;
        switch (kind) {
          case "pipeline":    schema = PipelineConfigEntitySchema; break;
          case "trigger":     schema = TriggerConfigEntitySchema; break;
          case "prompt":      schema = PromptConfigEntitySchema; break;
          case "skill-state": schema = SkillStateConfigEntitySchema; break;
          case "connection":  schema = ConnectionConfigEntitySchema; break;
          case "provider-key": schema = ProviderKeyConfigEntitySchema; break;
          case "preferences": schema = PreferencesConfigEntitySchema; break;
          default: continue;
        }
        expect(() => schema.parse(parsed)).not.toThrow();
      }
    }
  });
});
