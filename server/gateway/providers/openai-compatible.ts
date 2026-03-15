import type { ILLMProvider, ILLMProviderOptions, ProviderMessage, ToolCall } from "@shared/types";

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIChoice {
  message: { content: string | null; tool_calls?: OpenAIToolCall[] };
  finish_reason: string;
}

interface OpenAIStreamChunk {
  choices: Array<{ delta: { content?: string } }>;
}

const RETRYABLE_CODES = new Set([502, 503, 504]);
const RETRYABLE_ERRORS = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"]);

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal });
      if (res.ok || !RETRYABLE_CODES.has(res.status)) {
        return res;
      }
      const text = await res.text();
      lastError = new Error(`HTTP ${res.status}: ${text}`);
      if (attempt === 0) {
        console.warn(`[openai-compatible] Retrying after ${res.status} on ${url}`);
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      const isRetryable =
        e.name === "TimeoutError" ||
        (e.code !== undefined && RETRYABLE_ERRORS.has(e.code));
      lastError = e;
      if (attempt === 0 && isRetryable) {
        console.warn(`[openai-compatible] Retrying after network error: ${e.message}`);
        continue;
      }
      throw e;
    }
  }

  throw lastError ?? new Error("Request failed after retry");
}

/** Convert ProviderMessage[] to OpenAI chat messages format. */
function toOpenAIMessages(messages: ProviderMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content,
      };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export class OpenAICompatibleProvider implements ILLMProvider {
  constructor(
    protected readonly baseUrl: string,
    protected readonly apiKey: string | null = null,
    protected readonly defaultTimeout: number = 30_000,
  ) {}

  protected buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async complete(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): Promise<{ content: string; tokensUsed: number; toolCalls?: ToolCall[]; finishReason?: 'stop' | 'tool_use' }> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeout;

    // Build tools array for OpenAI API if provided
    const openAiTools =
      options?.tools && options.tools.length > 0
        ? options.tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            },
          }))
        : undefined;

    const toolChoice =
      openAiTools
        ? options?.toolChoice === "none"
          ? "none"
          : options?.toolChoice === "required"
          ? "required"
          : "auto"
        : undefined;

    const body: Record<string, unknown> = {
      model: modelId,
      messages: toOpenAIMessages(messages),
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
      stream: false,
    };

    if (openAiTools) {
      body.tools = openAiTools;
      body.tool_choice = toolChoice;
    }

    const res = await fetchWithRetry(
      `${this.baseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      },
      timeoutMs,
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${this.baseUrl} error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      choices: OpenAIChoice[];
      usage: { total_tokens: number };
    };

    const choice = data.choices[0];
    const content = choice?.message?.content ?? "";
    const finishReason: 'stop' | 'tool_use' =
      choice?.finish_reason === "tool_calls" ? "tool_use" : "stop";

    // Extract tool calls if any
    const rawToolCalls = choice?.message?.tool_calls ?? [];
    const toolCalls: ToolCall[] = rawToolCalls.map((tc) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        args = { _raw: tc.function.arguments };
      }
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: args,
      };
    });

    return {
      content,
      tokensUsed: data.usage?.total_tokens ?? 0,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
    };
  }

  async *stream(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): AsyncGenerator<string> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeout;
    const res = await fetchWithRetry(
      `${this.baseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model: modelId,
          messages: toOpenAIMessages(messages),
          max_tokens: options?.maxTokens ?? 4096,
          temperature: options?.temperature ?? 0.7,
          stream: true,
        }),
      },
      timeoutMs,
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${this.baseUrl} stream error ${res.status}: ${text}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") return;

        try {
          const chunk = JSON.parse(payload) as OpenAIStreamChunk;
          const content = chunk.choices[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  }
}
