import { BaseTeam } from "./base";
import type { StageContext } from "@shared/types";

/**
 * CustomTeam — dynamically instantiated for user-defined pipeline stages.
 * Uses the systemPromptOverride from StageContext if provided, otherwise
 * falls back to the config's systemPromptTemplate.
 */
export class CustomTeam extends BaseTeam {
  buildPrompt(
    input: Record<string, unknown>,
    context: StageContext,
  ): Array<{ role: string; content: string }> {
    const systemPrompt =
      context.stageConfig?.systemPromptOverride ||
      this.config.systemPromptTemplate ||
      "You are a helpful AI assistant. Process the input and provide a detailed response.";

    const taskContent =
      typeof input.taskDescription === "string"
        ? input.taskDescription
        : JSON.stringify(input, null, 2);

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: taskContent },
    ];
  }

  parseOutput(rawOutput: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(rawOutput) as Record<string, unknown>;
      return parsed;
    } catch {
      return { output: rawOutput };
    }
  }
}
