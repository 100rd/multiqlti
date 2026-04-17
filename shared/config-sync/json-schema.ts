/**
 * JSON Schema export for config-sync entities (issue #313)
 *
 * Generates JSON Schema 7 documents from the Zod schemas so that
 * YAML Language Server (yaml-language-server) and other JSON Schema-aware
 * tooling can provide IDE completion and validation for config-sync files.
 *
 * Each schema carries an `$id` and a `$schema` declaration for portability.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import {
  PipelineConfigEntitySchema,
  TriggerConfigEntitySchema,
  PromptConfigEntitySchema,
  SkillStateConfigEntitySchema,
  ConnectionConfigEntitySchema,
  ProviderKeyConfigEntitySchema,
  PreferencesConfigEntitySchema,
  ConfigEntitySchema,
} from "./schemas.js";

/** Base URI used as the `$id` namespace for all generated schemas. */
const BASE_URI = "https://multiqlti.io/config-sync/schemas";

/** Options shared by every zodToJsonSchema call. */
const BASE_OPTIONS = {
  target: "jsonSchema7" as const,
  strictUnions: true,
};

export function generatePipelineJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(PipelineConfigEntitySchema, {
    ...BASE_OPTIONS,
    name: "PipelineConfigEntity",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}

export function generateTriggerJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(TriggerConfigEntitySchema, {
    ...BASE_OPTIONS,
    name: "TriggerConfigEntity",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}

export function generatePromptJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(PromptConfigEntitySchema, {
    ...BASE_OPTIONS,
    name: "PromptConfigEntity",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}

export function generateSkillStateJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(SkillStateConfigEntitySchema, {
    ...BASE_OPTIONS,
    name: "SkillStateConfigEntity",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}

export function generateConnectionJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(ConnectionConfigEntitySchema, {
    ...BASE_OPTIONS,
    name: "ConnectionConfigEntity",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}

export function generateProviderKeyJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(ProviderKeyConfigEntitySchema, {
    ...BASE_OPTIONS,
    name: "ProviderKeyConfigEntity",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}

export function generatePreferencesJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(PreferencesConfigEntitySchema, {
    ...BASE_OPTIONS,
    name: "PreferencesConfigEntity",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}

/**
 * Generate a combined JSON Schema containing all entity kinds as
 * `definitions`, with the top-level schema being the `ConfigEntity`
 * discriminated union.
 *
 * This is the schema you point YAML Language Server at:
 *   `# yaml-language-server: $schema=https://multiqlti.io/config-sync/schemas/config-entity.json`
 */
export function generateConfigEntityJsonSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(ConfigEntitySchema, {
    ...BASE_OPTIONS,
    name: "ConfigEntity",
    $refStrategy: "none",
    definitions: {
      PipelineConfigEntity: PipelineConfigEntitySchema,
      TriggerConfigEntity: TriggerConfigEntitySchema,
      PromptConfigEntity: PromptConfigEntitySchema,
      SkillStateConfigEntity: SkillStateConfigEntitySchema,
      ConnectionConfigEntity: ConnectionConfigEntitySchema,
      ProviderKeyConfigEntity: ProviderKeyConfigEntitySchema,
      PreferencesConfigEntity: PreferencesConfigEntitySchema,
    },
  }) as Record<string, unknown>;

  // Inject $id so tooling can resolve the schema by URL.
  return {
    $id: `${BASE_URI}/config-entity.json`,
    ...schema,
  };
}

/** Per-kind schema map for convenient iteration (e.g. writing files to disk). */
export const KIND_SCHEMAS: Record<string, () => Record<string, unknown>> = {
  pipeline: generatePipelineJsonSchema,
  trigger: generateTriggerJsonSchema,
  prompt: generatePromptJsonSchema,
  "skill-state": generateSkillStateJsonSchema,
  connection: generateConnectionJsonSchema,
  "provider-key": generateProviderKeyJsonSchema,
  preferences: generatePreferencesJsonSchema,
};

export { BASE_URI };
