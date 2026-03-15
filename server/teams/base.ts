import { toolRegistry } from "../tools/index";
import type { Gateway } from "../gateway/index";
import type { WsManager } from "../ws/manager";
import type { TeamConfig, StageContext, TeamResult, ExecutionStrategy, ProviderMessage, TeamId } from "@shared/types";
import { StrategyExecutor } from "../services/strategy-executor";

const CONTEXT_STAGES_TO_SHOW = 3;
const CONTEXT_TRUNCATE_CHARS = 500;

const DEFAULT_TEAM_TOOLS: Partial<Record<TeamId, string[]>> = {
  planning:     ['web_search', 'knowledge_search', 'memory_search'],
  architecture: ['web_search', 'knowledge_search', 'memory_search'],
  development:  ['web_search', 'knowledge_search'],
  testing:      ['knowledge_search'],
  code_review:  ['web_search', 'knowledge_search', 'memory_search'],
  deployment:   ['web_search', 'knowledge_search'],
  monitoring:   ['web_search', 'knowledge_search'],
};

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
    const messages: ProviderMessage[] = this.buildPrompt(input, context) as unknown as ProviderMessage[];

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
    const toolConfig = context.stageConfig?.tools;
    const defaultTools = DEFAULT_TEAM_TOOLS[this.config.id] ?? [];
    const useTools = toolConfig?.enabled ?? defaultTools.length > 0;

    if (useTools) {
      // Filter tools per stage config
      let allowedNames: string[] | undefined = toolConfig?.allowedTools ?? defaultTools;
      const blockedNames = toolConfig?.blockedTools ?? [];
      if (blockedNames.length > 0) {
        allowedNames = allowedNames.filter((n) => !blockedNames.includes(n));
      }

      const tools = toolRegistry.getAvailableTools().filter(
        (t) => allowedNames === undefined || allowedNames.includes(t.name),
      );

      if (tools.length > 0) {
        const result = await this.gateway.completeWithTools({
          modelSlug: context.modelSlug || this.config.defaultModelSlug,
          messages,
          tools,
          options: {
            temperature: context.temperature,
            maxTokens: context.maxTokens,
            toolChoice: toolConfig?.toolChoice ?? 'auto',
          },
          maxIterations: toolConfig?.maxToolCalls ?? 10,
        });

        const parsed = this.parseOutput(result.content);
        const questions = this.extractQuestions(parsed);

        return {
          output: parsed,
          tokensUsed: result.tokensUsed,
          raw: result.content,
          questions: questions.length > 0 ? questions : undefined,
          toolCallLog: result.toolCallLog.length > 0 ? result.toolCallLog : undefined,
        };
      }
    }

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
      {
        runId: context.runId,
        stageExecutionId: context.stageExecutionId,
        teamId: this.config.id,
      },
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
    const messages: ProviderMessage[] = this.buildPrompt(input, context) as unknown as ProviderMessage[];
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

  protected buildSystemMessage(context?: StageContext): string {
    // If a skill override is set, it replaces the default team system prompt
    let base = context?.stageConfig?.systemPromptOverride || this.config.systemPromptTemplate;
    if (context?.memoryContext) {
      base = `${base}\n\n${context.memoryContext}`;
    }
    return base;
  }

  protected serializeInput(input: Record<string, unknown>): string {
    return JSON.stringify(input, null, 2);
  }

  /**
   * Builds a summarized context block showing the last N completed stage outputs,
   * truncated for prompt efficiency. Used by subclass buildPrompt implementations
   * to give downstream stages awareness of the full pipeline run so far.
   */
  protected buildContextSummary(context: StageContext): string {
    const outputs = context.previousOutputs;
    if (outputs.length === 0) return "";

    const recent = outputs.slice(-CONTEXT_STAGES_TO_SHOW);
    const startIdx = Math.max(0, outputs.length - CONTEXT_STAGES_TO_SHOW);

    const lines: string[] = ["--- Pipeline context (recent stages) ---"];
    for (let j = 0; j < recent.length; j++) {
      const stageIdx = startIdx + j;
      const text = JSON.stringify(recent[j]).slice(0, CONTEXT_TRUNCATE_CHARS);
      const truncated = text.length === CONTEXT_TRUNCATE_CHARS ? text + "..." : text;
      lines.push(`Stage ${stageIdx}: ${truncated}`);
    }
    lines.push("--- End context ---");
    return lines.join("\n");
  }
}

/** Minimal no-op executor used when WsManager is not available (backwards compat). */
function createNoOpStrategyExecutor(gateway: Gateway): StrategyExecutor {
  const noOpWs = {
    broadcastToRun: () => undefined,
  } as unknown as WsManager;
  return new StrategyExecutor(gateway, noOpWs);
}
