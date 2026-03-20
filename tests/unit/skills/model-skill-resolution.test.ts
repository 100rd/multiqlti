/**
 * Unit tests for per-model skill resolution logic.
 *
 * Verifies:
 * - Model-specific bindings are returned when present
 * - Global fallback (empty array) when no bindings exist for a model
 * - MemStorage correctly enforces unique constraint
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../../../server/storage.js";
import type { InsertSkill } from "../../../shared/schema.js";

function makeSkill(name: string): InsertSkill {
  return {
    id: undefined as unknown as string,
    name,
    description: `${name} description`,
    teamId: "development",
    systemPromptOverride: `You are ${name}.`,
    tools: [],
    modelPreference: null,
    outputSchema: null,
    tags: [name.toLowerCase()],
    isBuiltin: false,
    isPublic: true,
    createdBy: "user-1",
    version: "1.0.0",
    sharing: "public",
  };
}

describe("model skill resolution — MemStorage", () => {
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
  });

  it("returns empty array when no bindings exist for a model", async () => {
    const skills = await storage.resolveSkillsForModel("claude-sonnet-4-5");
    expect(skills).toEqual([]);
  });

  it("returns bound skills after binding", async () => {
    const skill = await storage.createSkill(makeSkill("Coder"));
    await storage.createModelSkillBinding({
      modelId: "claude-sonnet-4-5",
      skillId: skill.id,
      createdBy: "user-1",
    });

    const resolved = await storage.resolveSkillsForModel("claude-sonnet-4-5");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("Coder");
  });

  it("returns only skills for the specified model, not others", async () => {
    const skillA = await storage.createSkill(makeSkill("SkillA"));
    const skillB = await storage.createSkill(makeSkill("SkillB"));

    await storage.createModelSkillBinding({
      modelId: "claude-sonnet-4-5",
      skillId: skillA.id,
      createdBy: "user-1",
    });
    await storage.createModelSkillBinding({
      modelId: "grok-3",
      skillId: skillB.id,
      createdBy: "user-1",
    });

    const forClaude = await storage.resolveSkillsForModel("claude-sonnet-4-5");
    const forGrok = await storage.resolveSkillsForModel("grok-3");

    expect(forClaude).toHaveLength(1);
    expect(forClaude[0].name).toBe("SkillA");

    expect(forGrok).toHaveLength(1);
    expect(forGrok[0].name).toBe("SkillB");
  });

  it("returns multiple skills bound to same model", async () => {
    const skillA = await storage.createSkill(makeSkill("Alpha"));
    const skillB = await storage.createSkill(makeSkill("Beta"));

    await storage.createModelSkillBinding({ modelId: "gemini-2.0-flash", skillId: skillA.id, createdBy: null });
    await storage.createModelSkillBinding({ modelId: "gemini-2.0-flash", skillId: skillB.id, createdBy: null });

    const resolved = await storage.resolveSkillsForModel("gemini-2.0-flash");
    expect(resolved).toHaveLength(2);
    const names = resolved.map((s) => s.name).sort();
    expect(names).toEqual(["Alpha", "Beta"]);
  });

  it("throws on duplicate binding (unique constraint)", async () => {
    const skill = await storage.createSkill(makeSkill("Dup"));
    await storage.createModelSkillBinding({ modelId: "grok-3", skillId: skill.id, createdBy: null });

    await expect(
      storage.createModelSkillBinding({ modelId: "grok-3", skillId: skill.id, createdBy: null }),
    ).rejects.toThrow(/unique/i);
  });

  it("removes binding on delete", async () => {
    const skill = await storage.createSkill(makeSkill("Removable"));
    await storage.createModelSkillBinding({ modelId: "claude-sonnet-4-5", skillId: skill.id, createdBy: null });

    await storage.deleteModelSkillBinding("claude-sonnet-4-5", skill.id);
    const resolved = await storage.resolveSkillsForModel("claude-sonnet-4-5");
    expect(resolved).toHaveLength(0);
  });

  it("getModelsWithSkillBindings returns distinct model IDs", async () => {
    const s1 = await storage.createSkill(makeSkill("S1"));
    const s2 = await storage.createSkill(makeSkill("S2"));

    await storage.createModelSkillBinding({ modelId: "grok-3", skillId: s1.id, createdBy: null });
    await storage.createModelSkillBinding({ modelId: "claude-sonnet-4-5", skillId: s2.id, createdBy: null });

    const modelIds = await storage.getModelsWithSkillBindings();
    expect(modelIds).toContain("grok-3");
    expect(modelIds).toContain("claude-sonnet-4-5");
    expect(new Set(modelIds).size).toBe(modelIds.length); // no duplicates
  });

  it("global fallback: resolveSkillsForModel returns empty for unbound model", async () => {
    const skill = await storage.createSkill(makeSkill("Bound"));
    await storage.createModelSkillBinding({ modelId: "grok-3", skillId: skill.id, createdBy: null });

    // Different model — should return empty (global fallback is caller's responsibility)
    const unbound = await storage.resolveSkillsForModel("gemini-2.0-flash");
    expect(unbound).toHaveLength(0);
  });
});
