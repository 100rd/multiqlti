import type { IStorage } from "../storage";
import type { GatewayRequest, GatewayResponse, ILLMProvider, PrivacySettings } from "@shared/types";
import { MockProvider } from "./providers/mock";
import { VllmProvider } from "./providers/vllm";
import { OllamaProvider } from "./providers/ollama";
import { ClaudeProvider } from "./providers/claude";
import { GeminiProvider } from "./providers/gemini";
import { GrokProvider } from "./providers/grok";
import { AnonymizerService } from "../privacy/anonymizer";

export interface GatewayPrivacyOptions {
  privacy?: PrivacySettings;
  sessionId?: string;
}

type CloudProviderKey = "anthropic" | "google" | "xai";

export class Gateway {
  private registry: Map<string, ILLMProvider>;
  private mockProvider: MockProvider;
  private anonymizer: AnonymizerService;

  constructor(private storage: IStorage) {
    this.registry = new Map();
    this.mockProvider = new MockProvider();
    this.anonymizer = new AnonymizerService();

    // Self-hosted: endpoint-gated
    if (process.env.VLLM_ENDPOINT) {
      this.registry.set("vllm", new VllmProvider(process.env.VLLM_ENDPOINT));
    }
    if (process.env.OLLAMA_ENDPOINT) {
      this.registry.set("ollama", new OllamaProvider(process.env.OLLAMA_ENDPOINT));
    }

    // Cloud: API-key-gated (env vars; DB keys loaded later via loadDbKeys())
    if (process.env.ANTHROPIC_API_KEY) {
      this.registry.set("anthropic", new ClaudeProvider(process.env.ANTHROPIC_API_KEY));
    }
    if (process.env.GOOGLE_API_KEY) {
      this.registry.set("google", new GeminiProvider(process.env.GOOGLE_API_KEY));
    }
    if (process.env.XAI_API_KEY) {
      this.registry.set("xai", new GrokProvider(process.env.XAI_API_KEY));
    }
  }

  /**
   * Load provider keys from DB, registering any providers not already set via env vars.
   * Called once at startup after DB is available.
   */
  async loadDbKeys(dbKeys: Map<string, string>): Promise<void> {
    for (const [provider, apiKey] of dbKeys.entries()) {
      // Env var takes precedence — don't overwrite
      if (this.registry.has(provider)) continue;
      await this.reloadProvider(provider as CloudProviderKey, apiKey);
    }
  }

  /**
   * Hot-reload a cloud provider with a new API key (or null to remove it).
   * Called when the user saves or deletes a key via the settings UI.
   */
  async reloadProvider(provider: CloudProviderKey, apiKey: string | null): Promise<void> {
    if (!apiKey) {
      // Only remove if not backed by env var
      const envVars: Record<CloudProviderKey, string> = {
        anthropic: "ANTHROPIC_API_KEY",
        google: "GOOGLE_API_KEY",
        xai: "XAI_API_KEY",
      };
      if (!process.env[envVars[provider]]) {
        this.registry.delete(provider);
      }
      return;
    }

    switch (provider) {
      case "anthropic":
        this.registry.set("anthropic", new ClaudeProvider(apiKey));
        break;
      case "google":
        this.registry.set("google", new GeminiProvider(apiKey));
        break;
      case "xai":
        this.registry.set("xai", new GrokProvider(apiKey));
        break;
    }
  }

  /** Resolve the ILLMProvider for a model record's provider string. */
  private getProvider(providerKey: string): ILLMProvider | null {
    return this.registry.get(providerKey) ?? null;
  }

  private shouldAnonymize(privacy?: PrivacySettings): boolean {
    return !!(privacy?.enabled && privacy.level !== "off");
  }

  async complete(
    request: GatewayRequest,
    privacyOptions?: GatewayPrivacyOptions,
  ): Promise<GatewayResponse> {
    const model = await this.storage.getModelBySlug(request.modelSlug);
    const providerKey = model?.provider ?? "mock";
    const modelId = model?.modelId ?? model?.name ?? request.modelSlug;

    const provider = this.getProvider(providerKey);

    const privacy = privacyOptions?.privacy;
    const sessionId = privacyOptions?.sessionId ?? crypto.randomUUID();

    let messages = request.messages;
    if (this.shouldAnonymize(privacy)) {
      messages = request.messages.map((m) => ({
        ...m,
        content: this.anonymizer.anonymize(
          m.content,
          sessionId,
          privacy!.level,
          privacy!.vaultTtlMs,
        ).anonymizedText,
      }));
    }

    let result: { content: string; tokensUsed: number };
    if (provider) {
      result = await provider.complete(modelId, messages, {
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      });
    } else {
      result = await this.mockProvider.complete(messages, {
        maxTokens: request.maxTokens,
      });
    }

    const content = this.shouldAnonymize(privacy)
      ? this.anonymizer.rehydrate(result.content, sessionId)
      : result.content;

    return {
      content,
      tokensUsed: result.tokensUsed,
      modelSlug: request.modelSlug,
      finishReason: "stop",
    };
  }

  async *stream(
    request: GatewayRequest,
    privacyOptions?: GatewayPrivacyOptions,
  ): AsyncGenerator<string> {
    const model = await this.storage.getModelBySlug(request.modelSlug);
    const providerKey = model?.provider ?? "mock";
    const modelId = model?.modelId ?? model?.name ?? request.modelSlug;

    const provider = this.getProvider(providerKey);

    const privacy = privacyOptions?.privacy;
    const sessionId = privacyOptions?.sessionId ?? crypto.randomUUID();

    let messages = request.messages;
    if (this.shouldAnonymize(privacy)) {
      messages = request.messages.map((m) => ({
        ...m,
        content: this.anonymizer.anonymize(
          m.content,
          sessionId,
          privacy!.level,
          privacy!.vaultTtlMs,
        ).anonymizedText,
      }));
    }

    if (provider) {
      yield* provider.stream(modelId, messages, {
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      });
    } else {
      yield* this.mockProvider.stream(messages);
    }
    // Note: streaming rehydration is not applied chunk-by-chunk because
    // pseudonyms may span chunk boundaries. Callers that need rehydration
    // should accumulate chunks and call anonymizer.rehydrate() on the full response.
  }

  getAnonymizer(): AnonymizerService {
    return this.anonymizer;
  }

  getStatus() {
    return {
      vllm: this.registry.has("vllm"),
      ollama: this.registry.has("ollama"),
      anthropic: this.registry.has("anthropic"),
      google: this.registry.has("google"),
      xai: this.registry.has("xai"),
      vllmEndpoint: process.env.VLLM_ENDPOINT ?? null,
      ollamaEndpoint: process.env.OLLAMA_ENDPOINT ?? null,
    };
  }

  async discoverModels(): Promise<Record<string, { available: boolean; models: unknown[]; error?: string }>> {
    const results: Record<string, { available: boolean; models: unknown[]; error?: string }> = {};

    for (const [key, provider] of this.registry.entries()) {
      results[key] = { available: true, models: [] };
      if ("listModels" in provider && typeof (provider as unknown as { listModels: unknown }).listModels === "function") {
        try {
          results[key].models = await (provider as unknown as { listModels: () => Promise<unknown[]> }).listModels();
        } catch (e) {
          results[key].error = (e as Error).message;
        }
      }
    }

    return results;
  }

  async discoverFromEndpoint(
    endpoint: string,
    providerType: "vllm" | "ollama",
  ): Promise<unknown[]> {
    if (providerType === "vllm") return new VllmProvider(endpoint).listModels();
    return new OllamaProvider(endpoint).listModels();
  }
}
