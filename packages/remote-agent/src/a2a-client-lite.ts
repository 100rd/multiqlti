import { randomUUID } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AgentCardLite {
  name: string;
  description: string;
  version: string;
  url: string;
  capabilities?: { streaming?: boolean };
  skills?: Array<{ id: string; name: string; description: string }>;
}

export interface A2ATaskSendParams {
  message: { role: string; parts: Array<{ type: string; text: string }> };
  skill?: string;
  taskId?: string;
}

export interface A2ATaskResponse {
  id: string;
  status: string;
  output?: { role: string; parts: Array<{ type: string; text?: string }> };
  error?: string;
}

export interface A2AClientLiteConfig {
  endpoint: string;
  authToken?: string;
  timeoutMs?: number;
}

// ─── Client ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Lightweight A2A client for peer-to-peer agent communication.
 * Supports discovery and task dispatch only (no streaming).
 */
export class A2AClient {
  private readonly endpoint: string;
  private readonly authToken?: string;
  private readonly timeoutMs: number;

  constructor(config: A2AClientLiteConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.authToken = config.authToken;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** GET /.well-known/agent.json -- discover peer capabilities. */
  async discover(): Promise<AgentCardLite> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.endpoint}/.well-known/agent.json`, {
        method: "GET",
        headers: this.headers(),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`A2A discovery failed: HTTP ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as AgentCardLite;
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /a2a with method "message/send" -- dispatch a task to peer. */
  async sendTask(params: A2ATaskSendParams): Promise<A2ATaskResponse> {
    const rpcParams: Record<string, unknown> = {
      message: params.message,
    };
    if (params.skill !== undefined) rpcParams.skill = params.skill;
    if (params.taskId !== undefined) rpcParams.id = params.taskId;

    const resp = await this.rpc("message/send", rpcParams);

    if (resp.error) {
      throw new Error(`A2A sendTask RPC error (${resp.error.code}): ${resp.error.message}`);
    }

    return resp.result as A2ATaskResponse;
  }

  /** POST /a2a with method "tasks/get" -- query task status. */
  async getTask(taskId: string): Promise<A2ATaskResponse> {
    const resp = await this.rpc("tasks/get", { id: taskId });

    if (resp.error) {
      throw new Error(`A2A getTask RPC error (${resp.error.code}): ${resp.error.message}`);
    }

    return resp.result as A2ATaskResponse;
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const body: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params,
    };

    try {
      const response = await fetch(`${this.endpoint}/a2a`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`A2A RPC failed: HTTP ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as JsonRpcResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) {
      h["Authorization"] = `Bearer ${this.authToken}`;
    }
    return h;
  }
}
