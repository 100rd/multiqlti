/**
 * server/tools/workspace-registry.ts
 *
 * Extends the global ToolRegistry with per-workspace overlays.
 *
 * Architecture:
 *   - The global ToolRegistry holds builtin + MCP tools visible to all workspaces.
 *   - Each workspace gets its own Map<sourceKey, SdkModule> overlay.
 *   - Tool resolution: workspace overlay tools shadow (override) global tools with
 *     the same name, without modifying the global registry.
 *   - Workspace overlays are isolated: workspace A tools are NOT visible to workspace B.
 *
 * Thread-safety: Node.js is single-threaded; no additional locking is needed.
 */

import type {
  NormalisedToolDefinition,
  NormalisedSkillDefinition,
  NormalisedRoleDefinition,
  SdkModule,
  ToolScope,
} from "../../packages/sdk/src/types.js";

import type { ToolDefinition, ToolCall, ToolResult } from "@shared/types";
import { ToolRegistry } from "./registry.js";
import {
  createSandboxContext,
  DEFAULT_SANDBOX_LIMITS,
} from "./sandbox-vm.js";
import type { SandboxLimits } from "./sandbox-vm.js";

// ─── Custom tool handler ──────────────────────────────────────────────────────

/**
 * Wraps a NormalisedToolDefinition into a sandboxed executor that:
 *   1. Creates a per-invocation execution context.
 *   2. Enforces the tool's declared scopes (HTTP opt-in).
 *   3. Applies a hard timeout via Promise.race.
 *   4. Caps result length.
 */
function buildCustomToolHandler(
  def: NormalisedToolDefinition,
  limits: SandboxLimits,
): { definition: ToolDefinition; execute: (args: Record<string, unknown>) => Promise<string> } {
  return {
    definition: {
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      source: "builtin" as const, // treated as first-class on the platform
      tags: ["custom", "sdk"],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      // Build a per-invocation context with scoped fetch
      const fetchApi = def.scopes.includes("http:outbound")
        ? (globalThis.fetch ?? null)
        : null;
      const ctx = createSandboxContext(def.scopes, fetchApi);

      // Build the ToolExecutionContext injected into the handler
      const execCtx = {
        workspaceId: (ctx as Record<string, unknown>)._workspaceId as string ?? "unknown",
        log: (_level: string, _msg: string, _extra?: Record<string, unknown>) => {
          // Structured log noop — in production this would route to the platform logger
        },
        fetch: def.scopes.includes("http:outbound")
          ? (globalThis.fetch ?? (() => { throw new TypeError("[sdk] fetch not available"); }))
          : (() => { throw new TypeError(`[sdk] Tool "${def.name}" did not declare http:outbound scope`); }) as unknown as typeof globalThis.fetch,
      };

      const timeoutMs = limits.executionTimeoutMs;

      const timeoutPromise: Promise<never> = new Promise((_, reject) => {
        const t = setTimeout(() => {
          reject(new Error(`Tool "${def.name}" exceeded execution timeout (${timeoutMs}ms)`));
        }, timeoutMs);
        // Unref so the timer doesn't keep Node alive
        if (typeof (t as unknown as { unref?: () => void }).unref === "function") {
          (t as unknown as { unref: () => void }).unref();
        }
      });

      let result: string;
      try {
        const handlerResult = await Promise.race([
          Promise.resolve(def.handler(args, execCtx)),
          timeoutPromise,
        ]);
        result = String(handlerResult ?? "");
      } catch (err) {
        throw err; // re-throw; ToolRegistry.execute handles wrapping
      }

      if (result.length > limits.maxResultLength) {
        result = result.slice(0, limits.maxResultLength) +
          `\n\n[result truncated at ${limits.maxResultLength} chars]`;
      }

      return result;
    },
  };
}

// ─── WorkspaceToolRegistry ────────────────────────────────────────────────────

/**
 * Per-workspace view into the tool registry.
 *
 * Provides:
 *   - `getAvailableTools(workspaceId)` — global tools + workspace custom tools
 *   - `execute(workspaceId, call)` — dispatch to workspace-scoped or global handler
 *   - `setWorkspaceOverlay(workspaceId, sourceKey, module)` — register loaded module
 *   - `removeWorkspaceOverlay(workspaceId, sourceKey)` — rollback / remove source
 */
export class WorkspaceToolRegistry {
  private readonly globalRegistry: ToolRegistry;
  private readonly limits: SandboxLimits;

