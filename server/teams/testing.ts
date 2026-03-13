import { BaseTeam } from "./base";
import type { StageContext } from "@shared/types";

export class TestingTeam extends BaseTeam {
  buildPrompt(
    input: Record<string, unknown>,
    context: StageContext,
  ): Array<{ role: string; content: string }> {
    const devOutput = context.previousOutputs[2] ?? context.previousOutputs[context.previousOutputs.length - 1];
    const combined = devOutput
      ? { developmentOutput: devOutput, ...input }
      : input;

    return [
      { role: "system", content: this.buildSystemMessage() },
      {
        role: "user",
        content: `Generate comprehensive tests for the following code:\n\n${this.serializeInput(combined)}`,
      },
    ];
  }

  parseOutput(rawOutput: string): Record<string, unknown> {
    const parsed = this.tryParseJson(rawOutput);
    return {
      testFiles: parsed.testFiles ?? [],
      testStrategy: parsed.testStrategy ?? "",
      coverageTargets: parsed.coverageTargets ?? {},
      issues: parsed.issues ?? [],
      summary: parsed.summary ?? "",
      questions: parsed.questions,
    };
  }
}
