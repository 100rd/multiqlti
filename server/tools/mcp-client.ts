import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ToolDefinition, McpServerConfig, ConnectionType } from "@shared/types";
import { toolRegistry } from "./index";
import { BuiltinMcpServerRegistry } from "../mcp-servers/registry";

interface McpConnection {
  client: Client;
  tools: ToolDefinition[];
  error?: string;
}

export class McpClientManager {
  private connections: Map<string, McpConnection> = new Map();
  private builtinRegistry: BuiltinMcpServerRegistry;

  constructor(builtinRegistry?: BuiltinMcpServerRegistry) {
    this.builtinRegistry = builtinRegistry ?? new BuiltinMcpServerRegistry(toolRegistry);
  }

  // ── Built-in MCP server integration ────────────────────────────────────────

  /**
   * Spawn a built-in MCP server for a workspace connection.
   * Called when a connection is created or enabled.
   *
   * @param connectionType — e.g. "kubernetes", "github", "gitlab", "generic_mcp"
   * @param connectionId   — unique connection ID from the workspace connection record
   * @param config         — non-secret config JSON
   * @param secrets        — decrypted secrets (MUST NOT be stored after this call)
   * @param allowDestructive — whether destructive tools are enabled
   */
  async spawnBuiltinServer(
    connectionType: ConnectionType | string,
    connectionId: string,
    config: Record<string, unknown>,
    secrets: Record<string, string>,
    allowDestructive = false,
  ): Promise<void> {
    if (!this.builtinRegistry.hasFactory(connectionType)) {
      return; // No built-in server for this type — skip silently
    }
    await this.builtinRegistry.spawn(
      connectionType,
      connectionId,
      config,
      secrets,
      allowDestructive,
    );
    const toolNames = this.builtinRegistry.getRegisteredToolNames(connectionId);
    console.log(
      `[mcp-client] Built-in server spawned for connection "${connectionId}" ` +
      `(type: ${connectionType}) — ${toolNames.length} tool(s) registered`,
    );
  }

  /**
   * Terminate the built-in MCP server for a workspace connection.
   * Called when a connection is deleted or disabled.
   */
  async terminateBuiltinServer(connectionId: string): Promise<void> {
    if (!this.builtinRegistry.isActive(connectionId)) return;
    await this.builtinRegistry.terminate(connectionId);
    console.log(`[mcp-client] Built-in server terminated for connection "${connectionId}"`);
  }

  // ── External MCP server management ─────────────────────────────────────────

  async connect(config: McpServerConfig): Promise<void> {
    // Disconnect existing connection for this server if any
    if (this.connections.has(config.name)) {
      await this.disconnect(config.name);
    }

    const client = new Client(
      { name: "multiqlti-mcp-client", version: "1.0.0" },
      { capabilities: {} },
    );

    let transport;
    if (config.transport === "stdio") {
      if (!config.command) {
        throw new Error(`MCP server "${config.name}" requires a command for stdio transport`);
      }
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
      });
    } else if (config.transport === "sse" || config.transport === "streamable-http") {
      if (!config.url) {
        throw new Error(`MCP server "${config.name}" requires a URL for ${config.transport} transport`);
      }
      transport = new SSEClientTransport(new URL(config.url));
    } else {
      throw new Error(`Unknown MCP transport: ${config.transport as string}`);
    }

    await client.connect(transport);

    // Fetch the server's tool list
    const { tools: mcpTools } = await client.listTools();

    const toolDefs: ToolDefinition[] = (mcpTools ?? []).map((t) => ({
      name: `${config.name}__${t.name}`,
      description: t.description ?? `Tool "${t.name}" from MCP server "${config.name}"`,
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      source: "mcp" as const,
      mcpServer: config.name,
      tags: ["mcp"],
    }));

    // Register tools in the global registry
    for (const def of toolDefs) {
      const mcpToolName = def.name.slice(config.name.length + 2); // strip "serverName__" prefix
      const serverName = config.name;
      toolRegistry.register({
        definition: def,
        execute: async (args) => {
          return this.callTool(serverName, mcpToolName, args);
        },
      });
    }

    this.connections.set(config.name, { client, tools: toolDefs });
    console.log(`[mcp-client] Connected to "${config.name}" — ${toolDefs.length} tool(s) registered`);
  }

  async disconnect(serverName: string): Promise<void> {
    const conn = this.connections.get(serverName);
    if (!conn) return;

    // Unregister all tools for this server
    for (const def of conn.tools) {
      toolRegistry.unregister(def.name);
    }

    try {
      await conn.client.close();
    } catch (err) {
      console.warn(`[mcp-client] Error closing connection to "${serverName}":`, err);
    }

    this.connections.delete(serverName);
    console.log(`[mcp-client] Disconnected from "${serverName}"`);
  }

  getTools(serverName?: string): ToolDefinition[] {
    if (serverName) {
      return this.connections.get(serverName)?.tools ?? [];
    }
    const all: ToolDefinition[] = [];
    for (const conn of this.connections.values()) {
      all.push(...conn.tools);
    }
    return all;
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      throw new Error(`Not connected to MCP server "${serverName}"`);
    }

    const result = await conn.client.callTool({ name: toolName, arguments: args });

    // Extract text content from result
    const content = result.content ?? [];
    if (Array.isArray(content)) {
      const textParts = content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text);
      return textParts.join("\n") || JSON.stringify(result);
    }

    return String(result);
  }

  getStatus(): Record<string, { connected: boolean; toolCount: number; error?: string }> {
    const status: Record<string, { connected: boolean; toolCount: number; error?: string }> = {};
    for (const [name, conn] of this.connections.entries()) {
      status[name] = {
        connected: true,
        toolCount: conn.tools.length,
        error: conn.error,
      };
    }
    return status;
  }

  /** Returns the underlying built-in server registry for inspection in tests. */
  getBuiltinRegistry(): BuiltinMcpServerRegistry {
    return this.builtinRegistry;
  }
}

// Singleton instance
export const mcpClientManager = new McpClientManager();
