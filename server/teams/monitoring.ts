import { BaseTeam } from "./base";
import type { StageContext } from "@shared/types";

export class MonitoringTeam extends BaseTeam {
  buildPrompt(
    input: Record<string, unknown>,
    context: StageContext,
  ): Array<{ role: string; content: string }> {
    const deployOutput = context.previousOutputs[5] ?? context.previousOutputs[context.previousOutputs.length - 1];
    const combined = deployOutput
      ? { deploymentOutput: deployOutput, ...input }
      : input;

    return [
      { role: "system", content: this.buildSystemMessage() },
      {
        role: "user",
        content: `Set up monitoring and observability for:\n\n${this.serializeInput(combined)}`,
      },
    ];
  }

  parseOutput(rawOutput: string): Record<string, unknown> {
    const parsed = this.tryParseJson(rawOutput);
    return {
      dashboards: parsed.dashboards ?? [],
      alerts: parsed.alerts ?? [],
      healthChecks: parsed.healthChecks ?? [],
      summary: parsed.summary ?? "",
      questions: parsed.questions,
    };
  }
}
