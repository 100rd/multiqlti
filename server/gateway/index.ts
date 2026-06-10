import type { IStorage } from "../storage";
import { toolRegistry } from "../tools/index";
import type { GatewayRequest, GatewayResponse, ILLMProvider, IStreamingToolProvider, ILLMProviderOptions, PrivacySettings, ProviderMessage, ProviderStreamEvent, StreamingStageOptions, ToolCall, ToolDefinition, ToolCallLogEntry } from "@shared/types";
import { MockProvider } from "./providers/mock";
import { scrubAndTruncate } from "./secret-scrub";
import { VllmProvider } from "./providers/vllm";
import { OllamaProvider } from "./providers/ollama";
import { ClaudeProvider } from "./providers/claude";
import { ClaudeCliProvider } from "./providers/claude-cli";
import { GeminiProvider } from "./providers/gemini";
import { AntigravityProvider } from "./providers/antigravity";
import { DEFAULT_ANTIGRAVITY_MODEL, DEFAULT_ANTIGRAVITY_TIMEOUT_MS } from "./providers/antigravity-cli";
import { GrokProvider } from "./providers/grok";
import { LmStudioProvider } from "./providers/lmstudio";
import { AnonymizerService } from "../privacy/anonymizer";
import { estimateCostUsd } from "@shared/constants";
import { configLoader } from "../config/loader";
import { CostService } from "../services/cost-service";

/**
 * Provider visibility allowlist (TEMPORARY — see the tracking GitHub issue).
 * Only the subscription-CLI providers are surfaced to the chat model list and
 * the gateway status: Claude (the "anthropic" CLI provider) and Antigravity
 * (registered under "antigravity" and mirrored onto "google"). The local
 * providers (vllm / ollama / lmstudio) and the billed cloud APIs (xai, the
 * Gemini API) are HIDDEN until they are properly wired up.
 *
 * This ONLY gates what `discoverModels()` / `getStatus()` expose — provider
 * registration is left fully intact, so re-enabling is a one-line change:
 * widen this set in a follow-up PR.
 */
export const VISIBLE_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  "anthropic",
  "antigravity",
  "google",
]);

export interface GatewayPrivacyOptions {
  privacy?: PrivacySettings;
  sessionId?: string;
}

export interface GatewayLoggingOptions {
  runId?: string;
  stageExecutionId?: string;
  teamId?: string;
  /** Workspace context for cost ledger recording and budget checks. */
  workspaceId?: string;
  /** Stage identifier for ledger granularity. */
  stageId?: string;
}

type CloudProviderKey = "anthropic" | "google" | "xai";

export class Gateway {
  private registry: Map<string, ILLMProvider>;
  private mockProvider: MockProvider;
  private anonymizer: AnonymizerService;
  private costService: CostService;

  constructor(private storage: IStorage) {
    this.costService = new CostService(storage);
    this.registry = new Map();
    this.mockProvider = new MockProvider();
    this.anonymizer = new AnonymizerService();

    const providers = configLoader.get().providers;

    // Self-hosted: endpoint-gated
    if (providers.vllm.endpoint) {
      this.registry.set("vllm", new VllmProvider(providers.vllm.endpoint));
    }
    if (providers.ollama.endpoint) {
      this.registry.set("ollama", new OllamaProvider(providers.ollama.endpoint));
    }

    // LM Studio: endpoint-gated
    const lmStudioEndpoint = (providers as Record<string, { endpoint?: string }>).lmstudio?.endpoint;
    if (lmStudioEndpoint) {
      this.registry.set("lmstudio", new LmStudioProvider(lmStudioEndpoint));
    }

    // Anthropic: CLI subscription by default (0 API tokens). The paid API path
    // is opt-in via providers.anthropic.mode === "api" AND a configured apiKey.
    this.registerAnthropic(providers.anthropic.apiKey);
    // Antigravity (local, subscription-backed) replaces the cloud Gemini API.
    // When enabled it is registered under "antigravity" AND mirrored onto the
    // "google" provider key so existing Gemini-routed models run locally with
    // zero Gemini API-token spend. The billed Gemini API path is only used when
    // Antigravity is explicitly disabled and a google.apiKey is present.
    if (providers.antigravity?.enabled) {
      const antigravity = new AntigravityProvider({
        binPath: providers.antigravity.binPath,
        defaultModel: providers.antigravity.model ?? DEFAULT_ANTIGRAVITY_MODEL,
        timeoutMs: providers.antigravity.timeoutMs ?? DEFAULT_ANTIGRAVITY_TIMEOUT_MS,
      });
      this.registry.set("antigravity", antigravity);
      this.registry.set("google", antigravity);
    } else if (providers.google.apiKey) {
      this.registry.set("google", new GeminiProvider(providers.google.apiKey));
    }
    if (providers.xai.apiKey) {
      this.registry.set("xai", new GrokProvider(providers.xai.apiKey));
    }
  }

