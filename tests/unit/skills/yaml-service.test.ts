import { describe, it, expect } from "vitest";
import {
  serializeSkillToYaml,
  deserializeSkillYaml,
  SkillYamlSchema,
} from "../../../server/skills/yaml-service";
import type { Skill } from "@shared/schema";

describe("SkillYamlService", () => {
  const sampleSkill: Skill = {
    id: "skill-1",
    name: "Code Review",
    description: "Reviews code for quality",
    teamId: "code_review",
    systemPromptOverride: "You are an expert code reviewer.",
    tools: ["web_search"] as unknown as string[],
    modelPreference: null,
    outputSchema: null,
    tags: ["security", "quality"] as unknown as string[],
    isBuiltin: false,
    isPublic: true,
    createdBy: "user-1",
    version: "1.2.0",
    sharing: "public",
    usageCount: 10,
    forkedFrom: null,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-06-01"),
  };

  describe("serializeSkillToYaml", () => {
    it("should produce valid YAML with apiVersion and kind", () => {
      const yaml = serializeSkillToYaml(sampleSkill);
      expect(yaml).toContain("apiVersion: multiqlti/v1");
      expect(yaml).toContain("kind: Skill");
    });

    it("should include metadata fields", () => {
      const yaml = serializeSkillToYaml(sampleSkill);
      expect(yaml).toContain("name: Code Review");
      expect(yaml).toMatch(/version:.*1.2.0/);
      expect(yaml).toContain("author: user-1");
    });

    it("should include spec fields", () => {
      const yaml = serializeSkillToYaml(sampleSkill);
      expect(yaml).toContain("teamId: code_review");
      expect(yaml).toContain("systemPrompt: You are an expert code reviewer.");
      expect(yaml).toContain("sharing: public");
    });

    it("should include tags as array", () => {
      const yaml = serializeSkillToYaml(sampleSkill);
      expect(yaml).toContain("- security");
      expect(yaml).toContain("- quality");
    });

    it("should round-trip through deserialize", () => {
      const yaml = serializeSkillToYaml(sampleSkill);
      const parsed = deserializeSkillYaml(yaml);
      expect(parsed.metadata.name).toBe("Code Review");
      expect(parsed.spec.teamId).toBe("code_review");
      expect(parsed.spec.tools).toEqual(["web_search"]);
    });
  });

  describe("deserializeSkillYaml", () => {
    const validYaml = `
apiVersion: multiqlti/v1
kind: Skill
metadata:
  name: Test Skill
  version: "1.0.0"
  author: tester
  tags:
    - test
  description: A test skill
spec:
  teamId: testing
  systemPrompt: You are a test helper.
  tools:
    - knowledge_search
  modelPreference: null
  outputSchema: null
  sharing: private
`;

    it("should parse valid YAML", () => {
      const result = deserializeSkillYaml(validYaml);
      expect(result.apiVersion).toBe("multiqlti/v1");
      expect(result.kind).toBe("Skill");
      expect(result.metadata.name).toBe("Test Skill");
      expect(result.metadata.version).toBe("1.0.0");
      expect(result.spec.teamId).toBe("testing");
      expect(result.spec.sharing).toBe("private");
    });

    it("should apply defaults for optional fields", () => {
      const minimalYaml = `
apiVersion: multiqlti/v1
kind: Skill
metadata:
  name: Minimal
  version: "1.0.0"
spec:
  teamId: dev
`;
      const result = deserializeSkillYaml(minimalYaml);
      expect(result.metadata.tags).toEqual([]);
      expect(result.metadata.description).toBe("");
      expect(result.spec.tools).toEqual([]);
      expect(result.spec.modelPreference).toBeNull();
      expect(result.spec.sharing).toBe("private");
    });

    it("should reject invalid apiVersion", () => {
      const badYaml = `
apiVersion: other/v2
kind: Skill
metadata:
  name: Bad
  version: "1.0.0"
spec:
  teamId: dev
`;
      expect(() => deserializeSkillYaml(badYaml)).toThrow();
    });

    it("should reject invalid version format", () => {
      const badYaml = `
apiVersion: multiqlti/v1
kind: Skill
metadata:
  name: Bad Version
  version: "v1.0"
spec:
  teamId: dev
`;
      expect(() => deserializeSkillYaml(badYaml)).toThrow();
    });

    it("should reject missing required fields", () => {
      const badYaml = `
apiVersion: multiqlti/v1
kind: Skill
metadata:
  version: "1.0.0"
spec:
  teamId: dev
`;
      expect(() => deserializeSkillYaml(badYaml)).toThrow();
    });

    it("should reject name exceeding max length", () => {
      const longName = "A".repeat(201);
      const badYaml = `
apiVersion: multiqlti/v1
kind: Skill
metadata:
  name: "${longName}"
  version: "1.0.0"
spec:
  teamId: dev
`;
      expect(() => deserializeSkillYaml(badYaml)).toThrow();
    });
  });

  describe("SkillYamlSchema", () => {
    it("should validate a complete valid object", () => {
      const valid = {
        apiVersion: "multiqlti/v1",
        kind: "Skill",
        metadata: {
          name: "Valid Skill",
          version: "2.1.0",
          author: "author",
          tags: ["tag1"],
          description: "desc",
        },
        spec: {
          teamId: "team1",
          systemPrompt: "prompt",
          tools: ["tool1"],
          modelPreference: "model-1",
          outputSchema: { type: "object" },
          sharing: "public",
        },
      };
      const result = SkillYamlSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it("should reject too many tags", () => {
      const tooManyTags = {
        apiVersion: "multiqlti/v1",
        kind: "Skill",
        metadata: {
          name: "Many Tags",
          version: "1.0.0",
          tags: Array.from({ length: 21 }, (_, i) => `tag${i}`),
        },
        spec: { teamId: "team1" },
      };
      const result = SkillYamlSchema.safeParse(tooManyTags);
      expect(result.success).toBe(false);
    });

    it("should not process dangerous YAML tags", () => {
      // js-yaml v4 safe schema by default rejects !!js/function
      const dangerousYaml = `
apiVersion: multiqlti/v1
kind: Skill
metadata:
  name: !!js/function "function() { return 'hacked'; }"
  version: "1.0.0"
spec:
  teamId: dev
`;
      // js-yaml v4 should throw on unknown tags
      expect(() => deserializeSkillYaml(dangerousYaml)).toThrow();
    });
  });
});
