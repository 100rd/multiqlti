import type { Gateway } from "../gateway/index";
import type { TeamConfig, StageContext, TeamResult } from "@shared/types";

export abstract class BaseTeam {
  constructor(
    protected gateway: Gateway,
    protected config: TeamConfig,
  ) {}

  abstract buildPrompt(
    input: Record<string, unknown>,
    context: StageContext,
  ): Array<{ role: string; content: string }>;

  abstract parseOutput(rawOutput: string): Record<string, unknown>;

  async execute(
    input: Record<string, unknown>,
    context: StageContext,
  ): Promise<TeamResult> {
    const messages = this.buildPrompt(input, context);
    const response = await this.gateway.complete({
      modelSlug: context.modelSlug || this.config.defaultModelSlug,
      messages,
    });

    const parsed = this.parseOutput(response.content);
    const questions = this.extractQuestions(parsed);

    return {
      output: parsed,
      tokensUsed: response.tokensUsed,
      raw: response.content,
      questions: questions.length > 0 ? questions : undefined,
    };
  }

  async *executeStream(
    input: Record<string, unknown>,
    context: StageContext,
  ): AsyncGenerator<string> {
    const messages = this.buildPrompt(input, context);
    yield* this.gateway.stream({
      modelSlug: context.modelSlug || this.config.defaultModelSlug,
      messages,
    });
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
