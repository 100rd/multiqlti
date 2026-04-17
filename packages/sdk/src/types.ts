/**
 * @multiqlti/sdk — type contracts for the custom agent/tool SDK.
 *
 * These types are the stable public contract between the platform runtime and
 * user-authored modules.  Every module loaded by the dynamic loader MUST
 * expose values that conform to these types.
 */

// ─── Scope & Permission types ─────────────────────────────────────────────────

/**
 * Named scopes that constrain what a tool is allowed to do.
 * The sandbox enforces these at runtime.
 */
export type ToolScope =
  | "read:workspace"
  | "write:workspace"
  | "read:memory"
  | "write:memory"
  | "read:runs"
  | "write:runs"
  | "http:outbound";

// ─── Tool definition ──────────────────────────────────────────────────────────

/**
 * Strongly-typed handler function for a custom tool invocation.
 *
 * @param args  Validated arguments (already checked against inputSchema).
 * @param ctx   Execution context injected by the platform runtime.
 * @returns     A string result that will be forwarded to the LLM.
 */
export type ToolHandlerFn = (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
) => Promise<string> | string;

/**
 * Runtime context passed to every tool invocation by the platform.
 */
export interface ToolExecutionContext {
  /** Workspace this tool is executing inside. */
  workspaceId: string;
  /** Optional pipeline run ID, present when invoked from a pipeline stage. */
  runId?: string;
  /** Scoped logger — writes to the platform structured log, not console. */
  log: (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void;
  /**
   * Fetch wrapper available only when the tool declared "http:outbound" scope.
   * Throws if the tool did not declare the scope (blocked in sandbox).
   */
  fetch: typeof globalThis.fetch;
}

/**
 * Complete definition of a custom tool as passed to `defineTool`.
 */
export interface ToolDefinitionInput {
  /** Unique name — kebab-case or snake_case, max 80 chars. */
  name: string;
  /** Human-readable description shown in the tool chooser UI. */
  description: string;
  /**
   * JSON Schema (draft-07) describing the tool's input arguments.
   * Must be an object schema at the top level.
   */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  /**
   * Platform scopes this tool requires.
   * Unscoped tools get no access to platform APIs or outbound HTTP.
   */
  scopes?: ToolScope[];
  /** Handler function called on each invocation. */
  handler: ToolHandlerFn;
}

/**
 * Normalised tool definition emitted by `defineTool`.
 * This is the canonical shape stored in the platform registry.
 */
export interface NormalisedToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly scopes: ToolScope[];
  readonly handler: ToolHandlerFn;
  /** SDK contract version — injected by `defineTool`. */
  readonly sdkVersion: string;
  /** Discriminant for runtime type-guards. */
  readonly _kind: "tool";
}

// ─── Skill definition ─────────────────────────────────────────────────────────

/**
 * A prompt preset: system-prompt text plus optional variable placeholders.
 * Placeholders use {{variable_name}} syntax (double braces).
 */
export interface SkillPrompt {
  /** Identifies the prompt; must be unique within the skill. */
  id: string;
  /** Short label shown in the UI. */
  label: string;
  /** Full system prompt text.  May contain {{variable}} placeholders. */
  systemPrompt: string;
}

/**
 * Defaults applied to pipeline stages that use this skill.
 */
export interface SkillDefaults {
  /** Preferred model slug (e.g. "claude-sonnet-4-6"). */
  modelPreference?: string;
  /** Temperature override (0–2). */
  temperature?: number;
  /** Maximum output tokens override. */
  maxTokens?: number;
}

/**
 * Complete skill definition passed to `defineSkill`.
 */
export interface SkillDefinitionInput {
  /** Unique name — kebab-case or snake_case, max 80 chars. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** One or more prompt presets.  At least one is required. */
  prompts: [SkillPrompt, ...SkillPrompt[]];
  /** Names of tools (builtin, MCP, or custom) this skill needs. */
  tools?: string[];
  /** Default pipeline-stage settings applied when the skill is used. */
  defaults?: SkillDefaults;
  /** Free-form tags for skill-market search filtering. */
  tags?: string[];
}

/**
 * Normalised skill definition emitted by `defineSkill`.
 */
export interface NormalisedSkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly prompts: [SkillPrompt, ...SkillPrompt[]];
  readonly tools: string[];
  readonly defaults: SkillDefaults;
  readonly tags: string[];
  readonly sdkVersion: string;
  readonly _kind: "skill";
}

// ─── Role definition ──────────────────────────────────────────────────────────

/**
 * Complete role definition passed to `defineRole`.
 *
 * A role wraps together a system prompt, a preferred model, and an explicit
 * allow-list of tools.  Pipeline stages can reference a role by name.
 */
export interface RoleDefinitionInput {
  /** Unique name — kebab-case or snake_case, max 80 chars. */
  name: string;
  /** Full system prompt for this role. */
  systemPrompt: string;
  /**
   * Explicit allow-list of tool names this role may invoke.
   * If omitted, the role may invoke all tools available to the workspace.
   */
  allowedTools?: string[];
  /** Preferred model slug. Falls back to workspace/stage default when absent. */
  model?: string;
}

/**
 * Normalised role definition emitted by `defineRole`.
 */
export interface NormalisedRoleDefinition {
  readonly name: string;
  readonly systemPrompt: string;
  readonly allowedTools: string[] | null;
  readonly model: string | null;
  readonly sdkVersion: string;
  readonly _kind: "role";
}

// ─── SDK module shape ─────────────────────────────────────────────────────────

/**
 * What a user-authored module must export as its default export (or named
 * exports) to be loadable by the platform dynamic loader.
 *
 * At least one of `tools`, `skills`, or `roles` must be non-empty.
 */
export interface SdkModule {
  tools?: NormalisedToolDefinition[];
  skills?: NormalisedSkillDefinition[];
  roles?: NormalisedRoleDefinition[];
}

// ─── Tool source configuration ────────────────────────────────────────────────

/**
 * Describes where the platform should load a custom tool/skill package from.
 *
 * Supported origins:
 *   - `npm`   — install a package from the npm registry (or a private registry)
 *   - `local` — load from an absolute filesystem path (server-side only)
 *   - `git`   — clone a git repository and load from a subpath
 */
export type ToolSourceType = "npm" | "local" | "git";

export interface NpmToolSource {
  type: "npm";
  /** Package name, optionally including a version specifier (e.g. "my-pkg@1.2.3"). */
  package: string;
  /** Optional npm registry URL.  Defaults to https://registry.npmjs.org. */
  registry?: string;
}

export interface LocalToolSource {
  type: "local";
  /** Absolute path on the server filesystem. */
  path: string;
}

export interface GitToolSource {
  type: "git";
  /** Clonable git URL (https or ssh). */
  url: string;
  /** Branch, tag, or full commit SHA.  Defaults to "main". */
  ref?: string;
  /** Sub-path within the repo to use as the package root.  Defaults to ".". */
  subpath?: string;
}

export type ToolSource = NpmToolSource | LocalToolSource | GitToolSource;

/**
 * Per-workspace custom tool source configuration.
 * Stored in the workspace settings JSON column.
 */
export interface WorkspaceToolSourceConfig {
  /** Ordered list of sources to load.  Loaded in array order. */
  sources: ToolSource[];
  /**
   * When true, the loader will watch local sources for file-system changes
   * and hot-reload automatically.
   */
  hotReload?: boolean;
}
