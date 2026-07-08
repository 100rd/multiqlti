/**
 * skill-md-service.ts — Parser for git-backed `SKILL.md` files (issue #446).
 *
 * Format: YAML frontmatter (delimited by `---` lines) followed by a Markdown
 * body. The frontmatter carries skill metadata; the body becomes the skill's
 * `systemPromptOverride`.
 *
 * Security: frontmatter YAML is parsed with js-yaml's DEFAULT_SCHEMA (the
 * default for `yaml.load()` in js-yaml v4), which does not process
 * `!!js/function` or other unsafe tags. All string fields are length-bounded
 * via Zod, mirroring the limits already enforced in `yaml-service.ts` for
 * manually-imported skills.
 */
import yaml from "js-yaml";
import { z } from "zod";

/** Matches a leading `---\n...\n---` frontmatter block, capturing body separately. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export const SkillMdFrontmatterSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).default(""),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver x.y.z"),
  tags: z.array(z.string().max(100)).max(20).default([]),
  compatible_tools: z.array(z.string().max(100)).max(20).default([]),
  tier: z.string().max(20).default(""),
  license: z.string().max(100).default(""),
});

export type SkillMdFrontmatter = z.infer<typeof SkillMdFrontmatterSchema>;

export interface ParsedSkillMd {
  frontmatter: SkillMdFrontmatter;
  /** Markdown body (trimmed) — becomes the skill's systemPromptOverride. */
  body: string;
}

/** Maximum SKILL.md file size accepted by the parser (256KB). */
export const SKILL_MD_MAX_BYTES = 256 * 1024;

export class SkillMdParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillMdParseError";
  }
}

/**
 * Parses a raw SKILL.md file's text content into frontmatter + body.
 * Throws SkillMdParseError on any malformed input (missing delimiters,
 * invalid YAML, or frontmatter failing schema validation).
 */
export function parseSkillMd(content: string): ParsedSkillMd {
  if (Buffer.byteLength(content, "utf8") > SKILL_MD_MAX_BYTES) {
    throw new SkillMdParseError(
      `SKILL.md exceeds maximum size of ${SKILL_MD_MAX_BYTES} bytes`,
    );
  }

  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    throw new SkillMdParseError("SKILL.md is missing a valid '---' YAML frontmatter block");
  }

  const [, frontmatterRaw, bodyRaw] = match;

  let rawYaml: unknown;
  try {
    // js-yaml v4 `load()` uses DEFAULT_SCHEMA (safe — no arbitrary JS execution).
    rawYaml = yaml.load(frontmatterRaw ?? "");
  } catch (err) {
    throw new SkillMdParseError(
      `SKILL.md frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = SkillMdFrontmatterSchema.safeParse(rawYaml);
  if (!parsed.success) {
    const issue = parsed.error.errors[0];
    throw new SkillMdParseError(
      `SKILL.md frontmatter failed validation: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid"}`,
    );
  }

  return {
    frontmatter: parsed.data,
    body: (bodyRaw ?? "").trim(),
  };
}