  /**
   * Register the Anthropic provider under the "anthropic" key.
   *
   * Default = CLI subscription (ClaudeCliProvider) → 0 API tokens, no Anthropic
   * SDK instantiated, ANTHROPIC_API_KEY not required. The paid API provider
   * (ClaudeProvider via @anthropic-ai/sdk) is used ONLY when both
   * providers.anthropic.mode === "api" and an apiKey are present. This keeps the
   * SDK out of the default hot path entirely.
   */
  private registerAnthropic(apiKey: string | null | undefined): void {
    const mode = configLoader.get().providers.anthropic.mode;
    if (mode === "api" && apiKey) {
      this.registry.set("anthropic", new ClaudeProvider(apiKey));
      return;
    }
    this.registry.set("anthropic", new ClaudeCliProvider());
  }

  /**
   * Load provider keys from DB, registering any providers not already set via config.
   * Called once at startup after DB is available.
   */
  async loadDbKeys(dbKeys: Map<string, string>): Promise<void> {
    for (const [provider, apiKey] of dbKeys.entries()) {
      // Config value takes precedence — don't overwrite
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
      // Anthropic always falls back to the CLI subscription provider — it needs
      // no API key, so it is never removed, only downgraded from API → CLI.
      if (provider === "anthropic") {
        this.registerAnthropic(null);
        return;
      }
      // Other providers: only remove if not backed by a config value.
      const providers = configLoader.get().providers;
      const configKeys: Record<CloudProviderKey, string | undefined> = {
        anthropic: providers.anthropic.apiKey,
        google: providers.google.apiKey,
        xai: providers.xai.apiKey,
      };
      const antigravityOwnsGoogle =
        provider === "google" && providers.antigravity?.enabled;
      if (!configKeys[provider] && !antigravityOwnsGoogle) {
        this.registry.delete(provider);
      }
      return;
    }

    switch (provider) {
      case "anthropic":
        this.registerAnthropic(apiKey);
        break;
      case "google":
        // Ignore Gemini API keys while Antigravity owns the "google" key —
        // the local subscription path must not be replaced by the billed API.
        if (!configLoader.get().providers.antigravity?.enabled) {
          this.registry.set("google", new GeminiProvider(apiKey));
        }
        break;
      case "xai":
        this.registry.set("xai", new GrokProvider(apiKey));
        break;
    }
  }

  /**
   * Register (or re-register) the LM Studio provider with the given endpoint.
   * Called from lmstudio route handlers when user connects or changes endpoint.
   */
  connectLmStudio(endpoint: string): void {
    this.registry.set("lmstudio", new LmStudioProvider(endpoint));
  }

  /**
   * Register a provider under an explicit key. General-purpose seam (mirrors
   * connectLmStudio) used by streaming tests and any caller that constructs a
   * provider instance directly.
   */
  registerProvider(key: string, provider: ILLMProvider): void {
    this.registry.set(key, provider);
  }

  /** Resolve the ILLMProvider for a model record's provider string. */
  private getProvider(providerKey: string): ILLMProvider | null {
    return this.registry.get(providerKey) ?? null;
  }

  /**
   * Resolve the provider key (e.g. "anthropic", "google", "xai") for a
   * given model slug.  Useful for computing provider diversity without making
   * a full LLM call.  Returns "mock" if the model is unknown.
   */
  async resolveProvider(modelSlug: string): Promise<string> {
    const model = await this.storage.getModelBySlug(modelSlug);
    return model?.provider ?? "mock";
  }

  private shouldAnonymize(privacy?: PrivacySettings): boolean {
    return !!(privacy?.enabled && privacy.level !== "off");
  }

  /**
   * Extract system prompt from messages array (for logging — does NOT mutate).
   */
  private extractSystemPrompt(messages: ProviderMessage[]): string | undefined {
    const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
    return systemParts.length > 0 ? systemParts.join("\n") : undefined;
  }

