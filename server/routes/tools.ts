import type { Express } from "express";
import { z } from "zod";
import { toolRegistry } from "../tools/index";
import { mcpClientManager } from "../tools/mcp-client";
import type { IStorage } from "../storage";

const createMcpServerSchema = z.object({
  name: z.string().min(1).max(100),
  transport: z.enum(["stdio", "sse", "streamable-http"]),
  command: z.string().optional().nullable(),
  args: z.array(z.string()).optional().nullable(),
  url: z.string().url().optional().nullable(),
  env: z.record(z.string()).optional().nullable(),
  enabled: z.boolean().default(true),
  autoConnect: z.boolean().default(false),
});

const updateMcpServerSchema = createMcpServerSchema.partial();

const testToolSchema = z.object({
  args: z.record(z.unknown()),
});

export function registerToolRoutes(app: Express, storage: IStorage): void {

  // ─── Built-in Tools ─────────────────────────────────────────────────────────

  /** GET /api/tools — all available tools (builtin + mcp) */
  app.get("/api/tools", (_req, res) => {
    const tools = toolRegistry.getAvailableTools();
    res.json(tools);
  });

  /** GET /api/tools/status — configuration status of each tool */
  app.get("/api/tools/status", (_req, res) => {
    const hasTavily = !!process.env.TAVILY_API_KEY;

    res.json({
      web_search: {
        configured: true,  // always available (fallback to DDG)
        keySource: hasTavily ? "TAVILY_API_KEY" : "duckduckgo-fallback",
        premium: hasTavily,
      },
      url_reader: {
        configured: true,  // always available via Jina
        keySource: "jina-ai-free",
      },
      knowledge_search: {
        configured: true,
        keySource: "internal-storage",
      },
      memory_search: {
        configured: true,
        keySource: "internal-storage",
      },
    });
  });

  /** POST /api/tools/:name/test — test a tool with given args */
  app.post("/api/tools/:name/test", async (req, res) => {
    const { name } = req.params as { name: string };
    const parse = testToolSchema.safeParse(req.body);

    if (!parse.success) {
      return res.status(400).json({ error: parse.error.flatten() });
    }

    const toolDef = toolRegistry.getToolByName(name);
    if (!toolDef) {
      return res.status(404).json({ error: `Tool "${name}" not found` });
    }

    const call = {
      id: crypto.randomUUID(),
      name,
      arguments: parse.data.args,
    };

    const result = await toolRegistry.execute(call);
    return res.json(result);
  });

  // ─── MCP Servers ────────────────────────────────────────────────────────────

  /** GET /api/mcp/servers — list all MCP server configs */
  app.get("/api/mcp/servers", async (_req, res) => {
    const servers = await storage.getMcpServers();
    const connectionStatus = mcpClientManager.getStatus();

    const enriched = servers.map((s) => ({
      ...s,
      // Never return env vars in API responses
      env: undefined,
      connected: !!connectionStatus[s.name]?.connected,
      toolCount: connectionStatus[s.name]?.toolCount ?? s.toolCount,
      connectionError: connectionStatus[s.name]?.error,
    }));

    res.json(enriched);
  });

  /** POST /api/mcp/servers — create a new MCP server config */
  app.post("/api/mcp/servers", async (req, res) => {
    const parse = createMcpServerSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: parse.error.flatten() });
    }

    const data = parse.data;
    const server = await storage.createMcpServer({
      name: data.name,
      transport: data.transport,
      command: data.command ?? null,
      args: data.args ?? null,
      url: data.url ?? null,
      env: data.env ?? null,
      enabled: data.enabled,
      autoConnect: data.autoConnect,
      toolCount: 0,
    });

    // Auto-connect if requested
    if (data.autoConnect && data.enabled) {
      try {
        await mcpClientManager.connect(server);
        await storage.updateMcpServer(server.id, {
          toolCount: mcpClientManager.getTools(data.name).length,
          lastConnectedAt: new Date(),
        });
      } catch (err) {
        console.warn(`[mcp] Auto-connect failed for "${data.name}":`, err);
      }
    }

    return res.status(201).json({ ...server, env: undefined });
  });

  /** PUT /api/mcp/servers/:id — update a server config */
  app.put("/api/mcp/servers/:id", async (req, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid server id" });

    const parse = updateMcpServerSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: parse.error.flatten() });
    }

    const existing = await storage.getMcpServer(id);
    if (!existing) return res.status(404).json({ error: "Server not found" });

    const updated = await storage.updateMcpServer(id, parse.data);
    return res.json({ ...updated, env: undefined });
  });

  /** DELETE /api/mcp/servers/:id — delete a server config */
  app.delete("/api/mcp/servers/:id", async (req, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid server id" });

    const server = await storage.getMcpServer(id);
    if (!server) return res.status(404).json({ error: "Server not found" });

    // Disconnect if connected
    await mcpClientManager.disconnect(server.name);
    await storage.deleteMcpServer(id);
    res.status(204).end();
  });

  /** POST /api/mcp/servers/:id/connect — connect to a server */
  app.post("/api/mcp/servers/:id/connect", async (req, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid server id" });

    const server = await storage.getMcpServer(id);
    if (!server) return res.status(404).json({ error: "Server not found" });
    if (!server.enabled) return res.status(400).json({ error: "Server is disabled" });

    try {
      await mcpClientManager.connect(server);
      const toolCount = mcpClientManager.getTools(server.name).length;
      await storage.updateMcpServer(id, { toolCount, lastConnectedAt: new Date() });
      return res.json({ connected: true, toolCount });
    } catch (err) {
      const message = (err as Error).message;
      return res.status(500).json({ connected: false, error: message });
    }
  });

  /** POST /api/mcp/servers/:id/disconnect — disconnect from a server */
  app.post("/api/mcp/servers/:id/disconnect", async (req, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid server id" });

    const server = await storage.getMcpServer(id);
    if (!server) return res.status(404).json({ error: "Server not found" });

    await mcpClientManager.disconnect(server.name);
    return res.json({ connected: false });
  });

  /** GET /api/mcp/servers/:id/tools — list tools from a specific server */
  app.get("/api/mcp/servers/:id/tools", async (req, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid server id" });

    const server = await storage.getMcpServer(id);
    if (!server) return res.status(404).json({ error: "Server not found" });

    const tools = mcpClientManager.getTools(server.name);
    return res.json(tools);
  });
}
