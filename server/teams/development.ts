import { BaseTeam } from "./base";
import type { StageContext } from "@shared/types";

export class DevelopmentTeam extends BaseTeam {
  buildPrompt(
    input: Record<string, unknown>,
    context: StageContext,
  ): Array<{ role: string; content: string }> {
    const architecture = context.previousOutputs[1] ?? context.previousOutputs[0];
    const combined = architecture
      ? { architectureOutput: architecture, ...input }
      : input;

    return [
      { role: "system", content: this.buildSystemMessage() },
      {
        role: "user",
        content: `Generate production-ready code based on this architecture:\n\n${this.serializeInput(combined)}`,
      },
    ];
  }

  parseOutput(rawOutput: string): Record<string, unknown> {
    const parsed = this.tryParseJson(rawOutput);
    return {
      files: parsed.files ?? [],
      dependencies: parsed.dependencies ?? [],
      summary: parsed.summary ?? "",
      questions: parsed.questions,
    };
  }
}
