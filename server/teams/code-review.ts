import { BaseTeam } from "./base";
import type { StageContext } from "@shared/types";

export class CodeReviewTeam extends BaseTeam {
  buildPrompt(
    input: Record<string, unknown>,
    context: StageContext,
  ): Array<{ role: string; content: string }> {
    const devOutput = context.previousOutputs[2];
    const testOutput = context.previousOutputs[3];
    const combined = {
      developmentOutput: devOutput ?? {},
      testingOutput: testOutput ?? {},
      ...input,
    };

    return [
      { role: "system", content: this.buildSystemMessage() },
      {
        role: "user",
        content: `Review the following code and tests for quality and security:\n\n${this.serializeInput(combined)}`,
      },
    ];
  }

  parseOutput(rawOutput: string): Record<string, unknown> {
    const parsed = this.tryParseJson(rawOutput);
    return {
      findings: parsed.findings ?? [],
      securityIssues: parsed.securityIssues ?? [],
      score: parsed.score ?? {},
      approved: parsed.approved ?? false,
      summary: parsed.summary ?? "",
      questions: parsed.questions,
    };
  }
}
