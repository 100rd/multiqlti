import type { AgentCard, A2AMessage, A2APart } from "@shared/types";
import { randomUUID } from "crypto";

// ─── JSON-RPC Types ──────────────────────────────────────────────────────────

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

// ─── A2A Types ───────────────────────────────────────────────────────────────

export interface A2ATaskSendParams {
  skill?: string;
  message: A2AMessage;
  taskId?: string;
}

export interface A2ATaskResponse {
  id: string;
  status: string;
  output?: A2AMessage;
  error?: string;
}

export interface A2AStreamEvent {
  type: "status" | "artifact" | "error";
  taskId: string;
  status?: string;
  artifact?: A2APart;
  error?: string;
}

export interface A2AClientConfig {
  endpoint: string;
  authToken?: string;
  timeoutMs?: number;
}

// ─── Client ──────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;

export class A2AClient {
  private readonly endpoint: string;
  private readonly authToken?: string;
  private readonly timeoutMs: number;

  constructor(config: A2AClientConfig) {
    // Strip trailing slash for consistent URL building
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.authToken = config.authToken;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Discovery -- GET /.well-known/agent.json
   * Returns the remote agent's AgentCard describing its capabilities and skills.
   */
  async discover(): Promise<AgentCard> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(
        `${this.endpoint}/.well-known/agent.json`,
        {
          method: "GET",
          headers: this.headers(),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(
          `A2A discovery failed: HTTP ${response.status} ${response.statusText}`,
        );
      }

      return (await response.json()) as AgentCard;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Task dispatch -- POST /a2a with method "message/send"
   * Sends a message to the remote agent and waits for the task result.
   */
  async sendTask(params: A2ATaskSendParams): Promise<A2ATaskResponse> {
    const rpcParams: Record<string, unknown> = {
      message: params.message,
    };
    if (params.skill !== undefined) rpcParams.skill = params.skill;
    if (params.taskId !== undefined) rpcParams.id = params.taskId;

    const resp = await this.rpc("message/send", rpcParams);

    if (resp.error) {
      throw new Error(
        `A2A sendTask RPC error (${resp.error.code}): ${resp.error.message}`,
      );
    }

    return resp.result as A2ATaskResponse;
  }

  /**
   * Streaming task -- POST /a2a with method "message/stream"
   * Yields SSE events as the remote agent produces artifacts.
   */
  async *streamTask(
    params: A2ATaskSendParams,
  ): AsyncGenerator<A2AStreamEvent> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const rpcParams: Record<string, unknown> = {
      message: params.message,
    };
    if (params.skill !== undefined) rpcParams.skill = params.skill;
    if (params.taskId !== undefined) rpcParams.id = params.taskId;

    const body: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message/stream",
      params: rpcParams,
    };

    try {
      const response = await fetch(`${this.endpoint}/a2a`, {
        method: "POST",
        headers: {
          ...this.headers(),
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `A2A streamTask failed: HTTP ${response.status} ${response.statusText}`,
        );
      }

      if (!response.body) {
        throw new Error("A2A streamTask: response body is null");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep incomplete last line in buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;

          if (trimmed.startsWith("data:")) {
            const jsonStr = trimmed.slice("data:".length).trim();
            if (!jsonStr) continue;

            try {
              const event = JSON.parse(jsonStr) as A2AStreamEvent;
              yield event;
            } catch {
              // Skip malformed SSE data lines
            }
          }
        }
      }

      // Process any remaining buffer content
      if (buffer.trim().startsWith("data:")) {
        const jsonStr = buffer.trim().slice("data:".length).trim();
        if (jsonStr) {
          try {
            const event = JSON.parse(jsonStr) as A2AStreamEvent;
            yield event;
          } catch {
            // Skip malformed final SSE line
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Get task status -- POST /a2a with method "tasks/get"
   */
  async getTask(taskId: string): Promise<A2ATaskResponse> {
    const resp = await this.rpc("tasks/get", { id: taskId });

    if (resp.error) {
      throw new Error(
        `A2A getTask RPC error (${resp.error.code}): ${resp.error.message}`,
      );
    }

    return resp.result as A2ATaskResponse;
  }

  /**
   * Cancel task -- POST /a2a with method "tasks/cancel"
   */
  async cancelTask(taskId: string): Promise<A2ATaskResponse> {
    const resp = await this.rpc("tasks/cancel", { id: taskId });

    if (resp.error) {
      throw new Error(
        `A2A cancelTask RPC error (${resp.error.code}): ${resp.error.message}`,
      );
    }

    return resp.result as A2ATaskResponse;
  }

  /**
   * Internal: send a JSON-RPC 2.0 request to the /a2a endpoint.
   */
  private async rpc(
    method: string,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
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
        throw new Error(
          `A2A RPC failed: HTTP ${response.status} ${response.statusText}`,
        );
      }

      return (await response.json()) as JsonRpcResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Internal: build common request headers.
   */
  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.authToken) {
      h["Authorization"] = `Bearer ${this.authToken}`;
    }
    return h;
  }
}
