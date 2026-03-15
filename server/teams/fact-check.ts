import { BaseTeam } from "./base";
import type { StageContext, FactCheckOutput } from "@shared/types";

const TRUNCATE_CHARS = 3000;

export class FactCheckTeam extends BaseTeam {
  buildPrompt(
    input: Record<string, unknown>,
    context: StageContext,
  ): Array<{ role: string; content: string }> {
    const previousOutput = context.previousOutputs.length > 0
      ? context.previousOutputs[context.previousOutputs.length - 1]
      : input;

    const outputText = JSON.stringify(previousOutput, null, 2).slice(0, TRUNCATE_CHARS);

    return [
      { role: "system", content: this.buildSystemMessage(context) },
      {
        role: "user",
        content: `Fact-check the following pipeline stage output:\n\n\`\`\`json\n${outputText}\n\`\`\`\n\nUse your web search capability to verify claims, library versions, and check for security advisories.`,
      },
    ];
  }

  parseOutput(rawOutput: string): Record<string, unknown> {
    const parsed = this.tryParseJson(rawOutput);
    const result: FactCheckOutput = {
      verdict: (parsed.verdict as FactCheckOutput["verdict"]) ?? "warn",
      issues: Array.isArray(parsed.issues) ? parsed.issues as string[] : [],
      enrichedOutput: (parsed.enrichedOutput as string) ?? rawOutput,
      summary: (parsed.summary as string) ?? "",
    };
    return result as unknown as Record<string, unknown>;
  }
}
