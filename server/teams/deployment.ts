import { BaseTeam } from "./base";
import type { StageContext } from "@shared/types";

export class DeploymentTeam extends BaseTeam {
  buildPrompt(
    input: Record<string, unknown>,
    context: StageContext,
  ): Array<{ role: string; content: string }> {
    return [
      { role: "system", content: this.buildSystemMessage(context) },
      {
        role: "user",
        content: `Generate deployment configurations based on all prior phase outputs:\n\n${this.serializeInput({ allOutputs: context.previousOutputs, ...input })}`,
      },
    ];
  }

  parseOutput(rawOutput: string): Record<string, unknown> {
    const parsed = this.tryParseJson(rawOutput);
    return {
      files: parsed.files ?? [],
      deploymentStrategy: parsed.deploymentStrategy ?? "",
      environments: parsed.environments ?? [],
      summary: parsed.summary ?? "",
      questions: parsed.questions,
    };
  }
}
