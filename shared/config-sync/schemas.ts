/**
 * Config Sync YAML Schemas (issue #313)
 *
 * Zod schemas for every entity kind that can be serialised to / deserialised
 * from a YAML config-sync file.  All entities carry:
 *
 *   - `kind`        — discriminator for the `ConfigEntity` union
 *   - `apiVersion`  — semver string for future migration tooling
 *
 * Unknown (extra) fields are rejected by default because every schema is
 * created with Zod's `strict()` — which mirrors the principle that the
 * config format is an explicit contract, not a free-form bag.
 */

import { z } from "zod";

// ─── Shared primitives ────────────────────────────────────────────────────────

/**
 * Semver string: MAJOR.MINOR.PATCH with optional pre-release / build.
 * E.g.  "1.0.0", "2.3.1-beta.1+build.42"
 */
const SemverSchema = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/,
    "apiVersion must be a valid semver string (e.g. '1.0.0')",
  );

// ─── pipeline ─────────────────────────────────────────────────────────────────

const ExecutionStrategyTypeSchema = z.enum([
  "single",
  "moa",
  "debate",
  "voting",
]);

const PipelineStageConfigSchema = z
  .object({
    teamId: z.string().min(1).max(100),
    modelSlug: z.string().min(1).max(200),
    systemPromptOverride: z.string().max(32_000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    enabled: z.boolean().default(true),
    approvalRequired: z.boolean().optional(),
    executionStrategy: ExecutionStrategyTypeSchema.optional(),
    skillId: z.string().optional(),
    delegationEnabled: z.boolean().optional(),
    allowedConnections: z.array(z.string()).optional(),
  })
  .strict();

const DAGEdgeConditionSchema = z
  .object({
    field: z.string().min(1),
    operator: z.enum(["eq", "neq", "gt", "lt", "contains", "exists"]),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  })
  .strict();

const DAGEdgeSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
    condition: DAGEdgeConditionSchema.optional(),
    label: z.string().optional(),
  })
  .strict();

const DAGStageSchema = z
  .object({
    id: z.string().min(1),
    teamId: z.string().min(1).max(100),
    modelSlug: z.string().min(1).max(200),
    systemPromptOverride: z.string().max(32_000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    enabled: z.boolean().default(true),
    approvalRequired: z.boolean().optional(),
    position: z.object({ x: z.number(), y: z.number() }).strict(),
    label: z.string().optional(),
    skillId: z.string().optional(),
    allowedConnections: z.array(z.string()).optional(),
  })
  .strict();

const PipelineDAGSchema = z
  .object({
    stages: z.array(DAGStageSchema),
    edges: z.array(DAGEdgeSchema),
  })
  .strict();

export const PipelineConfigEntitySchema = z
  .object({
    kind: z.literal("pipeline"),
    apiVersion: SemverSchema,
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    stages: z.array(PipelineStageConfigSchema).default([]),
    dag: PipelineDAGSchema.optional(),
    isTemplate: z.boolean().default(false),
  })
  .strict();

export type PipelineConfigEntity = z.infer<typeof PipelineConfigEntitySchema>;

// ─── trigger ──────────────────────────────────────────────────────────────────

const ScheduleTriggerConfigSchema = z
  .object({
    type: z.literal("schedule"),
    cron: z.string().min(9).max(100),
    timezone: z.string().optional(),
    input: z.string().optional(),
  })
  .strict();

const WebhookTriggerConfigSchema = z
  .object({
    type: z.literal("webhook"),
  })
  .strict();

const GitHubEventTriggerConfigSchema = z
  .object({
    type: z.literal("github_event"),
    repository: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, "repository must be 'owner/repo' format"),
    events: z.array(z.string().min(1)).min(1),
    refFilter: z.string().optional(),
  })
  .strict();

