/**
 * @multiqlti/sdk
 *
 * Platform SDK for authoring custom tools, skills, and roles.
 *
 * Quick-start example:
 *
 * ```ts
 * import { defineTool, defineSkill, defineRole } from "@multiqlti/sdk";
 *
 * export const myTool = defineTool({
 *   name: "my_tool",
 *   description: "Does something useful",
 *   inputSchema: {
 *     type: "object",
 *     properties: { query: { type: "string" } },
 *     required: ["query"],
 *   },
 *   scopes: ["http:outbound"],
 *   handler: async (args, ctx) => {
 *     const resp = await ctx.fetch(`https://example.com?q=${args.query}`);
 *     return await resp.text();
 *   },
 * });
 *
 * export const mySkill = defineSkill({
 *   name: "my_skill",
 *   description: "A skill that uses my tool",
 *   prompts: [{ id: "default", label: "Default", systemPrompt: "You are a helpful assistant." }],
 *   tools: ["my_tool"],
 * });
 *
 * export const myRole = defineRole({
 *   name: "my_role",
 *   systemPrompt: "You are an expert in...",
 *   allowedTools: ["my_tool"],
 *   model: "claude-sonnet-4-6",
 * });
 * ```
 */

export type {
  ToolScope,
  ToolHandlerFn,
  ToolExecutionContext,
  ToolDefinitionInput,
  NormalisedToolDefinition,
  SkillPrompt,
  SkillDefaults,
  SkillDefinitionInput,
  NormalisedSkillDefinition,
  RoleDefinitionInput,
  NormalisedRoleDefinition,
  SdkModule,
  ToolSourceType,
  NpmToolSource,
  LocalToolSource,
  GitToolSource,
  ToolSource,
  WorkspaceToolSourceConfig,
} from "./types.js";

import type {
  ToolDefinitionInput,
  NormalisedToolDefinition,
  SkillDefinitionInput,
  NormalisedSkillDefinition,
  RoleDefinitionInput,
  NormalisedRoleDefinition,
  ToolScope,
} from "./types.js";

/** Current SDK contract version — bumped on breaking changes. */
export const SDK_VERSION = "0.1.0";

// ─── Name validation ──────────────────────────────────────────────────────────

const NAME_RE = /^[a-z][a-z0-9_-]{0,79}$/;

function validateName(name: string, label: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `${label} name "${name}" is invalid. Names must start with a lowercase letter and contain only lowercase letters, digits, underscores, and hyphens (max 80 chars).`,
    );
  }
}

// ─── defineTool ───────────────────────────────────────────────────────────────

/**
 * Define a custom tool that the platform can invoke on behalf of an LLM.
 *
 * The returned `NormalisedToolDefinition` is a plain, serialisable object.
 * Pass it to `SdkModule.tools` in your module's exports.
 *
 * @example
 * ```ts
 * export const greetTool = defineTool({
 *   name: "greet",
 *   description: "Greet a person by name",
 *   inputSchema: {
 *     type: "object",
 *     properties: { name: { type: "string" } },
 *     required: ["name"],
 *   },
 *   handler: async (args) => `Hello, ${args.name}!`,
 * });
 * ```
 */
export function defineTool(input: ToolDefinitionInput): NormalisedToolDefinition {
  validateName(input.name, "Tool");

  if (!input.description || input.description.trim().length === 0) {
    throw new Error(`Tool "${input.name}": description must not be empty.`);
  }

  if (input.inputSchema.type !== "object") {
    throw new Error(`Tool "${input.name}": inputSchema must be an object schema at the top level.`);
  }

  if (typeof input.handler !== "function") {
    throw new Error(`Tool "${input.name}": handler must be a function.`);
  }

  const scopes: ToolScope[] = Array.isArray(input.scopes)
    ? [...new Set(input.scopes)]
    : [];

  return {
    _kind: "tool",
    name: input.name,
    description: input.description.trim(),
    inputSchema: input.inputSchema as Record<string, unknown>,
    scopes,
    handler: input.handler,
    sdkVersion: SDK_VERSION,
  };
}

// ─── defineSkill ──────────────────────────────────────────────────────────────

/**
 * Define a custom skill — a reusable combination of prompts, tools, and
 * default stage settings.
 *
 * @example
 * ```ts
 * export const summarySkill = defineSkill({
 *   name: "summariser",
 *   description: "Summarises long documents",
 *   prompts: [
 *     { id: "default", label: "Default", systemPrompt: "You are a concise summariser." },
 *   ],
 *   tools: ["web_search"],
 *   defaults: { temperature: 0.3, maxTokens: 1024 },
 *   tags: ["text", "summarisation"],
 * });
 * ```
 */
export function defineSkill(input: SkillDefinitionInput): NormalisedSkillDefinition {
  validateName(input.name, "Skill");

  if (!input.description || input.description.trim().length === 0) {
    throw new Error(`Skill "${input.name}": description must not be empty.`);
  }

  if (!Array.isArray(input.prompts) || input.prompts.length === 0) {
    throw new Error(`Skill "${input.name}": prompts must be a non-empty array.`);
  }

  // Validate individual prompts
  const seenPromptIds = new Set<string>();
  for (const prompt of input.prompts) {
    if (!prompt.id || !prompt.label || !prompt.systemPrompt) {
      throw new Error(
        `Skill "${input.name}": each prompt must have id, label, and systemPrompt.`,
      );
    }
    if (seenPromptIds.has(prompt.id)) {
      throw new Error(`Skill "${input.name}": duplicate prompt id "${prompt.id}".`);
    }
    seenPromptIds.add(prompt.id);
  }

  return {
    _kind: "skill",
    name: input.name,
    description: input.description.trim(),
    prompts: input.prompts as [typeof input.prompts[0], ...typeof input.prompts],
    tools: input.tools ? [...input.tools] : [],
    defaults: input.defaults ?? {},
    tags: input.tags ? [...input.tags] : [],
    sdkVersion: SDK_VERSION,
  };
}

// ─── defineRole ───────────────────────────────────────────────────────────────

/**
 * Define a custom role — a named configuration pairing a system prompt with an
 * allowed-tool list and an optional model preference.
 *
 * @example
 * ```ts
 * export const securityRole = defineRole({
 *   name: "security_reviewer",
 *   systemPrompt: "You are a senior security engineer. Review all code for vulnerabilities.",
 *   allowedTools: ["code_search", "file_read"],
 *   model: "claude-opus-4",
 * });
 * ```
 */
export function defineRole(input: RoleDefinitionInput): NormalisedRoleDefinition {
  validateName(input.name, "Role");

  if (!input.systemPrompt || input.systemPrompt.trim().length === 0) {
    throw new Error(`Role "${input.name}": systemPrompt must not be empty.`);
  }

  return {
    _kind: "role",
    name: input.name,
    systemPrompt: input.systemPrompt.trim(),
    allowedTools: input.allowedTools ? [...input.allowedTools] : null,
    model: input.model ?? null,
    sdkVersion: SDK_VERSION,
  };
}
