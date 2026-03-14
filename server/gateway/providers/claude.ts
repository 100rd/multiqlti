import Anthropic from "@anthropic-ai/sdk";
import type { ILLMProvider, ILLMProviderOptions, ProviderMessage } from "@shared/types";

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
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  } {
    const systemParts = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");

    const conversationMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    return {
      system: systemParts.length > 0 ? systemParts : undefined,
      messages: conversationMessages,
    };
  }

  async complete(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): Promise<{ content: string; tokensUsed: number }> {
    const { system, messages: msgs } = this.extractSystem(messages);

    const response = await withRetry(
      () =>
        this.client.messages.create({
          model: modelId,
          max_tokens: options?.maxTokens ?? 4096,
          temperature: options?.temperature ?? 0.7,
          ...(system ? { system } : {}),
          messages: msgs,
        }),
      `complete/${modelId}`,
    );

    const content = response.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { type: "text"; text: string }).text)
      .join("");

    return {
      content,
      tokensUsed: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
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
