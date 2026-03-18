import type { Skill } from "@shared/schema";
import type { SkillVersionConfig } from "@shared/types";

export type VersionBump = "major" | "minor" | "patch";

/**
 * Pure semver bump logic for skill versioning.
 */
export function bumpVersion(current: string, bump: VersionBump): string {
  const parts = current.split(".").map(Number);
  const major = parts[0] ?? 1;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;

  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

/**
 * Extracts the versionable fields from a Skill row into a SkillVersionConfig.
 */
export function snapshotConfig(skill: Skill): SkillVersionConfig {
  return {
    name: skill.name,
    description: skill.description,
    teamId: skill.teamId,
    systemPromptOverride: skill.systemPromptOverride,
    tools: skill.tools as string[],
    modelPreference: skill.modelPreference,
    outputSchema: skill.outputSchema as Record<string, unknown> | null,
    tags: skill.tags as string[],
  };
}
