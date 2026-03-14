import Anthropic from "@anthropic-ai/sdk";
import type { ILLMProvider, ILLMProviderOptions, ProviderMessage } from "@shared/types";

export class ClaudeProvider implements ILLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
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

    const response = await this.client.messages.create({
      model: modelId,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
      ...(system ? { system } : {}),
      messages: msgs,
    });

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

    const stream = this.client.messages.stream({
      model: modelId,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
      ...(system ? { system } : {}),
      messages: msgs,
    });

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