const FileChangeTriggerConfigSchema = z
  .object({
    type: z.literal("file_change"),
    watchPath: z.string().min(1),
    patterns: z.array(z.string().min(1)).min(1),
    debounceMs: z.number().int().min(0).optional(),
    input: z.string().optional(),
  })
  .strict();

export const TriggerConfigEntitySchema = z
  .object({
    kind: z.literal("trigger"),
    apiVersion: SemverSchema,
    pipelineRef: z.string().min(1).max(200),
    enabled: z.boolean().default(true),
    config: z.discriminatedUnion("type", [
      ScheduleTriggerConfigSchema,
      WebhookTriggerConfigSchema,
      GitHubEventTriggerConfigSchema,
      FileChangeTriggerConfigSchema,
    ]),
  })
  .strict();

export type TriggerConfigEntity = z.infer<typeof TriggerConfigEntitySchema>;

// ─── prompt ───────────────────────────────────────────────────────────────────

const PromptStageOverrideSchema = z
  .object({
    teamId: z.string().min(1).max(100),
    systemPrompt: z.string().min(1).max(32_000),
  })
  .strict();

export const PromptConfigEntitySchema = z
  .object({
    kind: z.literal("prompt"),
    apiVersion: SemverSchema,
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    /** Default system prompt applied to all stages unless overridden. */
    defaultPrompt: z.string().max(32_000).optional(),
    /** Per-stage system prompt overrides. */
    stageOverrides: z.array(PromptStageOverrideSchema).default([]),
    /** Tag set for discoverability / filtering. */
    tags: z.array(z.string().min(1).max(100)).default([]),
  })
  .strict();

export type PromptConfigEntity = z.infer<typeof PromptConfigEntitySchema>;

// ─── skill-state ──────────────────────────────────────────────────────────────

const InstalledSkillSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(200),
    version: SemverSchema,
    source: z.enum(["builtin", "market", "git", "local"]),
    /** External registry identifier if source === "market". */
    externalId: z.string().optional(),
    /** External registry source adapter ID if source === "market". */
    registrySource: z.string().optional(),
    autoUpdate: z.boolean().default(false),
    /** ISO-8601 timestamp of installation. */
    installedAt: z.string().datetime().optional(),
  })
  .strict();

export const SkillStateConfigEntitySchema = z
  .object({
    kind: z.literal("skill-state"),
    apiVersion: SemverSchema,
    /** Snapshot timestamp for this lock-file — ISO-8601. */
    generatedAt: z.string().datetime(),
    skills: z.array(InstalledSkillSchema),
  })
  .strict();

export type SkillStateConfigEntity = z.infer<typeof SkillStateConfigEntitySchema>;

// ─── connection ───────────────────────────────────────────────────────────────

const CONNECTION_KINDS = [
  "gitlab",
  "github",
  "kubernetes",
  "aws",
  "jira",
  "grafana",
  "generic_mcp",
] as const;

/**
 * Config-sync representation of a workspace connection.
 * Secrets are intentionally excluded — those live in a separate
 * `.secret` file or environment variables.
 */
export const ConnectionConfigEntitySchema = z
  .object({
    kind: z.literal("connection"),
    apiVersion: SemverSchema,
    /** Display name of the connection. */
    name: z.string().min(1).max(200),
    type: z.enum(CONNECTION_KINDS),
    workspaceRef: z.string().min(1).max(200),
    /**
     * Non-secret configuration (URL, project key, region, …).
     * Secret values must NOT appear here — use provider-key references.
     */
    config: z.record(z.unknown()).default({}),
    status: z.enum(["active", "inactive"]).default("active"),
  })
  .strict();

export type ConnectionConfigEntity = z.infer<typeof ConnectionConfigEntitySchema>;

// ─── provider-key ─────────────────────────────────────────────────────────────

const API_PROVIDERS = [
  "anthropic",
  "google",
  "openai",
  "xai",
  "mistral",
  "groq",
  "vllm",
  "ollama",
  "lmstudio",
] as const;

