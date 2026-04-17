/**
 * Built-in MCP Server Registry (issue #270).
 *
 * Manages the lifecycle of built-in MCP servers:
 *  - Auto-spawns when a matching workspace connection is created/enabled.
 *  - Terminates when the connection is deleted/disabled.
 *  - Registers / unregisters tool handlers in the global ToolRegistry.
 *
 * The registry maps ConnectionType → server factory function. When a connection
 * arrives it looks up the factory, instantiates the server, calls start(), and
 * registers the returned tool handlers.
 *
 * Secrets are provided at spawn time — they come from the caller (connection
 * route / storage) and are NEVER stored in this registry after tool handlers
 * are built. Once handlers close over the config, the registry holds no
 * plaintext secrets.
 */

import type { ConnectionType } from "@shared/types";
import type { ToolRegistry } from "../tools/registry";
import type { IBuiltinMcpServer, BuiltinMcpServerConfig } from "./base";
import { KubernetesMcpServer } from "./kubernetes/index";
import { DockerRunMcpServer } from "./docker-run/index";
import { GitHubMcpServer } from "./github/index";
import { GitLabMcpServer } from "./gitlab/index";

// ─── Factory Registry ─────────────────────────────────────────────────────────

/**
 * A factory that creates a fresh built-in MCP server instance.
 * Each connection gets its own isolated server instance.
 */
type ServerFactory = () => IBuiltinMcpServer;

/**
 * Tag appended to all tools registered by a built-in MCP server so we can
 * bulk-unregister them when the connection is removed.
 */
const BUILTIN_TAG_PREFIX = "builtin-mcp:";

// ─── Runtime entry ────────────────────────────────────────────────────────────

interface ActiveServer {
  server: IBuiltinMcpServer;
  /** Names of all tool handlers registered for this connection. */
  toolNames: string[];
}

// ─── BuiltinMcpServerRegistry ────────────────────────────────────────────────

export class BuiltinMcpServerRegistry {
  private readonly factories: Map<string, ServerFactory> = new Map();
  private readonly active: Map<string, ActiveServer> = new Map();
  private readonly toolRegistry: ToolRegistry;

  constructor(toolRegistry: ToolRegistry) {
    this.toolRegistry = toolRegistry;
    this.registerDefaultFactories();
  }

  // ── Default factories ────────────────────────────────────────────────────

  private registerDefaultFactories(): void {
    this.registerFactory("kubernetes", () => new KubernetesMcpServer());
    // docker-run capability is surfaced via a generic_mcp connection whose
    // config includes "provider": "docker-run"
    this.registerFactory("generic_mcp", () => new DockerRunMcpServer());
    this.registerFactory("github", () => new GitHubMcpServer());
    this.registerFactory("gitlab", () => new GitLabMcpServer());
  }

  // ── Factory management ───────────────────────────────────────────────────

  /**
   * Register (or replace) the factory for a connection type.
   * Used in tests to inject mocked server instances.
   */
  registerFactory(connectionType: string, factory: ServerFactory): void {
    this.factories.set(connectionType, factory);
  }

  /** Returns true if a factory exists for the given connection type. */
  hasFactory(connectionType: string): boolean {
    return this.factories.has(connectionType);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Spawn a built-in MCP server for the given connection.
   *
   * If a server is already running for `connectionId` it is stopped first
   * (idempotent — safe to call when a connection is updated).
   *
   * @param connectionType — the type of connection (must match a registered factory)
   * @param connectionId   — unique connection ID (used as the tool tag namespace)
   * @param config         — non-secret configuration JSON from the connection record
   * @param secrets        — decrypted secrets (MUST NOT be stored beyond this call)
   * @param allowDestructive — whether destructive tools are permitted
   */
  async spawn(
    connectionType: ConnectionType | string,
    connectionId: string,
    config: Record<string, unknown>,
    secrets: Record<string, string>,
    allowDestructive = false,
  ): Promise<void> {
    // Stop any existing server for this connection
    if (this.active.has(connectionId)) {
      await this.terminate(connectionId);
    }

    const factory = this.factories.get(connectionType);
    if (!factory) {
      // No built-in server for this connection type — silently skip
      return;
    }

    const server = factory();

    const serverCfg: BuiltinMcpServerConfig = {
      connectionId,
      config,
      secrets,
      allowDestructive,
    };

    await server.start(serverCfg);

    const handlers = server.getToolHandlers();
    const toolNames: string[] = [];

    for (const handler of handlers) {
      // Add a builtin-mcp tag for bulk-unregistration tracking
      const tagsWithBuiltin = [
        ...(handler.definition.tags ?? []),
        `${BUILTIN_TAG_PREFIX}${connectionId}`,
      ];
      const patchedDefinition = { ...handler.definition, tags: tagsWithBuiltin };

      this.toolRegistry.register({
        ...handler,
        definition: patchedDefinition,
      });

      toolNames.push(handler.definition.name);
    }

    this.active.set(connectionId, { server, toolNames });
  }

  /**
   * Terminate the built-in MCP server for the given connection and unregister
   * all its tool handlers.
   */
  async terminate(connectionId: string): Promise<void> {
    const entry = this.active.get(connectionId);
    if (!entry) return;

    for (const name of entry.toolNames) {
      this.toolRegistry.unregister(name);
    }

    try {
      await entry.server.stop();
    } catch (err) {
      // Log but do not rethrow — we always want cleanup to succeed
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[builtin-mcp-registry] Error stopping server for ${connectionId}: ${msg}`);
    }

    this.active.delete(connectionId);
  }

  /**
   * Terminate all active built-in MCP servers.
   * Called on process shutdown.
   */
  async terminateAll(): Promise<void> {
    const ids = Array.from(this.active.keys());
    await Promise.all(ids.map((id) => this.terminate(id)));
  }

  // ── Inspection ───────────────────────────────────────────────────────────

  /** Returns true if a server is currently active for the given connection ID. */
  isActive(connectionId: string): boolean {
    return this.active.has(connectionId);
  }

  /** Returns the list of tool names registered for a given connection ID. */
  getRegisteredToolNames(connectionId: string): string[] {
    return this.active.get(connectionId)?.toolNames ?? [];
  }

  /** Returns all currently active connection IDs. */
  getActiveConnectionIds(): string[] {
    return Array.from(this.active.keys());
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

// Lazily initialized — avoids circular import issues at module load time.
// Callers use `getBuiltinMcpRegistry()` rather than importing the instance directly.
let _registry: BuiltinMcpServerRegistry | null = null;

export function getBuiltinMcpRegistry(): BuiltinMcpServerRegistry {
  if (!_registry) {
    // Import toolRegistry here to avoid circular dep at module load time
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { toolRegistry } = require("../tools/index") as { toolRegistry: ToolRegistry };
    _registry = new BuiltinMcpServerRegistry(toolRegistry);
  }
  return _registry;
}

/**
 * Reset the singleton — only used in tests.
 */
export function _resetBuiltinMcpRegistry(): void {
  _registry = null;
}
