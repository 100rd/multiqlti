import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export interface AgentToolHandler {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<{ content: string }>;
}

interface AgentConfig {
  name: string;
  description: string;
  version: string;
  port: number;
}

export abstract class BaseAgent {
  protected tools: Map<string, AgentToolHandler> = new Map();
  private server: Server | null = null;
  private readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  /** Subclasses register their tools here. */
  protected abstract setupTools(): void;

  /** Register a tool that this agent exposes. */
  protected registerTool(tool: AgentToolHandler): void {
    this.tools.set(tool.name, tool);
  }

  /** Start the HTTP server. */
  async start(): Promise<void> {
    this.setupTools();
    this.server = createServer((req, res) => this.handleRequest(req, res));
    return new Promise((resolve) => {
      this.server!.listen(this.config.port, "0.0.0.0", () => {
        console.log(`[${this.config.name}] listening on :${this.config.port}`);
        resolve();
      });
    });
  }

  /** Stop the HTTP server gracefully. */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${this.config.port}`);

    try {
      // GET /.well-known/agent.json — A2A Discovery
      if (req.method === "GET" && url.pathname === "/.well-known/agent.json") {
        return this.handleAgentCard(res);
      }

      // POST /a2a — A2A JSON-RPC
      if (req.method === "POST" && url.pathname === "/a2a") {
        return await this.handleA2A(req, res);
      }

      // GET /healthz — Health check
      if (req.method === "GET" && url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", agent: this.config.name, tools: this.tools.size }));
        return;
      }

      // GET /mcp — MCP SSE endpoint (tool listing)
      if (req.method === "GET" && url.pathname === "/mcp") {
        return this.handleMcpList(res);
      }

      res.writeHead(404);
      res.end("Not Found");
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }));
    }
  }

  private handleAgentCard(res: ServerResponse): void {
    const card = {
      name: this.config.name,
      description: this.config.description,
      version: this.config.version,
      url: `http://localhost:${this.config.port}`,
      capabilities: { streaming: false },
      skills: Array.from(this.tools.values()).map((t) => ({
        id: t.name,
        name: t.name,
        description: t.description,
      })),
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(card));
  }

  private async handleA2A(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const rpc = JSON.parse(body);

    // Validate Bearer token if AUTH_TOKEN is set
    const expectedToken = process.env.AUTH_TOKEN;
    if (expectedToken) {
      const authHeader = req.headers.authorization ?? "";
      if (authHeader !== `Bearer ${expectedToken}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32600, message: "Unauthorized" },
          }),
        );
        return;
      }
    }

    if (rpc.method === "message/send") {
      const result = await this.executeTask(rpc.params);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      return;
    }

    if (rpc.method === "tasks/get") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: "Stateless agent — tasks/get not supported" },
        }),
      );
      return;
    }

    if (rpc.method === "tasks/cancel") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: "Stateless agent — tasks/cancel not supported" },
        }),
      );
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: "Method not found" },
      }),
    );
  }

  private async executeTask(params: {
    message: { parts: Array<{ text?: string }> };
    skill?: string;
  }): Promise<{
    id: string;
    status: string;
    output?: { role: string; parts: Array<{ type: string; text: string }> };
  }> {
    const taskId = randomUUID();
    const inputText = params.message.parts
      .map((p) => p.text ?? "")
      .join("\n")
      .trim();

    // Route to specific tool if skill specified
    if (params.skill && this.tools.has(params.skill)) {
      const tool = this.tools.get(params.skill)!;
      const result = await tool.handler({ input: inputText });
      return {
        id: taskId,
        status: "completed",
        output: { role: "agent", parts: [{ type: "text", text: result.content }] },
      };
    }

    // Default: use the default handler
    const result = await this.executeDefaultHandler(inputText);
    return {
      id: taskId,
      status: "completed",
      output: { role: "agent", parts: [{ type: "text", text: result }] },
    };
  }

  /** Default handler routes to the first registered tool. Subclasses may override. */
  protected async executeDefaultHandler(input: string): Promise<string> {
    const firstTool = this.tools.values().next().value;
    if (!firstTool) return "No tools registered";
    const result = await firstTool.handler({ input });
    return result.content;
  }

  private handleMcpList(res: ServerResponse): void {
    const tools = Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: "object", properties: { input: { type: "string" } } },
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tools }));
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString()));
      req.on("error", reject);
    });
  }
}
