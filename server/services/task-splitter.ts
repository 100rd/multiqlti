import type { Gateway } from "../gateway/index.js";
import type { GatewayRequest } from "@shared/types";
import type { SplitTask } from "@shared/types";

const SPLIT_SYSTEM_PROMPT = `You are a senior engineering lead. Given a user story or feature description, split it into concrete implementation tasks.

For each task return:
- name: short task name (2-6 words)
- description: what the developer should implement
- conditionsOfDone: acceptance criteria (array of strings)
- tests: test scenarios to validate the task (array of strings)
- dependsOn: array of task names this task depends on (optional)

Return ONLY a JSON array of tasks. No markdown, no explanation, just the JSON array.`;

/**
 * Uses an LLM to split a user story / feature description into
 * well-defined tasks with conditions of done and test scenarios.
 */
export class TaskSplitter {
  constructor(private readonly gateway: Gateway) {}

  /**
   * Split a story description into structured tasks.
   *
   * @param storyText - The raw user story or feature text to split
   * @param modelSlug - Which model to use for the split
   * @returns An array of split tasks
   */
  async split(storyText: string, modelSlug: string): Promise<SplitTask[]> {
    const request: GatewayRequest = {
      modelSlug,
      messages: [
        { role: "system", content: SPLIT_SYSTEM_PROMPT },
        { role: "user", content: storyText },
      ],
      temperature: 0.2,
      maxTokens: 4096,
    };

    const response = await this.gateway.complete(request);

    // Parse the JSON array from the response
    const raw = response.content.trim();
    // Strip potential markdown code fences
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

    try {
      const parsed = JSON.parse(cleaned) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("Expected JSON array from LLM");
      }
      return parsed.map((item: Record<string, unknown>) => ({
        name: String(item.name ?? "Unnamed task"),
        description: String(item.description ?? ""),
        conditionsOfDone: Array.isArray(item.conditionsOfDone)
          ? (item.conditionsOfDone as string[])
          : [],
        tests: Array.isArray(item.tests) ? (item.tests as string[]) : [],
        dependsOn: Array.isArray(item.dependsOn) ? (item.dependsOn as string[]) : undefined,
      }));
    } catch {
      throw new Error(`Failed to parse task split output: ${cleaned.slice(0, 200)}`);
    }
  }
}
