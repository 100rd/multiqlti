import Anthropic from "@anthropic-ai/sdk";
import type { ILLMProvider, ILLMProviderOptions, ProviderMessage, ToolCall } from "@shared/types";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Returns true for errors that warrant a single retry. */
function isRetryable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as Error & { status?: number; code?: string }).status;
  const errCode = (e as Error & { code?: string }).code;
  if (code !== undefined && (code === 502 || code === 503 || code === 504)) return true;
  if (errCode !== undefined && ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(errCode)) return true;
  if (e.name === "TimeoutError") return true;
  return false;
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isRetryable(e)) {
      console.warn(`[claude] Retrying after error: ${(e as Error).message} (${label})`);
      return fn();
    }
    throw e;
  }
}

/** Convert our ProviderMessage format to Anthropic messages format. */
function toAnthropicMessages(
  messages: ProviderMessage[],
): Array<Anthropic.Messages.MessageParam> {
  const result: Anthropic.Messages.MessageParam[] = [];

  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "tool") {
      // Tool results go into a user message with tool_result content
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: m.content,
          } as Anthropic.Messages.ToolResultBlockParam,
        ],
      });
      continue;
    }

    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      // Assistant with tool calls
      const content: Anthropic.Messages.ContentBlock[] = [];
      if (m.content) {
        content.push({ type: "text", text: m.content } as Anthropic.Messages.TextBlock);
      }
      for (const tc of m.toolCalls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        } as Anthropic.Messages.ToolUseBlock);
      }
      result.push({ role: "assistant", content });
      continue;
    }

    result.push({
      role: m.role as "user" | "assistant",
      content: m.content,
    });
  }

  return result;
}

export class ClaudeProvider implements ILLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({
      apiKey,
      timeout: DEFAULT_TIMEOUT_MS,
    });
  }

  /**
   * Anthropic requires the system prompt to be extracted from the messages array
   * and passed as a top-level `system` parameter. Any message with role "system"
   * is extracted; remaining messages are forwarded as-is.
   */
  private extractSystem(messages: ProviderMessage[]): {
    system: string | undefined;
    messages: Array<Anthropic.Messages.MessageParam>;
  } {
    const systemParts = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");

    return {
      system: systemParts.length > 0 ? systemParts : undefined,
      messages: toAnthropicMessages(messages),
    };
  }

  async complete(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): Promise<{ content: string; tokensUsed: number; toolCalls?: ToolCall[]; finishReason?: 'stop' | 'tool_use' }> {
    const { system, messages: msgs } = this.extractSystem(messages);

    // Build tools array for Anthropic API if provided
    const anthropicTools: Anthropic.Messages.Tool[] | undefined =
      options?.tools && options.tools.length > 0
        ? options.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Messages.Tool['input_schema'],
          }))
        : undefined;

    const toolChoice: Anthropic.Messages.ToolChoiceAuto | Anthropic.Messages.ToolChoiceNone | Anthropic.Messages.ToolChoiceAny | undefined =
      anthropicTools
        ? options?.toolChoice === "none"
          ? { type: "none" }
          : options?.toolChoice === "required"
          ? { type: "any" }
          : { type: "auto" }
        : undefined;

    const response = await withRetry(
      () =>
        this.client.messages.create({
          model: modelId,
          max_tokens: options?.maxTokens ?? 4096,
          temperature: options?.temperature ?? 0.7,
          ...(system ? { system } : {}),
          messages: msgs,
          ...(anthropicTools ? { tools: anthropicTools } : {}),
          ...(toolChoice ? { tool_choice: toolChoice } : {}),
        }),
      `complete/${modelId}`,
    );

    const textContent = response.content
      .filter((block): block is Anthropic.Messages.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    // Extract tool calls from response
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use",
    );

    const toolCalls: ToolCall[] = toolUseBlocks.map((block) => ({
      id: block.id,
      name: block.name,
      arguments: block.input as Record<string, unknown>,
    }));

    const finishReason: 'stop' | 'tool_use' =
      response.stop_reason === "tool_use" ? "tool_use" : "stop";

    return {
      content: textContent,
      tokensUsed: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
    };
  }

  async *stream(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): AsyncGenerator<string> {
    const { system, messages: msgs } = this.extractSystem(messages);

    // Streaming via SDK — retry not feasible mid-stream; retry on initial connect only
    let stream: Awaited<ReturnType<typeof this.client.messages.stream>>;
    try {
      stream = this.client.messages.stream({
        model: modelId,
        max_tokens: options?.maxTokens ?? 4096,
        temperature: options?.temperature ?? 0.7,
        ...(system ? { system } : {}),
        messages: msgs,
      });
    } catch (e) {
      if (isRetryable(e)) {
        console.warn(`[claude] Retrying stream after error: ${(e as Error).message}`);
        stream = this.client.messages.stream({
          model: modelId,
          max_tokens: options?.maxTokens ?? 4096,
          temperature: options?.temperature ?? 0.7,
          ...(system ? { system } : {}),
          messages: msgs,
        });
      } else {
        throw e;
      }
    }

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }
  }
}