  /**
   * workspaceId → (sourceKey → SdkModule)
   * Two-level map: first level is workspace isolation, second is per-source rollback.
   */
  private readonly overlays: Map<string, Map<string, SdkModule>> = new Map();

  constructor(globalRegistry: ToolRegistry, limits: SandboxLimits = DEFAULT_SANDBOX_LIMITS) {
    this.globalRegistry = globalRegistry;
    this.limits = limits;
  }

  // ─── Overlay management ────────────────────────────────────────────────────

  setWorkspaceOverlay(workspaceId: string, sourceKey: string, sdkModule: SdkModule): void {
    if (!this.overlays.has(workspaceId)) {
      this.overlays.set(workspaceId, new Map());
    }
    this.overlays.get(workspaceId)!.set(sourceKey, sdkModule);
  }

  removeWorkspaceOverlay(workspaceId: string, sourceKey: string): void {
    this.overlays.get(workspaceId)?.delete(sourceKey);
  }

  clearWorkspaceOverlays(workspaceId: string): void {
    this.overlays.delete(workspaceId);
  }

  // ─── Query ─────────────────────────────────────────────────────────────────

  /**
   * Returns all tools visible to the workspace:
   *   - Global registry tools
   *   - Custom tools from workspace overlays (by name, overlay tools win)
   */
  getAvailableTools(workspaceId: string): ToolDefinition[] {
    const globalTools = this.globalRegistry.getAvailableTools();
    const customTools = this.getCustomToolDefs(workspaceId);

    if (customTools.length === 0) return globalTools;

    // Overlay: custom tools with the same name shadow global tools
    const customNames = new Set(customTools.map((t) => t.name));
    const filtered = globalTools.filter((t) => !customNames.has(t.name));
    return [...filtered, ...customTools];
  }

  getCustomToolDefs(workspaceId: string): ToolDefinition[] {
    const workspace = this.overlays.get(workspaceId);
    if (!workspace) return [];

    const seen = new Set<string>();
    const defs: ToolDefinition[] = [];

    for (const sdkModule of workspace.values()) {
      for (const tool of sdkModule.tools ?? []) {
        if (!seen.has(tool.name)) {
          seen.add(tool.name);
          defs.push(buildCustomToolHandler(tool, this.limits).definition);
        }
      }
    }

    return defs;
  }

  getCustomSkills(workspaceId: string): NormalisedSkillDefinition[] {
    const workspace = this.overlays.get(workspaceId);
    if (!workspace) return [];

    const seen = new Set<string>();
    const skills: NormalisedSkillDefinition[] = [];

    for (const sdkModule of workspace.values()) {
      for (const skill of sdkModule.skills ?? []) {
        if (!seen.has(skill.name)) {
          seen.add(skill.name);
          skills.push(skill);
        }
      }
    }

    return skills;
  }

  getCustomRoles(workspaceId: string): NormalisedRoleDefinition[] {
    const workspace = this.overlays.get(workspaceId);
    if (!workspace) return [];

    const seen = new Set<string>();
    const roles: NormalisedRoleDefinition[] = [];

    for (const sdkModule of workspace.values()) {
      for (const role of sdkModule.roles ?? []) {
        if (!seen.has(role.name)) {
          seen.add(role.name);
          roles.push(role);
        }
      }
    }

    return roles;
  }

  // ─── Execution ─────────────────────────────────────────────────────────────

  /**
   * Execute a tool call in the context of a specific workspace.
   *
   * Lookup order:
   *   1. Workspace custom tool overlay (first source that defines the name wins).
   *   2. Global tool registry (builtin + MCP).
   */
  async execute(workspaceId: string, call: ToolCall): Promise<ToolResult> {
    // Look for custom tool in workspace overlays
    const workspace = this.overlays.get(workspaceId);
    if (workspace) {
      for (const sdkModule of workspace.values()) {
        for (const toolDef of sdkModule.tools ?? []) {
          if (toolDef.name === call.name) {
            const handler = buildCustomToolHandler(toolDef, this.limits);
            try {
              const content = await handler.execute(call.arguments);
              return { toolCallId: call.id, content, isError: false };
            } catch (err) {
              const message = (err as Error).message;
              return { toolCallId: call.id, content: `Tool execution failed: ${message}`, isError: true };
            }
          }
        }
      }
    }

    // Fall through to global registry
    return this.globalRegistry.execute(call);
  }
}
