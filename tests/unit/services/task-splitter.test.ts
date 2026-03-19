/**
 * Unit tests for TaskSplitter service (PR #171).
 *
 * All LLM calls are mocked via a fake Gateway.
 * Verifies:
 * - Happy path: well-formed LLM JSON produces expected SplitTask array
 * - Markdown code fence stripping
 * - Invalid JSON from LLM throws with descriptive message
 * - Non-array JSON from LLM throws with descriptive message
 * - Partial / missing fields are coerced to safe defaults
 */
import { describe, it, expect, vi } from "vitest";
import { TaskSplitter } from "../../../server/services/task-splitter.js";
import type { Gateway } from "../../../server/gateway/index.js";
import type { SplitTask } from "../../../shared/types.js";

// ─── Mock factory ─────────────────────────────────────────────────────────────

function makeGateway(responseContent: string): Gateway {
  return {
    complete: vi.fn().mockResolvedValue({
      content: responseContent,
      tokensUsed: 20,
      modelSlug: "mock",
      finishReason: "stop",
    }),
    stream: vi.fn(),
    completeWithTools: vi.fn(),
  } as unknown as Gateway;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSplitTasksJson(tasks: Partial<SplitTask>[]): string {
  return JSON.stringify(
    tasks.map((t) => ({
      name: t.name ?? "Task",
      description: t.description ?? "desc",
      conditionsOfDone: t.conditionsOfDone ?? [],
      tests: t.tests ?? [],
      ...(t.dependsOn !== undefined ? { dependsOn: t.dependsOn } : {}),
    })),
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("TaskSplitter", () => {
  // ─── Happy path ────────────────────────────────────────────────────────────

  describe("happy path", () => {
    it("calls gateway.complete once with the story text as user message", async () => {
      const gateway = makeGateway(makeSplitTasksJson([{ name: "T1", description: "do something" }]));
      const splitter = new TaskSplitter(gateway);

      await splitter.split("Build auth flow", "claude-haiku-4-5");

      expect(gateway.complete).toHaveBeenCalledOnce();
      const callArg = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const userMessage = callArg.messages.find((m: { role: string }) => m.role === "user");
      expect(userMessage.content).toBe("Build auth flow");
    });

    it("passes the modelSlug to the gateway request", async () => {
      const gateway = makeGateway(makeSplitTasksJson([{ name: "Task" }]));
      const splitter = new TaskSplitter(gateway);

      await splitter.split("story text", "gpt-4o-mini");

      const callArg = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.modelSlug).toBe("gpt-4o-mini");
    });

    it("returns an array of SplitTask objects from a valid LLM JSON response", async () => {
      const expectedTasks = [
        {
          name: "Backend API",
          description: "Implement REST endpoints",
          conditionsOfDone: ["All endpoints return correct HTTP codes", "Unit tests pass"],
          tests: ["POST /api/users returns 201", "GET /api/users returns 200"],
          dependsOn: undefined,
        },
        {
          name: "Frontend UI",
          description: "Build React login form",
          conditionsOfDone: ["Form validates email", "Shows error on bad credentials"],
          tests: ["Renders without error", "Submit fires POST /api/auth/login"],
          dependsOn: ["Backend API"],
        },
      ];

      const gateway = makeGateway(makeSplitTasksJson(expectedTasks));
      const splitter = new TaskSplitter(gateway);

      const result = await splitter.split("As a user I want to log in", "mock");

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("Backend API");
      expect(result[0].description).toBe("Implement REST endpoints");
      expect(result[0].conditionsOfDone).toEqual(["All endpoints return correct HTTP codes", "Unit tests pass"]);
      expect(result[0].tests).toEqual(["POST /api/users returns 201", "GET /api/users returns 200"]);
      expect(result[0].dependsOn).toBeUndefined();

      expect(result[1].name).toBe("Frontend UI");
      expect(result[1].dependsOn).toEqual(["Backend API"]);
    });

    it("returns an empty array when LLM returns empty array", async () => {
      const gateway = makeGateway("[]");
      const splitter = new TaskSplitter(gateway);

      const result = await splitter.split("Simple story", "mock");

      expect(result).toEqual([]);
    });
  });

  // ─── Markdown fence stripping ─────────────────────────────────────────────

  describe("markdown code fence stripping", () => {
    it("strips ```json ... ``` fences from LLM output", async () => {
      const raw = `\`\`\`json\n${makeSplitTasksJson([{ name: "Fenced Task", description: "inside fence" }])}\n\`\`\``;
      const gateway = makeGateway(raw);
      const splitter = new TaskSplitter(gateway);

      const result = await splitter.split("story", "mock");

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Fenced Task");
    });

    it("strips plain ``` fences without language tag", async () => {
      const raw = `\`\`\`\n${makeSplitTasksJson([{ name: "Plain Fenced" }])}\n\`\`\``;
      const gateway = makeGateway(raw);
      const splitter = new TaskSplitter(gateway);

      const result = await splitter.split("story", "mock");

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Plain Fenced");
    });
  });

  // ─── Field coercion / defaults ────────────────────────────────────────────

  describe("field coercion and defaults", () => {
    it("coerces missing name to 'Unnamed task'", async () => {
      const raw = JSON.stringify([{ description: "no name here", conditionsOfDone: [], tests: [] }]);
      const gateway = makeGateway(raw);
      const splitter = new TaskSplitter(gateway);

      const result = await splitter.split("story", "mock");

      expect(result[0].name).toBe("Unnamed task");
    });

    it("coerces missing description to empty string", async () => {
      const raw = JSON.stringify([{ name: "No Desc" }]);
      const gateway = makeGateway(raw);
      const splitter = new TaskSplitter(gateway);

      const result = await splitter.split("story", "mock");

      expect(result[0].description).toBe("");
    });

    it("coerces missing conditionsOfDone to empty array", async () => {
      const raw = JSON.stringify([{ name: "T", description: "d" }]);
      const gateway = makeGateway(raw);
      const splitter = new TaskSplitter(gateway);

      const result = await splitter.split("story", "mock");

      expect(result[0].conditionsOfDone).toEqual([]);
    });

    it("coerces missing tests to empty array", async () => {
      const raw = JSON.stringify([{ name: "T", description: "d" }]);
      const gateway = makeGateway(raw);
      const splitter = new TaskSplitter(gateway);

      const result = await splitter.split("story", "mock");

      expect(result[0].tests).toEqual([]);
    });

    it("leaves dependsOn undefined when not present in LLM output", async () => {
      const raw = JSON.stringify([{ name: "T", description: "d", conditionsOfDone: [], tests: [] }]);
      const gateway = makeGateway(raw);
      const splitter = new TaskSplitter(gateway);

      const result = await splitter.split("story", "mock");

      expect(result[0].dependsOn).toBeUndefined();
    });

    it("preserves dependsOn array when present", async () => {
      const raw = JSON.stringify([{ name: "T2", description: "d", dependsOn: ["T1"], conditionsOfDone: [], tests: [] }]);
      const gateway = makeGateway(raw);
      const splitter = new TaskSplitter(gateway);

      const result = await splitter.split("story", "mock");

      expect(result[0].dependsOn).toEqual(["T1"]);
    });
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  describe("error handling", () => {
    it("throws with descriptive message on invalid JSON from LLM", async () => {
      const gateway = makeGateway("This is not JSON at all!!!");
      const splitter = new TaskSplitter(gateway);

      await expect(splitter.split("story", "mock")).rejects.toThrow(
        /Failed to parse task split output/,
      );
    });

    it("throws when LLM returns a JSON object instead of array", async () => {
      const gateway = makeGateway('{"tasks": [], "shouldSplit": false}');
      const splitter = new TaskSplitter(gateway);

      await expect(splitter.split("story", "mock")).rejects.toThrow(
        /Failed to parse task split output/,
      );
    });

    it("throws when LLM returns a JSON string scalar", async () => {
      const gateway = makeGateway('"just a string"');
      const splitter = new TaskSplitter(gateway);

      await expect(splitter.split("story", "mock")).rejects.toThrow(
        /Failed to parse task split output/,
      );
    });

    it("throws when LLM returns a JSON number", async () => {
      const gateway = makeGateway("42");
      const splitter = new TaskSplitter(gateway);

      await expect(splitter.split("story", "mock")).rejects.toThrow(
        /Failed to parse task split output/,
      );
    });

    it("propagates gateway errors (e.g. network timeout)", async () => {
      const gateway = makeGateway("");
      (gateway.complete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Connection timeout"));
      const splitter = new TaskSplitter(gateway);

      await expect(splitter.split("story", "mock")).rejects.toThrow("Connection timeout");
    });
  });
});
