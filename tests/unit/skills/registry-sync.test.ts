/**
 * Unit tests for server/skills/registry-sync.ts (issue #446, task 52.1).
 *
 * Fixture registry root: tests/fixtures/registry-sync/ — a mini "repo" with
 * skills-lock.json + three SKILL.md files:
 *   - demo-skill:        valid, compatible_tools includes "multiqlti" -> synced
 *   - other-tool-skill:  valid, compatible_tools omits "multiqlti"    -> skipped
 *   - drifted-skill:     lock's computedHash intentionally wrong      -> drift
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { MemStorage } from "../../../server/storage.js";
import { syncSkillsRegistry } from "../../../server/skills/registry-sync.js";

const FIXTURE_ROOT = path.join(__dirname, "..", "..", "fixtures", "registry-sync");

async function realpathRoot(): Promise<string> {
  return fs.realpath(FIXTURE_ROOT);
}

describe("syncSkillsRegistry", () => {
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
  });

  it("syncs a compatible skill as a read-only git-sourced row", async () => {
    const root = await realpathRoot();
    const result = await syncSkillsRegistry({
      storage,
      registryRoot: root,
      teamId: "team-a",
      allowedRoots: [root],
    });

    const demo = result.results.find((r) => r.skillKey === "demo-skill");
    expect(demo?.status).toBe("synced");
    expect(demo?.skillId).toBeTruthy();

    const skill = await storage.getSkill(demo!.skillId!);
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("demo-skill");
    expect(skill!.sourceType).toBe("git");
    expect(skill!.teamId).toBe("team-a");
    expect(skill!.externalSource).toBe("test-org/test-registry");
    expect(skill!.externalId).toBe("skills/demo-skill/SKILL.md");
    expect(skill!.systemPromptOverride).toContain("This is the markdown body used as systemPromptOverride.");
  });

  it("skips a skill whose compatible_tools omits multiqlti, without creating a row", async () => {
    const root = await realpathRoot();
    const result = await syncSkillsRegistry({
      storage,
      registryRoot: root,
      teamId: "team-a",
      allowedRoots: [root],
    });

    const skipped = result.results.find((r) => r.skillKey === "other-tool-skill");
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.reason).toMatch(/multiqlti/);

    const existingId = await storage.getSkillIdByName("other-tool-skill");
    expect(existingId).toBeNull();
  });

  it("reports drift and does NOT create/update a row when sha256 mismatches the lock", async () => {
    const root = await realpathRoot();
    const result = await syncSkillsRegistry({
      storage,
      registryRoot: root,
      teamId: "team-a",
      allowedRoots: [root],
    });

    const drift = result.results.find((r) => r.skillKey === "drifted-skill");
    expect(drift?.status).toBe("drift");
    expect(drift?.reason).toMatch(/sha256 mismatch/);

    const existingId = await storage.getSkillIdByName("drifted-skill");
    expect(existingId).toBeNull();
  });

  it("is idempotent: re-running sync updates the same row instead of duplicating it", async () => {
    const root = await realpathRoot();
    const first = await syncSkillsRegistry({
      storage,
      registryRoot: root,
      teamId: "team-a",
      allowedRoots: [root],
    });
    const firstId = first.results.find((r) => r.skillKey === "demo-skill")?.skillId;
    expect(firstId).toBeTruthy();

    const second = await syncSkillsRegistry({
      storage,
      registryRoot: root,
      teamId: "team-a",
      allowedRoots: [root],
    });
    const secondId = second.results.find((r) => r.skillKey === "demo-skill")?.skillId;

    expect(secondId).toBe(firstId);

    const all = await storage.getSkills({ teamId: "team-a" });
    const demoRows = all.filter((s) => s.name === "demo-skill");
    expect(demoRows).toHaveLength(1);
  });

  it("refuses to overwrite an existing MANUAL skill with the same name (reports conflict, no write)", async () => {
    const root = await realpathRoot();

    const manual = await storage.createSkill({
      name: "demo-skill",
      teamId: "team-a",
      systemPromptOverride: "hand-written by a human, never touch me",
      tags: [],
      isBuiltin: false,
      isPublic: true,
      createdBy: "human",
      version: "9.9.9",
      sharing: "private",
    });

    const result = await syncSkillsRegistry({
      storage,
      registryRoot: root,
      teamId: "team-a",
      allowedRoots: [root],
    });

    const demo = result.results.find((r) => r.skillKey === "demo-skill");
    expect(demo?.status).toBe("conflict");
    expect(demo?.existingSourceType).toBe("manual");
    expect(demo?.reason).toMatch(/[Nn]ame collision/);
    expect(demo?.reason).toMatch(/manually-created/);

    const untouched = await storage.getSkill(manual.id);
    expect(untouched?.systemPromptOverride).toBe("hand-written by a human, never touch me");
    expect(untouched?.sourceType).toBe("manual");
  });

  it("refuses to overwrite an existing BUILT-IN skill with the same name (reports conflict, no write, no immutability flip)", async () => {
    const root = await realpathRoot();

    const builtin = await storage.createSkill({
      name: "demo-skill",
      teamId: "team-a",
      systemPromptOverride: "built-in, protected content",
      tags: [],
      isBuiltin: true,
      isPublic: true,
      createdBy: "system",
      version: "1.0.0",
      sharing: "public",
    });

    const result = await syncSkillsRegistry({
      storage,
      registryRoot: root,
      teamId: "team-a",
      allowedRoots: [root],
    });

    const demo = result.results.find((r) => r.skillKey === "demo-skill");
    expect(demo?.status).toBe("conflict");
    expect(demo?.reason).toMatch(/built-in/);

    const untouched = await storage.getSkill(builtin.id);
    expect(untouched?.systemPromptOverride).toBe("built-in, protected content");
    expect(untouched?.sourceType).toBe("manual");
    expect(untouched?.isBuiltin).toBe(true);
  });

  it("fail-closed: throws when registryRoot resolves outside the allowlist", async () => {
    const root = await realpathRoot();
    const outsideAllowlist = ["/tmp/some-other-unrelated-root"];

    await expect(
      syncSkillsRegistry({
        storage,
        registryRoot: root,
        teamId: "team-a",
        allowedRoots: outsideAllowlist,
      }),
    ).rejects.toThrow(/outside every allowed repo root/);
  });

  it("throws when the lock file cannot be found", async () => {
    const root = await realpathRoot();
    await expect(
      syncSkillsRegistry({
        storage,
        registryRoot: root,
        teamId: "team-a",
        allowedRoots: [root],
        lockFileName: "does-not-exist.json",
      }),
    ).rejects.toThrow(/Unable to read lock file/);
  });
});
