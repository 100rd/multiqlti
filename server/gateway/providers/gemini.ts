import {
  GoogleGenerativeAI,
  type Content,
  type GenerateContentStreamResult,
} from "@google/generative-ai";
import type { ILLMProvider, ILLMProviderOptions, ProviderMessage } from "@shared/types";

export class GeminiProvider implements ILLMProvider {
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  /**
   * Gemini uses "model" for the assistant role (not "assistant").
   * System messages are handled via systemInstruction on the model config.
   */
  private mapMessages(messages: ProviderMessage[]): {
    systemInstruction: string | undefined;
    history: Content[];
  } {
    const systemParts = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");

    const history: Content[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    return {
      systemInstruction: systemParts.length > 0 ? systemParts : undefined,
      history,
    };
  }

  async complete(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): Promise<{ content: string; tokensUsed: number }> {
    const { systemInstruction, history } = this.mapMessages(messages);

    // The last message must be the user turn; it's sent via sendMessage
    const lastMessage = history.pop();
    if (!lastMessage) throw new Error("GeminiProvider: no user message");

    const model = this.client.getGenerativeModel({
      model: modelId,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        maxOutputTokens: options?.maxTokens ?? 4096,
        temperature: options?.temperature ?? 0.7,
      },
    });

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(
      lastMessage.parts.map((p) => p.text ?? "").join(""),
    );

    const response = result.response;
    const content = response.text();
    const tokensUsed = response.usageMetadata?.totalTokenCount ?? 0;

    return { content, tokensUsed };
  }

  async *stream(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): AsyncGenerator<string> {
    const { systemInstruction, history } = this.mapMessages(messages);

    const lastMessage = history.pop();
    if (!lastMessage) throw new Error("GeminiProvider: no user message");

    const model = this.client.getGenerativeModel({
      model: modelId,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        maxOutputTokens: options?.maxTokens ?? 4096,
        temperature: options?.temperature ?? 0.7,
      },
    });

    const chat = model.startChat({ history });
    const result: GenerateContentStreamResult = await chat.sendMessageStream(
      lastMessage.parts.map((p) => p.text ?? "").join(""),
    );

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) yield text;
    }
  }
}
