import type { Gateway } from "../gateway/index";
import type { WsManager } from "../ws/manager";
import type { TeamConfig, StageContext, TeamResult, ExecutionStrategy, ProviderMessage } from "@shared/types";
import { StrategyExecutor } from "../services/strategy-executor";

export abstract class BaseTeam {
  private strategyExecutor: StrategyExecutor;

  constructor(
    protected gateway: Gateway,
    protected config: TeamConfig,
    protected wsManager?: WsManager,
  ) {
    // WsManager may be injected later for backwards compat — create executor lazily
    this.strategyExecutor = wsManager
      ? new StrategyExecutor(gateway, wsManager)
      : createNoOpStrategyExecutor(gateway);
  }

  abstract buildPrompt(
    input: Record<string, unknown>,
    context: StageContext,
  ): Array<{ role: string; content: string }>;

  abstract parseOutput(rawOutput: string): Record<string, unknown>;

  async execute(
    input: Record<string, unknown>,
    context: StageContext,
    executionStrategy?: ExecutionStrategy,
  ): Promise<TeamResult> {
    const messages = this.buildPrompt(input, context);

    const strategy = executionStrategy ?? { type: "single" as const };

    if (strategy.type === "single") {
      return this.executeSingleModel(messages, context);
    }

    return this.executeWithStrategy(strategy, messages, context);
  }

  private async executeSingleModel(
    messages: ProviderMessage[],
    context: StageContext,
  ): Promise<TeamResult> {
    const response = await this.gateway.complete(
      {
        modelSlug: context.modelSlug || this.config.defaultModelSlug,
        messages,
        temperature: context.temperature,
        maxTokens: context.maxTokens,
      },
      context.privacySettings
        ? { privacy: context.privacySettings, sessionId: context.sessionId }
        : undefined,
    );

    const parsed = this.parseOutput(response.content);
    const questions = this.extractQuestions(parsed);

    return {
      output: parsed,
      tokensUsed: response.tokensUsed,
      raw: response.content,
      questions: questions.length > 0 ? questions : undefined,
    };
  }

  private async executeWithStrategy(
    strategy: Exclude<ExecutionStrategy, { type: "single" }>,
    messages: ProviderMessage[],
    context: StageContext,
  ): Promise<TeamResult> {
    const strategyResult = await this.strategyExecutor.execute(
      strategy,
      messages,
      {
        runId: context.runId,
        stageId: String(context.stageIndex),
        maxTokens: context.maxTokens,
      },
    );

    const parsed = this.parseOutput(strategyResult.finalContent);
    const questions = this.extractQuestions(parsed);

    return {
      output: parsed,
      tokensUsed: strategyResult.totalTokensUsed,
      raw: strategyResult.finalContent,
      questions: questions.length > 0 ? questions : undefined,
      strategyResult,
    };
  }

  async *executeStream(
    input: Record<string, unknown>,
    context: StageContext,
  ): AsyncGenerator<string> {
    // Streaming always uses single model — intermediate strategy steps are WS events only
    const messages = this.buildPrompt(input, context);
    yield* this.gateway.stream(
      {
        modelSlug: context.modelSlug || this.config.defaultModelSlug,
        messages,
        temperature: context.temperature,
        maxTokens: context.maxTokens,
      },
      context.privacySettings
        ? { privacy: context.privacySettings, sessionId: context.sessionId }
        : undefined,
    );
  }

  protected extractQuestions(parsed: Record<string, unknown>): string[] {
    if (Array.isArray(parsed.questions)) {
      return parsed.questions.filter(
        (q): q is string => typeof q === "string",
      );
    }
    return [];
  }

  protected tryParseJson(raw: string): Record<string, unknown> {
    // Try to extract JSON from the raw output (may be wrapped in markdown)
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const toParse = jsonMatch ? jsonMatch[1].trim() : raw.trim();

    try {
      return JSON.parse(toParse);
    } catch {
      return { raw, parseError: true };
    }
  }

  protected buildSystemMessage(): string {
    return this.config.systemPromptTemplate;
  }

  protected serializeInput(input: Record<string, unknown>): string {
    return JSON.stringify(input, null, 2);
  }
}

/** Minimal no-op executor used when WsManager is not available (backwards compat). */
function createNoOpStrategyExecutor(gateway: Gateway): StrategyExecutor {
  const noOpWs = {
    broadcastToRun: () => undefined,
  } as unknown as WsManager;
  return new StrategyExecutor(gateway, noOpWs);
}
