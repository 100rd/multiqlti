import { BaseTeam } from "./base";
import type { StageContext } from "@shared/types";

export class ArchitectureTeam extends BaseTeam {
  buildPrompt(
    input: Record<string, unknown>,
    context: StageContext,
  ): Array<{ role: string; content: string }> {
    const previousPlanning = context.previousOutputs[0];
    const combined = previousPlanning
      ? { planningOutput: previousPlanning, ...input }
      : input;

    return [
      { role: "system", content: this.buildSystemMessage(context) },
      {
        role: "user",
        content: `Design the architecture based on this planning output:\n\n${this.serializeInput(combined)}`,
      },
    ];
  }

  parseOutput(rawOutput: string): Record<string, unknown> {
    const parsed = this.tryParseJson(rawOutput);
    return {
      components: parsed.components ?? [],
      techStack: parsed.techStack ?? {},
      dataFlow: parsed.dataFlow ?? "",
      apiEndpoints: parsed.apiEndpoints ?? [],
      summary: parsed.summary ?? "",
      questions: parsed.questions,
    };
  }
}
