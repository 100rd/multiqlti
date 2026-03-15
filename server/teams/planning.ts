import { BaseTeam } from "./base";
import type { StageContext } from "@shared/types";

export class PlanningTeam extends BaseTeam {
  buildPrompt(
    input: Record<string, unknown>,
    context: StageContext,
  ): Array<{ role: string; content: string }> {
    const taskDescription =
      (input.taskDescription as string) ?? JSON.stringify(input);

    return [
      { role: "system", content: this.buildSystemMessage(context) },
      {
        role: "user",
        content: `Analyze and plan the following task:\n\n${taskDescription}`,
      },
    ];
  }

  parseOutput(rawOutput: string): Record<string, unknown> {
    const parsed = this.tryParseJson(rawOutput);
    return {
      tasks: parsed.tasks ?? [],
      acceptanceCriteria: parsed.acceptanceCriteria ?? [],
      risks: parsed.risks ?? [],
      summary: parsed.summary ?? "",
      questions: parsed.questions,
    };
  }
}