  /**
   * Log an LLM request to storage. Errors here are swallowed so they never
   * interrupt actual pipeline execution.
   */
  private async logRequest(params: {
    modelSlug: string;
    providerKey: string;
    messages: ProviderMessage[];
    options?: ILLMProviderOptions & GatewayLoggingOptions;
    result?: { content: string; tokensUsed: number; inputTokens?: number; outputTokens?: number };
    latencyMs: number;
    status: 'success' | 'error';
    errorMessage?: string;
  }): Promise<void> {
    try {
      const inputTokens = params.result?.inputTokens ?? 0;
      const outputTokens = params.result?.outputTokens ?? 0;
      const totalTokens = params.result?.tokensUsed ?? 0;
      const costUsd = estimateCostUsd(params.modelSlug, inputTokens, outputTokens);

      await this.storage.createLlmRequest({
        runId: params.options?.runId ?? null,
        stageExecutionId: params.options?.stageExecutionId ?? null,
        modelSlug: params.modelSlug,
        provider: params.providerKey,
        messages: params.messages as unknown as Record<string, unknown>[],
        systemPrompt: this.extractSystemPrompt(params.messages),
        temperature: params.options?.temperature ?? null,
        maxTokens: params.options?.maxTokens ?? null,
        responseContent: params.result?.content ?? "",
        inputTokens,
        outputTokens,
        totalTokens,
        latencyMs: params.latencyMs,
        estimatedCostUsd: costUsd > 0 ? costUsd : null,
        status: params.status,
        errorMessage: params.errorMessage ?? null,
        teamId: params.options?.teamId ?? null,
        tags: [],
      });
    } catch (logErr) {
      console.warn("[gateway] Failed to log LLM request:", logErr);
    }
  }