const SECRET_REF_REGEX = /^\$\{(env|file|vault):([^}]+)\}$/;

/**
 * A reference to an encrypted API key.
 * The actual key material lives in a secrets store; this entity only records
 * which provider it belongs to and how to locate the reference.
 */
export const ProviderKeyConfigEntitySchema = z
  .object({
    kind: z.literal("provider-key"),
    apiVersion: SemverSchema,
    provider: z.enum(API_PROVIDERS),
    /**
     * Reference expression pointing to the encrypted key.
     * Must use one of: `${env:NAME}`, `${file:./path}`, `${vault:secret/path}`.
     */
    secretRef: z
      .string()
      .regex(
        SECRET_REF_REGEX,
        "secretRef must be a reference expression: ${env:NAME}, ${file:path}, or ${vault:path}",
      ),
    /** Human description (e.g. "Production Anthropic key"). */
    description: z.string().max(500).optional(),
    /** Whether this key is currently active. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type ProviderKeyConfigEntity = z.infer<typeof ProviderKeyConfigEntitySchema>;

// ─── preferences ──────────────────────────────────────────────────────────────

const THEMES = ["light", "dark", "system"] as const;
const LAYOUT_MODES = ["default", "compact", "wide"] as const;

export const PreferencesConfigEntitySchema = z
  .object({
    kind: z.literal("preferences"),
    apiVersion: SemverSchema,
    /** Scope: "global" applies to all users; "user" scopes to a specific user ID. */
    scope: z.enum(["global", "user"]).default("global"),
    /** User ID when scope === "user". */
    userId: z.string().optional(),
    ui: z
      .object({
        theme: z.enum(THEMES).default("system"),
        layout: z.enum(LAYOUT_MODES).default("default"),
        /** Feature flags toggled in the UI. */
        featureFlags: z.record(z.boolean()).default({}),
      })
      .strict()
      .default({}),
    /** Key-value pairs for additional preferences not covered by the `ui` block. */
    extra: z.record(z.unknown()).default({}),
  })
  .strict();

export type PreferencesConfigEntity = z.infer<typeof PreferencesConfigEntitySchema>;

// ─── Discriminated union ──────────────────────────────────────────────────────

/**
 * Union of all config-sync entity kinds, discriminated by the `kind` field.
 *
 * Usage:
 *   ```ts
 *   const entity = ConfigEntitySchema.parse(yaml.load(content));
 *   if (entity.kind === "pipeline") { ... }
 *   ```
 */
export const ConfigEntitySchema = z.discriminatedUnion("kind", [
  PipelineConfigEntitySchema,
  TriggerConfigEntitySchema,
  PromptConfigEntitySchema,
  SkillStateConfigEntitySchema,
  ConnectionConfigEntitySchema,
  ProviderKeyConfigEntitySchema,
  PreferencesConfigEntitySchema,
]);

export type ConfigEntity = z.infer<typeof ConfigEntitySchema>;

/** Convenience type-guard helpers. */
export function isPipelineEntity(e: ConfigEntity): e is PipelineConfigEntity {
  return e.kind === "pipeline";
}
export function isTriggerEntity(e: ConfigEntity): e is TriggerConfigEntity {
  return e.kind === "trigger";
}
export function isPromptEntity(e: ConfigEntity): e is PromptConfigEntity {
  return e.kind === "prompt";
}
export function isSkillStateEntity(e: ConfigEntity): e is SkillStateConfigEntity {
  return e.kind === "skill-state";
}
export function isConnectionEntity(e: ConfigEntity): e is ConnectionConfigEntity {
  return e.kind === "connection";
}
export function isProviderKeyEntity(e: ConfigEntity): e is ProviderKeyConfigEntity {
  return e.kind === "provider-key";
}
export function isPreferencesEntity(e: ConfigEntity): e is PreferencesConfigEntity {
  return e.kind === "preferences";
}
