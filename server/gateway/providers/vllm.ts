import { OpenAICompatibleProvider } from "./openai-compatible";

export interface RemoteModel {
  id: string;
  name: string;
  provider: "vllm";
  contextLength?: number;
  owned_by?: string;
}

export class VllmProvider extends OpenAICompatibleProvider {
  constructor(baseUrl: string) {
    super(baseUrl, null); // vLLM: no API key header
  }

  async listModels(): Promise<RemoteModel[]> {
    const res = await fetch(`${this.baseUrl}/v1/models`);
    if (!res.ok) {
      throw new Error(`vLLM list models error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      data: Array<{ id: string; object: string; owned_by?: string; max_model_len?: number }>;
    };
    return (data.data ?? []).map((m) => ({
      id: m.id,
      name: m.id,
      provider: "vllm" as const,
      contextLength: m.max_model_len,
      owned_by: m.owned_by,
    }));
  }
}