  async complete(
    request: GatewayRequest,
    privacyOptions?: GatewayPrivacyOptions,
    loggingOptions?: GatewayLoggingOptions,
  ): Promise<GatewayResponse> {
    const model = await this.storage.getModelBySlug(request.modelSlug);
    // Explicit provider/modelId (live-discovered CLI models) win over the DB row.
    const providerKey = request.provider ?? model?.provider ?? "mock";
    const modelId = request.modelId ?? model?.modelId ?? model?.name ?? request.modelSlug;

    const provider = this.getProvider(providerKey);

    const privacy = privacyOptions?.privacy;
    const sessionId = privacyOptions?.sessionId ?? crypto.randomUUID();

    let messages: ProviderMessage[] = request.messages as ProviderMessage[];
    if (this.shouldAnonymize(privacy)) {
      messages = request.messages.map((m) => ({
        ...m,
        content: this.anonymizer.anonymize(
          m.content,
          sessionId,
          privacy!.level,
          privacy!.vaultTtlMs,
        ).anonymizedText,
      })) as unknown as ProviderMessage[];
    }

    // ── Budget pre-call check ──────────────────────────────────────────────
    if (loggingOptions?.workspaceId) {
      const budgetCheck = await this.costService.checkBudget({
        workspaceId: loggingOptions.workspaceId,
        provider: providerKey,
        model: request.modelSlug,
        estimatedPromptTokens: request.messages.reduce(
          (sum, m) => sum + Math.ceil((m.content as string).length / 4),
          0,
        ),
        estimatedCompletionTokens: request.maxTokens ?? 500,
      });

      if (budgetCheck.warning) {
        console.warn("[gateway] Budget check:", budgetCheck.warning);
      }

      if (!budgetCheck.allowed) {
        throw new Error(`[budget-exceeded] ${budgetCheck.warning}`);
      }
    }

    const start = Date.now();
    let result: { content: string; tokensUsed: number };
    try {
      if (provider) {
        result = await provider.complete(modelId, messages, {
          maxTokens: request.maxTokens,
          temperature: request.temperature,
          // Security C1: forward abort signal + per-call timeout so a hung/aborted
          // turn (debate, orchestrator) actually cancels the underlying request.
          signal: request.signal,
          timeoutMs: request.timeoutMs,
        });
      } else {
        result = await this.mockProvider.complete(messages, {
          maxTokens: request.maxTokens,
        });
      }
    } catch (err) {
      const latencyMs = Date.now() - start;
      await this.logRequest({
        modelSlug: request.modelSlug,
        providerKey,
        messages,
        options: { ...request, ...loggingOptions },
        latencyMs,
        status: 'error',
        errorMessage: String(err),
      });
      throw err;
    }

    const latencyMs = Date.now() - start;
    const content = this.shouldAnonymize(privacy)
      ? this.anonymizer.rehydrate(result.content, sessionId)
      : result.content;

    await this.logRequest({
      modelSlug: request.modelSlug,
      providerKey,
      messages,
      options: { ...request, ...loggingOptions },
      result: { content, tokensUsed: result.tokensUsed, inputTokens: 0, outputTokens: 0 },
      latencyMs,
      status: 'success',
    });

    // ── Cost ledger recording ────────────────────────────────────────────────
    if (loggingOptions?.workspaceId) {
      // Fire-and-forget: fail-closed semantics are inside recordCost
      void this.costService.recordCost({
        workspaceId: loggingOptions.workspaceId,
        provider: providerKey,
        model: request.modelSlug,
        pipelineRunId: loggingOptions.runId ?? null,
        stageId: loggingOptions.stageId ?? null,
        promptTokens: 0,        // real token counts not available at this level
        completionTokens: result.tokensUsed,
      });
    }

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
    // Explicit provider/modelId (live-discovered CLI models) win over the DB row.
    const providerKey = request.provider ?? model?.provider ?? "mock";
    const modelId = request.modelId ?? model?.modelId ?? model?.name ?? request.modelSlug;

    const provider = this.getProvider(providerKey);

    const privacy = privacyOptions?.privacy;
    const sessionId = privacyOptions?.sessionId ?? crypto.randomUUID();

    let messages: ProviderMessage[] = request.messages as ProviderMessage[];
    if (this.shouldAnonymize(privacy)) {
      messages = request.messages.map((m) => ({
        ...m,
        content: this.anonymizer.anonymize(
          m.content,
          sessionId,
          privacy!.level,
          privacy!.vaultTtlMs,
        ).anonymizedText,
      })) as unknown as ProviderMessage[];
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

  /**
   * Test a cloud provider's API key by making a minimal real call directly to
   * the registered provider instance — bypasses model-slug DB lookup which
   * would otherwise fall back to MockProvider for unknown slugs.
   */
  async testProvider(providerKey: string): Promise<void> {
    const provider = this.registry.get(providerKey);
    if (!provider) throw new Error("Provider not configured");

    const testModelIds: Record<string, string> = {
      anthropic: "claude-haiku-4-5-20251001",
      google: "gemini-1.5-flash",
      xai: "grok-beta",
    };

    const modelId = testModelIds[providerKey] ?? providerKey;
    await provider.complete(modelId, [{ role: "user", content: "ping" }], { maxTokens: 5 });
  }

  getStatus() {
    // A provider is reported "available" only when it is BOTH registered and on
    // the visibility allowlist (VISIBLE_PROVIDER_KEYS). Hidden providers report
    // false + null endpoints so no UI surfaces them. Reversible — see the const.
    const visible = (key: string): boolean =>
      VISIBLE_PROVIDER_KEYS.has(key) && this.registry.has(key);
    const endpointFor = (key: string, endpoint: string | null | undefined): string | null =>
      VISIBLE_PROVIDER_KEYS.has(key) ? endpoint ?? null : null;
    const providers = configLoader.get().providers;
    const lmStudioProvider = this.registry.get("lmstudio") as LmStudioProvider | undefined;
    return {
      vllm: visible("vllm"),
      ollama: visible("ollama"),
      anthropic: visible("anthropic"),
      google: visible("google"),
      xai: visible("xai"),
      antigravity: visible("antigravity"),
      lmstudio: visible("lmstudio"),
      vllmEndpoint: endpointFor("vllm", providers.vllm.endpoint),
      ollamaEndpoint: endpointFor("ollama", providers.ollama.endpoint),
      lmstudioEndpoint: endpointFor("lmstudio", lmStudioProvider?.endpoint),
    };
  }

  async discoverModels(): Promise<Record<string, { available: boolean; models: unknown[]; error?: string }>> {
    const results: Record<string, { available: boolean; models: unknown[]; error?: string }> = {};
    // Some provider instances are registered under multiple keys (e.g. the
    // Antigravity provider is mirrored onto "google"). Cache by instance so we
    // only spawn the CLI once and reuse the result across its aliases.
    const cache = new Map<ILLMProvider, { models: unknown[]; error?: string }>();

    for (const [key, provider] of this.registry.entries()) {
      // Hidden providers (not on the visibility allowlist) are omitted entirely
      // so the chat model list only offers the subscription-CLI providers.
      if (!VISIBLE_PROVIDER_KEYS.has(key)) continue;
      results[key] = { available: true, models: [] };
      if ("listModels" in provider && typeof (provider as unknown as { listModels: unknown }).listModels === "function") {
        const cached = cache.get(provider);
        if (cached) {
          results[key].models = cached.models;
          if (cached.error) results[key].error = cached.error;
          continue;
        }
        try {
          const models = await (provider as unknown as { listModels: () => Promise<unknown[]> }).listModels();
          results[key].models = models;
          cache.set(provider, { models });
        } catch (e) {
          const error = (e as Error).message;
          results[key].error = error;
          cache.set(provider, { models: [], error });
        }
      }
    }

    return results;
  }


  /**
   * Agentic tool loop: calls provider with tools, executes tool calls, feeds results back.
   * Loops up to maxIterations (default 10) until provider stops calling tools.
   */
  async completeWithTools(params: {
    modelSlug: string;
    /** Explicit provider key — wins over the DB lookup (live-discovered models). */
    provider?: string;
    /** Explicit provider-native model id/label — wins over the DB lookup. */
    modelId?: string;
    messages: ProviderMessage[];
    tools: ToolDefinition[];
    options?: ILLMProviderOptions;
    maxIterations?: number;
    /**
     * Optional defaults injected into every tool call's `arguments` (issue #343).
     * Used so that workspace-aware tools (file-read, code-search, knowledge-search)
     * can default to the run's bound workspace without the LLM having to specify
     * it. Explicit args from the LLM still win — defaults only fill missing keys.
     */
    workspaceDefaults?: { workspaceId?: string; workspacePath?: string };
  }): Promise<{ content: string; tokensUsed: number; toolCallLog: ToolCallLogEntry[] }> {
    const { modelSlug, tools, options, workspaceDefaults } = params;
    const maxIterations = params.maxIterations ?? 10;
    const toolCallLog: ToolCallLogEntry[] = [];

    const model = await this.storage.getModelBySlug(modelSlug);
    // Explicit provider/modelId (live-discovered CLI models) win over the DB row.
    const providerKey = params.provider ?? model?.provider ?? 'mock';
    const modelId = params.modelId ?? model?.modelId ?? model?.name ?? modelSlug;
    const provider = this.getProvider(providerKey);

    let messages: ProviderMessage[] = [...params.messages];
    let totalTokensUsed = 0;
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      let result: { content: string; tokensUsed: number; toolCalls?: import('@shared/types').ToolCall[]; finishReason?: 'stop' | 'tool_use' };

      if (provider) {
        result = await provider.complete(modelId, messages, {
          ...options,
          tools,
          toolChoice: options?.toolChoice ?? 'auto',
        });
      } else {
        const mockResult = await this.mockProvider.complete(
          messages.map((m) => ({ role: m.role, content: 'content' in m ? m.content : '' })),
          options,
        );
        result = { ...mockResult, finishReason: 'stop' as const };
      }

      totalTokensUsed += result.tokensUsed;

      // If no tool calls or provider says stop, we're done
      if (!result.toolCalls || result.toolCalls.length === 0 || result.finishReason !== 'tool_use') {
        return { content: result.content, tokensUsed: totalTokensUsed, toolCallLog };
      }

      // Append assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: result.content,
        toolCalls: result.toolCalls,
      });

      // Execute each tool call and collect results
      for (const call of result.toolCalls) {
        // Apply workspace defaults — only when the LLM didn't already supply
        // the key. Explicit args win.
        if (workspaceDefaults) {
          const merged = { ...call.arguments };
          if (workspaceDefaults.workspaceId !== undefined && merged.workspaceId === undefined) {
            merged.workspaceId = workspaceDefaults.workspaceId;
          }
          if (workspaceDefaults.workspacePath !== undefined && merged.workspacePath === undefined) {
            merged.workspacePath = workspaceDefaults.workspacePath;
          }
          call.arguments = merged;
        }
        const callStart = Date.now();
        const toolResult = await toolRegistry.execute(call);
        const durationMs = Date.now() - callStart;

        toolCallLog.push({
          iteration,
          call,
          result: toolResult,
          durationMs,
        });

        // Append tool result message
        messages.push({
          role: 'tool',
          toolCallId: toolResult.toolCallId,
          content: toolResult.content,
        });
      }
    }

