import { describe, it, expect, beforeEach } from "vitest";
import { MockProvider } from "../../server/gateway/providers/mock.js";
import type { TeamId } from "../../shared/types.js";

describe("MockProvider", () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
  });

  describe("complete()", () => {
    it("returns a typed response with content and tokensUsed", async () => {
      const result = await provider.complete([
        { role: "system", content: "You are a Planning agent" },
        { role: "user", content: "Plan this feature" },
      ]);

      expect(result.content).toBeTruthy();
      expect(typeof result.content).toBe("string");
      expect(result.tokensUsed).toBeGreaterThan(0);
      expect(result.finishReason).toBe("stop");
    });

    it("routes to the planning team when system message contains 'Planning'", async () => {
      const result = await provider.complete([
        { role: "system", content: "You are a Planning agent for the planning team" },
        { role: "user", content: "Build a to-do app" },
      ]);

      const parsed = JSON.parse(result.content) as { tasks: unknown[]; summary: string };
      expect(Array.isArray(parsed.tasks)).toBe(true);
      expect(typeof parsed.summary).toBe("string");
    });

    it("routes to the architecture team when system message contains 'Architecture'", async () => {
      const result = await provider.complete([
        { role: "system", content: "You are an Architecture agent" },
        { role: "user", content: "Design the system" },
      ]);

      const parsed = JSON.parse(result.content) as { components: unknown[]; summary: string };
      expect(Array.isArray(parsed.components)).toBe(true);
      expect(typeof parsed.summary).toBe("string");
    });

    it("falls back to 'development' team when no team is matched in system message", async () => {
      const result = await provider.complete([
        { role: "system", content: "Generic system prompt with no team keyword" },
        { role: "user", content: "Do something" },
      ]);

      const parsed = JSON.parse(result.content) as { files: unknown[]; summary: string };
      expect(Array.isArray(parsed.files)).toBe(true);
      expect(typeof parsed.summary).toBe("string");
    });

    it("returns correct response for each team id via system message", async () => {
      const teamChecks: Array<{ keyword: string; team: TeamId; key: string }> = [
        { keyword: "planning", team: "planning", key: "tasks" },
        { keyword: "architecture", team: "architecture", key: "components" },
        { keyword: "development", team: "development", key: "files" },
        { keyword: "testing", team: "testing", key: "testFiles" },
        { keyword: "code_review", team: "code_review", key: "findings" },
        { keyword: "deployment", team: "deployment", key: "files" },
        { keyword: "monitoring", team: "monitoring", key: "dashboards" },
        { keyword: "fact_check", team: "fact_check", key: "verdict" },
      ];

      for (const { keyword, key } of teamChecks) {
        const result = await provider.complete([
          { role: "system", content: `You are the ${keyword} agent` },
          { role: "user", content: "Execute task" },
        ]);
        const parsed = JSON.parse(result.content) as Record<string, unknown>;
        expect(parsed[key], `team ${keyword} should have key ${key}`).toBeDefined();
      }
    });
  });

  describe("stream()", () => {
    it("yields non-empty string chunks that reconstruct the full response", async () => {
      const chunks: string[] = [];
      for await (const chunk of provider.stream([
        { role: "system", content: "You are a Planning agent" },
        { role: "user", content: "Plan this" },
      ])) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      const fullContent = chunks.join("");
      expect(fullContent).toBeTruthy();

      // Should be valid JSON (same as complete() would return)
      const parsed = JSON.parse(fullContent) as { tasks: unknown[] };
      expect(Array.isArray(parsed.tasks)).toBe(true);
    });
  });

  describe("call capture", () => {
    it("starts with zero calls", () => {
      expect(provider.getCallCount()).toBe(0);
      expect(provider.getCalls()).toHaveLength(0);
    });

    it("records each call with messages, team, and timestamp", async () => {
      await provider.complete([
        { role: "system", content: "You are a Planning agent" },
        { role: "user", content: "Task 1" },
      ]);
      await provider.complete([
        { role: "system", content: "You are a Planning agent" },
        { role: "user", content: "Task 2" },
      ]);

      expect(provider.getCallCount()).toBe(2);

      const calls = provider.getCalls();
      expect(calls[0].team).toBe("planning");
      expect(calls[0].timestamp).toBeInstanceOf(Date);
      expect(calls[1].team).toBe("planning");
    });

    it("clearCalls() resets the call log", async () => {
      await provider.complete([
        { role: "system", content: "You are a Planning agent" },
        { role: "user", content: "Task" },
      ]);
      expect(provider.getCallCount()).toBe(1);

      provider.clearCalls();
      expect(provider.getCallCount()).toBe(0);
      expect(provider.getCalls()).toHaveLength(0);
    });

    it("getCalls() returns a copy — mutating it does not affect the provider", async () => {
      await provider.complete([
        { role: "system", content: "You are a Planning agent" },
        { role: "user", content: "Task" },
      ]);

      const calls = provider.getCalls();
      calls.splice(0);

      expect(provider.getCallCount()).toBe(1);
    });
  });

  describe("fixture overrides", () => {
    it("loadFixture() overrides the response for the specified team", async () => {
      const fixedResponse = JSON.stringify({ tasks: [{ id: "fixed", title: "Fixed task" }], summary: "fixture" });
      provider.loadFixture("planning", fixedResponse);

      const result = await provider.complete([
        { role: "system", content: "You are a Planning agent" },
        { role: "user", content: "Any input" },
      ]);

      expect(result.content).toBe(fixedResponse);
    });

    it("fixture override only applies to the specified team", async () => {
      const fixedResponse = JSON.stringify({ tasks: [], summary: "overridden" });
      provider.loadFixture("planning", fixedResponse);

      const archResult = await provider.complete([
        { role: "system", content: "You are an Architecture agent" },
        { role: "user", content: "Design it" },
      ]);

      const parsed = JSON.parse(archResult.content) as { components: unknown[] };
      expect(Array.isArray(parsed.components)).toBe(true);
    });

    it("clearFixtures() restores default responses", async () => {
      const fixedResponse = "not-real-json";
      provider.loadFixture("planning", fixedResponse);
      provider.clearFixtures();

      const result = await provider.complete([
        { role: "system", content: "You are a Planning agent" },
        { role: "user", content: "Plan it" },
      ]);

      const parsed = JSON.parse(result.content) as { tasks: unknown[] };
      expect(Array.isArray(parsed.tasks)).toBe(true);
    });
  });
});
