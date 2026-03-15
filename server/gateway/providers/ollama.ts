export interface RemoteModel {
  id: string;
  name: string;
  provider: "ollama";
  size?: number;
  parameterSize?: string;
  quantization?: string;
  family?: string;
}

export class OllamaProvider {
  constructor(private baseUrl: string) {}

  /** Fetch available models from Ollama /api/tags endpoint */
  async listModels(): Promise<RemoteModel[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    if (!res.ok) {
      throw new Error(`Ollama list models error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      models: Array<{
        name: string;
        model: string;
        size: number;
        details?: {
          parameter_size?: string;
          quantization_level?: string;
          family?: string;
        };
      }>;
    };
    return (data.models ?? []).map((m) => ({
      id: m.model ?? m.name,
      name: m.name,
      provider: "ollama" as const,
      size: m.size,
      parameterSize: m.details?.parameter_size,
      quantization: m.details?.quantization_level,
      family: m.details?.family,
    }));
  }

  async complete(
    model: string,
    messages: Array<{ role: string; content: string }>,
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<{ content: string; tokensUsed: number; finishReason?: "stop" | "tool_use" }> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          num_predict: options?.maxTokens ?? 4096,
          temperature: options?.temperature ?? 0.7,
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      message: { content: string };
      eval_count?: number;
      prompt_eval_count?: number;
    };

    return {
      content: data.message?.content ?? "",
      tokensUsed: (data.eval_count ?? 0) + (data.prompt_eval_count ?? 0),
      finishReason: "stop" as const,
    };
  }

  async *stream(
    model: string,
    messages: Array<{ role: string; content: string }>,
    options?: { maxTokens?: number; temperature?: number },
  ): AsyncGenerator<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: {
          num_predict: options?.maxTokens ?? 4096,
          temperature: options?.temperature ?? 0.7,
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama stream error ${res.status}: ${text}`);
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
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line) as {
            message?: { content: string };
            done: boolean;
          };
          if (chunk.message?.content) yield chunk.message.content;
          if (chunk.done) return;
        } catch {
          // skip malformed lines
        }
      }
    }
  }
}
