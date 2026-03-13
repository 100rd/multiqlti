import type { IStorage } from "../storage";
import type { GatewayRequest, GatewayResponse } from "@shared/types";
import { MockProvider } from "./providers/mock";
import { VllmProvider } from "./providers/vllm";
import { OllamaProvider } from "./providers/ollama";

export class Gateway {
  private mockProvider: MockProvider;
  private vllmProvider: VllmProvider | null;
  private ollamaProvider: OllamaProvider | null;

  constructor(private storage: IStorage) {
    this.mockProvider = new MockProvider();

    const vllmEndpoint = process.env.VLLM_ENDPOINT;
    this.vllmProvider = vllmEndpoint ? new VllmProvider(vllmEndpoint) : null;

    const ollamaEndpoint = process.env.OLLAMA_ENDPOINT;
    this.ollamaProvider = ollamaEndpoint
      ? new OllamaProvider(ollamaEndpoint)
      : null;
  }

  async complete(request: GatewayRequest): Promise<GatewayResponse> {
    const model = await this.storage.getModelBySlug(request.modelSlug);
    const provider = model?.provider ?? "mock";
    const modelName = model?.name ?? request.modelSlug;

    let result: { content: string; tokensUsed: number };

    if (provider === "vllm" && this.vllmProvider && model?.endpoint) {
      result = await this.vllmProvider.complete(modelName, request.messages, {
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      });
    } else if (
      provider === "ollama" &&
      this.ollamaProvider &&
      model?.endpoint
    ) {
      result = await this.ollamaProvider.complete(modelName, request.messages, {
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      });
    } else {
      result = await this.mockProvider.complete(request.messages, {
        maxTokens: request.maxTokens,
      });
    }

    return {
      content: result.content,
      tokensUsed: result.tokensUsed,
      modelSlug: request.modelSlug,
      finishReason: "stop",
    };
  }

  async *stream(request: GatewayRequest): AsyncGenerator<string> {
    const model = await this.storage.getModelBySlug(request.modelSlug);
    const provider = model?.provider ?? "mock";
    const modelName = model?.name ?? request.modelSlug;

    if (provider === "vllm" && this.vllmProvider && model?.endpoint) {
      yield* this.vllmProvider.stream(modelName, request.messages, {
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      });
    } else if (
      provider === "ollama" &&
      this.ollamaProvider &&
      model?.endpoint
    ) {
      yield* this.ollamaProvider.stream(modelName, request.messages, {
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      });
    } else {
      yield* this.mockProvider.stream(request.messages);
    }
  }

  getStatus() {
    return {
      vllm: !!this.vllmProvider,
      ollama: !!this.ollamaProvider,
      vllmEndpoint: process.env.VLLM_ENDPOINT ?? null,
      ollamaEndpoint: process.env.OLLAMA_ENDPOINT ?? null,
    };
  }

  /** Discover models from all connected providers */
  async discoverModels(): Promise<{
    vllm: { available: boolean; models: any[]; error?: string };
    ollama: { available: boolean; models: any[]; error?: string };
  }> {
    const results = {
      vllm: { available: !!this.vllmProvider, models: [] as any[], error: undefined as string | undefined },
      ollama: { available: !!this.ollamaProvider, models: [] as any[], error: undefined as string | undefined },
    };

    if (this.vllmProvider) {
      try {
        results.vllm.models = await this.vllmProvider.listModels();
      } catch (e) {
        results.vllm.error = (e as Error).message;
      }
    }

    if (this.ollamaProvider) {
      try {
        results.ollama.models = await this.ollamaProvider.listModels();
      } catch (e) {
        results.ollama.error = (e as Error).message;
      }
    }

    return results;
  }

  /** Discover models from a custom endpoint (one-off probe) */
  async discoverFromEndpoint(
    endpoint: string,
    providerType: "vllm" | "ollama",
  ): Promise<any[]> {
    if (providerType === "vllm") {
      const p = new VllmProvider(endpoint);
      return p.listModels();
    } else {
      const p = new OllamaProvider(endpoint);
      return p.listModels();
    }
  }
}
