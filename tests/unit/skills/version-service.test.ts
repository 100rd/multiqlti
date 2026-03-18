import { describe, it, expect } from "vitest";
import { bumpVersion, snapshotConfig } from "../../../server/skills/version-service";
import type { Skill } from "@shared/schema";

describe("SkillVersionService", () => {
  describe("bumpVersion", () => {
    it("should bump patch version", () => {
      expect(bumpVersion("1.0.0", "patch")).toBe("1.0.1");
    });

    it("should bump minor version and reset patch", () => {
      expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
    });

    it("should bump major version and reset minor/patch", () => {
      expect(bumpVersion("2.5.9", "major")).toBe("3.0.0");
    });

    it("should handle 0.x versions", () => {
      expect(bumpVersion("0.1.0", "patch")).toBe("0.1.1");
      expect(bumpVersion("0.1.0", "minor")).toBe("0.2.0");
      expect(bumpVersion("0.1.0", "major")).toBe("1.0.0");
    });

    it("should handle double-digit versions", () => {
      expect(bumpVersion("10.20.30", "patch")).toBe("10.20.31");
    });

    it("should handle version starting at 1.0.0", () => {
      expect(bumpVersion("1.0.0", "major")).toBe("2.0.0");
    });
  });

  describe("snapshotConfig", () => {
    const baseskill: Skill = {
      id: "skill-1",
      name: "Test Skill",
      description: "A test skill",
      teamId: "dev-team",
      systemPromptOverride: "You are helpful",
      tools: ["web_search"] as unknown as string[],
      modelPreference: "gpt-4",
      outputSchema: { type: "object" } as Record<string, unknown>,
      tags: ["test", "dev"] as unknown as string[],
      isBuiltin: false,
      isPublic: true,
      createdBy: "user-1",
      version: "1.2.0",
      sharing: "public",
      usageCount: 5,
      forkedFrom: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("should extract versionable fields from a skill", () => {
      const config = snapshotConfig(baseskill);

      expect(config.name).toBe("Test Skill");
      expect(config.description).toBe("A test skill");
      expect(config.teamId).toBe("dev-team");
      expect(config.systemPromptOverride).toBe("You are helpful");
      expect(config.tools).toEqual(["web_search"]);
      expect(config.modelPreference).toBe("gpt-4");
      expect(config.outputSchema).toEqual({ type: "object" });
      expect(config.tags).toEqual(["test", "dev"]);
    });

    it("should not include non-versionable fields", () => {
      const config = snapshotConfig(baseskill);
      const configKeys = Object.keys(config);

      expect(configKeys).not.toContain("id");
      expect(configKeys).not.toContain("isBuiltin");
      expect(configKeys).not.toContain("isPublic");
      expect(configKeys).not.toContain("createdBy");
      expect(configKeys).not.toContain("createdAt");
      expect(configKeys).not.toContain("version");
      expect(configKeys).not.toContain("sharing");
      expect(configKeys).not.toContain("usageCount");
    });

    it("should handle null modelPreference", () => {
      const skill = { ...baseskill, modelPreference: null };
      const config = snapshotConfig(skill);
      expect(config.modelPreference).toBeNull();
    });

    it("should handle null outputSchema", () => {
      const skill = { ...baseskill, outputSchema: null };
      const config = snapshotConfig(skill);
      expect(config.outputSchema).toBeNull();
    });
  });
});