    // Max iterations reached — return final content from last assistant message
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    const content = lastAssistant && 'content' in lastAssistant ? lastAssistant.content : '';
    return { content, tokensUsed: totalTokensUsed, toolCallLog };
  }


  // ─── Streaming stage execution (streaming-stage-execution) ──────────────────

  /** Cap (bytes) on the assembled streamed text, mirroring the CLI byte cap. */
  private static readonly DEFAULT_STREAM_MAX_BYTES = 8 * 1024 * 1024;

  /** Resolve provider key + native model id for a request (shared by complete*). */
  private resolveTarget(
    modelSlug: string,
    explicitProvider: string | undefined,
    explicitModelId: string | undefined,
    model: { provider?: string; modelId?: string | null; name?: string } | undefined,
  ): { providerKey: string; modelId: string; provider: ILLMProvider | null } {
    const providerKey = explicitProvider ?? model?.provider ?? "mock";
    const modelId = explicitModelId ?? model?.modelId ?? model?.name ?? modelSlug;
    return { providerKey, modelId, provider: this.getProvider(providerKey) };
  }

  /** Apply anonymization to messages when privacy is enabled (no mutation). */
  private maybeAnonymize(
    messages: ProviderMessage[],
    privacy: PrivacySettings | undefined,
    sessionId: string,
  ): ProviderMessage[] {
    if (!this.shouldAnonymize(privacy)) return messages;
    return messages.map((m) => ({
      ...m,
      content: this.anonymizer.anonymize(
        (m as { content: string }).content,
        sessionId,
        privacy!.level,
        privacy!.vaultTtlMs,
      ).anonymizedText,
    })) as unknown as ProviderMessage[];
  }

  /** Budget pre-call check (throws on hard-block). Shared with complete(). */
  private async budgetPreCheck(
    request: { modelSlug: string; maxTokens?: number; messages: ReadonlyArray<{ content: string }> },
    providerKey: string,
    workspaceId: string | undefined,
  ): Promise<void> {
    if (!workspaceId) return;
    const budgetCheck = await this.costService.checkBudget({
      workspaceId,
      provider: providerKey,
      model: request.modelSlug,
      estimatedPromptTokens: request.messages.reduce(
        (sum, m) => sum + Math.ceil(((m as { content: string }).content ?? "").length / 4),
        0,
      ),
      estimatedCompletionTokens: request.maxTokens ?? 500,
    });
    if (budgetCheck.warning) console.warn("[gateway] Budget check:", budgetCheck.warning);
    if (!budgetCheck.allowed) throw new Error(`[budget-exceeded] ${budgetCheck.warning}`);
  }

  /** Invoke an onDelta callback without letting its errors break the stream. */
  private safeOnDelta(
    onDelta: StreamingStageOptions["onDelta"],
    delta: string,
    cumulativeChars: number,
  ): void {
    if (!onDelta) return;
    try {
      onDelta(delta, cumulativeChars);
    } catch (cbErr) {
      console.warn("[gateway] stage onDelta callback threw (ignored):", cbErr);
    }
  }

  /**
   * Streaming-aware sibling of complete(). Consumes provider.stream(), assembles
   * the full content from deltas (bounded), and surfaces idle/overall/byte-cap/
   * abort/non-zero failures by REJECTING (never a partial success). Records
   * usage and logs success+error exactly like complete().
   */
  async completeStreaming(
    request: GatewayRequest,
    privacyOptions?: GatewayPrivacyOptions,
    loggingOptions?: GatewayLoggingOptions,
    streamOptions?: StreamingStageOptions,
  ): Promise<GatewayResponse> {
    const model = await this.storage.getModelBySlug(request.modelSlug);
    const { providerKey, modelId, provider } = this.resolveTarget(
      request.modelSlug,
      request.provider,
      request.modelId,
      model,
    );

    const privacy = privacyOptions?.privacy;
    const sessionId = privacyOptions?.sessionId ?? crypto.randomUUID();
    const messages = this.maybeAnonymize(request.messages as ProviderMessage[], privacy, sessionId);

    await this.budgetPreCheck(request, providerKey, loggingOptions?.workspaceId);

    const maxBytes = streamOptions?.maxOutputBytes ?? Gateway.DEFAULT_STREAM_MAX_BYTES;
    const providerOpts: ILLMProviderOptions = {
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: streamOptions?.signal,
      idleTimeoutMs: streamOptions?.idleTimeoutMs,
      timeoutMs: streamOptions?.overallTimeoutMs,
      maxOutputBytes: maxBytes,
    };

    const start = Date.now();
    let assembled = "";
    let assembledBytes = 0;
    try {
      const iter = provider
        ? provider.stream(modelId, messages, providerOpts)
        : this.mockProvider.stream(messages);
      for await (const delta of iter) {
        assembledBytes += Buffer.byteLength(delta);
        if (assembledBytes > maxBytes) {
          throw new Error(`Assembled stream output exceeded ${maxBytes} bytes`);
        }
        assembled += delta;
        this.safeOnDelta(streamOptions?.onDelta, delta, assembled.length);
      }
    } catch (err) {
      const latencyMs = Date.now() - start;
      await this.logRequest({
        modelSlug: request.modelSlug,
        providerKey,
        messages,
        options: { ...request, ...loggingOptions },
        latencyMs,
        status: "error",
        errorMessage: scrubAndTruncate(String(err)),
      });
      throw err;
    }

    const latencyMs = Date.now() - start;
    const content = this.shouldAnonymize(privacy)
      ? this.anonymizer.rehydrate(assembled, sessionId)
      : assembled;
    // Streamed text deltas do not carry per-chunk token counts; estimate from
    // assembled length so the cost ledger never silently records zero.
    const tokensUsed = Math.max(1, Math.ceil(content.length / 4));

    await this.logRequest({
      modelSlug: request.modelSlug,
      providerKey,
      messages,
      options: { ...request, ...loggingOptions },
      result: { content, tokensUsed, inputTokens: 0, outputTokens: tokensUsed },
      latencyMs,
      status: "success",
    });

    if (loggingOptions?.workspaceId) {
      void this.costService.recordCost({
        workspaceId: loggingOptions.workspaceId,
        provider: providerKey,
        model: request.modelSlug,
        pipelineRunId: loggingOptions.runId ?? null,
        stageId: loggingOptions.stageId ?? null,
        promptTokens: 0,
        completionTokens: tokensUsed,
      });
    }

    return { content, tokensUsed, modelSlug: request.modelSlug, finishReason: "stop" };
  }

  /** Duck-typed check: does the provider expose a streamEvents tool channel? */
  private supportsStreamingToolLoop(
    provider: ILLMProvider | null,
  ): provider is ILLMProvider & IStreamingToolProvider {
    return (
      provider !== null &&
      typeof (provider as unknown as { streamEvents?: unknown }).streamEvents === "function"
    );
  }

  /**
   * Validate a streamed/unvalidated tool call's args against the tool's declared
   * parameters + a bound size BEFORE executing (Security C1 — toolRegistry does
   * NOT validate). For the enabled CLI providers this is moot (no multiqlti
   * tool-calls), but the guard is implemented in the tool-loop path regardless.
   */
  private validateToolCallArgs(call: ToolCall, tools: ToolDefinition[]): void {
    const def = tools.find((t) => t.name === call.name);
    if (!def) {
      throw new Error(`[tool-validation] Unknown tool "${call.name}" requested by model`);
    }
    const serialized = JSON.stringify(call.arguments ?? {});
    if (serialized.length > 64 * 1024) {
      throw new Error(`[tool-validation] Tool "${call.name}" arguments exceed 64KiB`);
    }
    const schema = def.inputSchema as { properties?: Record<string, unknown> } | undefined;
    if (schema?.properties && call.arguments) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(call.arguments)) {
        // Permit workspace defaults injected by the caller.
        if (key === "workspaceId" || key === "workspacePath") continue;
        if (!allowed.has(key)) {
          throw new Error(
            `[tool-validation] Tool "${call.name}" got unexpected argument "${key}"`,
          );
        }
      }
    }
  }

  /**
   * Streaming-aware tool loop. Each assistant turn is obtained via the
   * provider's streamEvents channel; tool-use events are executed via
   * toolRegistry (with C1 arg validation + workspace-default merge) and fed
   * back. Providers without a streamEvents channel fall back to the blocking
   * completeWithTools under the overall cap. maxIterations is honored.
   */
  async completeWithToolsStreaming(
    params: {
      modelSlug: string;
      provider?: string;
      modelId?: string;
      messages: ProviderMessage[];
      tools: ToolDefinition[];
      options?: ILLMProviderOptions;
      maxIterations?: number;
      workspaceDefaults?: { workspaceId?: string; workspacePath?: string };
    },
    streamOptions?: StreamingStageOptions,
  ): Promise<{ content: string; tokensUsed: number; toolCallLog: ToolCallLogEntry[] }> {
    const { tools, options, workspaceDefaults } = params;
    const maxIterations = params.maxIterations ?? 10;
    const toolCallLog: ToolCallLogEntry[] = [];

    const model = await this.storage.getModelBySlug(params.modelSlug);
    const { modelId, provider } = this.resolveTarget(
      params.modelSlug,
      params.provider,
      params.modelId,
      model,
    );

    // Capability fallback: no streamEvents → blocking tool loop under overall cap.
    if (!this.supportsStreamingToolLoop(provider)) {
      return this.completeWithTools({
        ...params,
        options: {
          ...options,
          timeoutMs: streamOptions?.overallTimeoutMs ?? options?.timeoutMs,
        },
      });
    }

    const providerOpts: ILLMProviderOptions = {
      ...options,
      tools,
      toolChoice: options?.toolChoice ?? "auto",
      signal: streamOptions?.signal,
      idleTimeoutMs: streamOptions?.idleTimeoutMs,
      timeoutMs: streamOptions?.overallTimeoutMs ?? options?.timeoutMs,
      maxOutputBytes: streamOptions?.maxOutputBytes,
    };

    const messages: ProviderMessage[] = [...params.messages];
    let totalTokensUsed = 0;
    let cumulativeChars = 0;
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;
      let turnText = "";
      const pendingToolCalls: ToolCall[] = [];
      let finishReason: "stop" | "tool_use" = "stop";

      for await (const event of provider.streamEvents(modelId, messages, providerOpts)) {
        if (event.kind === "text-delta") {
          turnText += event.text;
          cumulativeChars += event.text.length;
          this.safeOnDelta(streamOptions?.onDelta, event.text, cumulativeChars);
        } else if (event.kind === "tool-call") {
          pendingToolCalls.push(event.call);
        } else {
          totalTokensUsed += event.tokensUsed;
          finishReason = event.finishReason;
        }
      }

      if (finishReason !== "tool_use" || pendingToolCalls.length === 0) {
        return { content: turnText, tokensUsed: totalTokensUsed, toolCallLog };
      }

      messages.push({ role: "assistant", content: turnText, toolCalls: pendingToolCalls });

      for (const call of pendingToolCalls) {
        const merged = { ...call.arguments };
        if (workspaceDefaults) {
          if (workspaceDefaults.workspaceId !== undefined && merged.workspaceId === undefined) {
            merged.workspaceId = workspaceDefaults.workspaceId;
          }
          if (workspaceDefaults.workspacePath !== undefined && merged.workspacePath === undefined) {
            merged.workspacePath = workspaceDefaults.workspacePath;
          }
        }
        const validatedCall: ToolCall = { ...call, arguments: merged };
        this.validateToolCallArgs(validatedCall, tools);

        const callStart = Date.now();
        const toolResult = await toolRegistry.execute(validatedCall);
        const durationMs = Date.now() - callStart;
        toolCallLog.push({ iteration, call: validatedCall, result: toolResult, durationMs });
        messages.push({ role: "tool", toolCallId: toolResult.toolCallId, content: toolResult.content });
      }
    }

    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const content = lastAssistant && "content" in lastAssistant ? lastAssistant.content : "";
    return { content, tokensUsed: totalTokensUsed, toolCallLog };
  }

  async discoverFromEndpoint(
    endpoint: string,
    providerType: "vllm" | "ollama" | "lmstudio",
  ): Promise<unknown[]> {
    if (providerType === "vllm") return new VllmProvider(endpoint).listModels();
    if (providerType === "lmstudio") return new LmStudioProvider(endpoint).listModels();
    return new OllamaProvider(endpoint).listModels();
  }
}
