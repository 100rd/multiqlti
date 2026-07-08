/**
 * Unit tests for server/skills/skill-md-service.ts (issue #446, task 52.1).
 *
 * Fixtures live under tests/fixtures/skill-md/.
 */
import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import path from "path";
import { parseSkillMd, SkillMdParseError, SKILL_MD_MAX_BYTES } from "../../../server/skills/skill-md-service.js";

const FIXTURES_DIR = path.join(__dirname, "..", "..", "fixtures", "skill-md");

async function readFixture(name: string): Promise<string> {
  return fs.readFile(path.join(FIXTURES_DIR, name), "utf8");
}

describe("parseSkillMd", () => {
  describe("valid variants", () => {
    it("parses full frontmatter and the markdown body", async () => {
      const content = await readFixture("valid-full.md");
      const parsed = parseSkillMd(content);

      expect(parsed.frontmatter.name).toBe("demo-skill");
      expect(parsed.frontmatter.description).toBe("A demo skill used for parser unit tests.");
      expect(parsed.frontmatter.version).toBe("1.0.0");
      expect(parsed.frontmatter.tags).toEqual(["demo", "testing"]);
      expect(parsed.frontmatter.compatible_tools).toEqual(["multiqlti", "claude-code"]);
      expect(parsed.frontmatter.tier).toBe("T1");
      expect(parsed.frontmatter.license).toBe("MIT");
      expect(parsed.body).toContain("Demo Skill");
      expect(parsed.body).toContain("This is the markdown body used as systemPromptOverride.");
    });

    it("applies schema defaults when optional frontmatter fields are omitted", async () => {
      const content = await readFixture("valid-minimal.md");
      const parsed = parseSkillMd(content);

      expect(parsed.frontmatter.name).toBe("minimal-skill");
      expect(parsed.frontmatter.version).toBe("0.1.0");
      expect(parsed.frontmatter.description).toBe("");
      expect(parsed.frontmatter.tags).toEqual([]);
      expect(parsed.frontmatter.compatible_tools).toEqual([]);
      expect(parsed.frontmatter.tier).toBe("");
      expect(parsed.frontmatter.license).toBe("");
      expect(parsed.body).toBe("Minimal body.");
    });

    it("parses a skill whose compatible_tools omits multiqlti (parser does not filter)", async () => {
      const content = await readFixture("no-multiqlti.md");
      const parsed = parseSkillMd(content);

      expect(parsed.frontmatter.name).toBe("other-tool-skill");
      expect(parsed.frontmatter.compatible_tools).toEqual(["claude-code", "cursor"]);
      expect(parsed.frontmatter.compatible_tools).not.toContain("multiqlti");
    });
  });

  describe("malformed input", () => {
    it("throws SkillMdParseError on invalid frontmatter YAML", async () => {
      const content = await readFixture("malformed-yaml.md");
      expect(() => parseSkillMd(content)).toThrow(SkillMdParseError);
    });

    it("throws SkillMdParseError when frontmatter delimiters are missing", async () => {
      const content = await readFixture("missing-frontmatter.md");
      expect(() => parseSkillMd(content)).toThrow(SkillMdParseError);
      expect(() => parseSkillMd(content)).toThrow(/frontmatter/i);
    });

    it("throws SkillMdParseError with no input at all", () => {
      expect(() => parseSkillMd("")).toThrow(SkillMdParseError);
    });
  });

  describe("oversized fields", () => {
    it("throws SkillMdParseError when name exceeds the 200-char limit", async () => {
      const content = await readFixture("oversized-name.md");
      expect(() => parseSkillMd(content)).toThrow(SkillMdParseError);
      expect(() => parseSkillMd(content)).toThrow(/name/);
    });

    it("throws SkillMdParseError when the whole file exceeds SKILL_MD_MAX_BYTES", () => {
      const oversizedBody = "x".repeat(SKILL_MD_MAX_BYTES + 1);
      const content = `---\nname: too-big\nversion: 1.0.0\n---\n${oversizedBody}`;
      expect(() => parseSkillMd(content)).toThrow(SkillMdParseError);
      expect(() => parseSkillMd(content)).toThrow(/exceeds maximum size/);
    });

    it("throws SkillMdParseError when tags exceeds the 20-item limit", () => {
      const tooManyTags = Array.from({ length: 21 }, (_, i) => `tag${i}`).join(", ");
      const content = `---\nname: too-many-tags\nversion: 1.0.0\ntags: [${tooManyTags}]\n---\nBody.`;
      expect(() => parseSkillMd(content)).toThrow(SkillMdParseError);
    });

    it("throws SkillMdParseError when version is not semver", () => {
      const content = `---\nname: bad-version\nversion: not-a-version\n---\nBody.`;
      expect(() => parseSkillMd(content)).toThrow(SkillMdParseError);
      expect(() => parseSkillMd(content)).toThrow(/semver/);
    });
  });
});
