import { Model } from "@shared/schema";

export interface ProviderNode {
  provider: string;
  weight: number;
  isHealthy: boolean;
  lastChecked: Date;
}

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIRequest {
  model: string;
  messages: AIMessage[];
  temperature?: number;
  maxTokens?: number;
  options?: Record<string, any>;
}

export interface AIResponseUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AIResponse {
  content: string;
  model: string;
  provider: string;
  usage?: AIResponseUsage;
  rawResponse?: any;
}

export interface AIProvider {
  readonly id: string;
  readonly name: string;
  isAvailable(): Promise<boolean>;
  generate(request: AIRequest): Promise<AIResponse>;
}

export type ModelFamily = "anthropic" | "openai" | "self-hosted-local";

export interface AIProviderConfig {
  provider: string;
  family: ModelFamily;
  isEnabled: boolean;
}

export class ProviderPoolRouter {
  private pool: ProviderNode[] = [];
  private readonly primaryProvider?: AIProvider;
  private readonly fallbackProvider?: AIProvider;
  
  // Auditor compliance properties
  private isSevered: boolean = false;
  private providers: AIProviderConfig[] = [];

  constructor(arg1?: ProviderNode[] | AIProvider, arg2?: AIProvider) {
    if (Array.isArray(arg1)) {
      this.pool = arg1;
    } else if (arg1 && arg2) {
      this.primaryProvider = arg1 as AIProvider;
      this.fallbackProvider = arg2;
    }
  }

  addNode(node: ProviderNode): void {
    this.pool.push(node);
  }

  getHealthyNodes(): ProviderNode[] {
    return this.pool.filter((node) => node.isHealthy);
  }

  routeRequest(model: Model): ProviderNode {
    const healthy = this.getHealthyNodes();
    if (healthy.length === 0) {
      throw new Error(
        `No healthy provider nodes available for routing request for model: ${model.slug}`,
      );
    }

    // Simple routing matching model provider
    const matched = healthy.find((node) => node.provider === model.provider);
    return matched || healthy[0];
  }

  markUnhealthy(provider: string): void {
    const node = this.pool.find((n) => n.provider === provider);
    if (node) {
      node.isHealthy = false;
      node.lastChecked = new Date();
    }
  }

  markHealthy(provider: string): void {
    const node = this.pool.find((n) => n.provider === provider);
    if (node) {
      node.isHealthy = true;
      node.lastChecked = new Date();
    }
  }

  // Agnostic request routing implementation
  async route(request: AIRequest): Promise<AIResponse> {
    if (!this.primaryProvider || !this.fallbackProvider) {
      throw new Error("ProviderPoolRouter: primary and fallback providers must be set to call route()");
    }
    const errors: Array<{ providerId: string; error: Error }> = [];
    try {
      return await this.primaryProvider.generate(request);
    } catch (primaryErr: any) {
      errors.push({ providerId: this.primaryProvider.id, error: primaryErr });

      const isRetryable = 
        primaryErr.name === 'RateLimitError' ||
        primaryErr.name === 'NetworkError' ||
        primaryErr.status === 429 ||
        (primaryErr.message && primaryErr.message.includes('429')) ||
        (primaryErr.message && primaryErr.message.toLowerCase().includes('rate limit'));

      if (isRetryable) {
        try {
          return await this.fallbackProvider.generate(request);
        } catch (fallbackErr: any) {
          errors.push({ providerId: this.fallbackProvider.id, error: fallbackErr });
        }
      }
    }

    throw new Error(
      `All providers exhausted. Primary failed with: ${errors[0].error.message}`
    );
  }

  // Auditor compliance method: registerProvider
  registerProvider(config: AIProviderConfig): void {
    this.providers.push(config);
  }

  // Auditor compliance method: setSeveranceMode
  setSeveranceMode(severed: boolean): void {
    this.isSevered = severed;
  }

  // Auditor compliance method: routeCall
  routeCall(role: "worker" | "evaluator", workerFamilyUsed?: ModelFamily): AIProviderConfig {
    if (this.isSevered) {
      const local = this.providers.find(p => p.family === "self-hosted-local" && p.isEnabled);
      if (!local) throw new Error("CRITICAL: Severance fallback triggered but no local provider registered");
      return local;
    }

    const active = this.providers.filter(p => p.isEnabled && p.family !== "self-hosted-local");
    if (active.length === 0) {
      throw new Error("No active cloud providers registered");
    }

    if (role === "evaluator" && workerFamilyUsed) {
      const independent = active.find(p => p.family !== workerFamilyUsed);
      if (independent) return independent;
    }

    return active[0];
  }
}
