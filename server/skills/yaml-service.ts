import yaml from "js-yaml";
import { z } from "zod";
import type { Skill } from "@shared/schema";
import type { SkillYaml, SharingLevel } from "@shared/types";

/**
 * Zod schema for validating imported YAML/JSON skill definitions.
 * Bounds all string fields to prevent storage abuse.
 */
export const SkillYamlSchema = z.object({
  apiVersion: z.literal("multiqlti/v1"),
  kind: z.literal("Skill"),
  metadata: z.object({
    name: z.string().min(1).max(200),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "Must be semver x.y.z"),
    author: z.string().max(200).default(""),
    tags: z.array(z.string().max(100)).max(20).default([]),
    description: z.string().max(1000).default(""),
  }),
  spec: z.object({
    teamId: z.string().min(1).max(100),
    systemPrompt: z.string().max(8000).default(""),
    tools: z.array(z.string().max(100)).max(20).default([]),
    modelPreference: z.string().max(100).nullable().default(null),
    outputSchema: z.record(z.unknown()).nullable().default(null),
    sharing: z.enum(["private", "team", "public"]).default("private"),
  }),
});

/**
 * Serializes a Skill row into YAML format following the multiqlti/v1 schema.
 */
export function serializeSkillToYaml(skill: Skill): string {
  const doc: SkillYaml = {
    apiVersion: "multiqlti/v1",
    kind: "Skill",
    metadata: {
      name: skill.name,
      version: (skill as Skill & { version?: string }).version ?? "1.0.0",
      author: skill.createdBy,
      tags: skill.tags as string[],
      description: skill.description,
    },
    spec: {
      teamId: skill.teamId,
      systemPrompt: skill.systemPromptOverride,
      tools: skill.tools as string[],
      modelPreference: skill.modelPreference,
      outputSchema: skill.outputSchema as Record<string, unknown> | null,
      sharing: ((skill as Skill & { sharing?: string }).sharing ?? "public") as SharingLevel,
    },
  };
  return yaml.dump(doc, { lineWidth: 120, noRefs: true });
}

/**
 * Deserializes a YAML string and validates it against SkillYamlSchema.
 * Uses js-yaml v4 default safe schema (no arbitrary JS execution).
 */
export function deserializeSkillYaml(input: string): SkillYaml {
  // yaml.load() in js-yaml v4 uses DEFAULT_SCHEMA which is safe by default.
  // It does NOT process !!js/function or other dangerous tags.
  const raw = yaml.load(input);
  return SkillYamlSchema.parse(raw);
}
