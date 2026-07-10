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

// ─── Gateway.testProvider() ────────────────────────────────────────────────

describe("Gateway.testProvider()", () => {
  it("throws when provider is not registered", async () => {
    // Minimal Gateway stub with empty registry.
    // NOTE: "anthropic" is always registered now (CLI subscription provider is
    // the default — issue #347), so we probe an unconfigured key instead.
    const { Gateway } = await import("../../server/gateway/index.js");
    const fakeStorage = {
      getModelBySlug: async () => null,
      createLlmRequest: async () => {},
    } as unknown as import("../../server/storage.js").IStorage;

    const gw = new Gateway(fakeStorage);
    await expect(gw.testProvider("xai")).rejects.toThrow("Provider not configured");
  });

  it("calls the real provider's complete() — does NOT fall back to MockProvider", async () => {
    const { Gateway } = await import("../../server/gateway/index.js");
    const calls: string[] = [];

    const fakeProvider = {
      complete: async (modelId: string) => {
        calls.push(modelId);
        return { content: "pong", tokensUsed: 1 };
      },
      stream: async function* () { yield ""; },
    };

    const fakeStorage = {
      getModelBySlug: async () => null,
      createLlmRequest: async () => {},
    } as unknown as import("../../server/storage.js").IStorage;

    const gw = new Gateway(fakeStorage);
    // Inject fake provider directly into the registry
    (gw as unknown as { registry: Map<string, unknown> }).registry.set("anthropic", fakeProvider);

    await gw.testProvider("anthropic");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("claude-haiku-4-5-20251001");
  });
});


// ─── Local providers OFF by default (issue #346) ───────────────────────────

describe("Gateway — local providers off by default", () => {
  const fakeStorage = {
    getModelBySlug: async () => null,
    createLlmRequest: async () => {},
  } as unknown as import("../../server/storage.js").IStorage;

  it("does not register vLLM / Ollama / LM Studio on a clean install (no endpoints)", async () => {
    const { Gateway } = await import("../../server/gateway/index.js");
    const gw = new Gateway(fakeStorage);
    const status = gw.getStatus();

    expect(status.vllm).toBe(false);
    expect(status.ollama).toBe(false);
    expect(status.lmstudio).toBe(false);
  });

  it("reports null endpoints for local providers when unset", async () => {
    const { Gateway } = await import("../../server/gateway/index.js");
    const gw = new Gateway(fakeStorage);
    const status = gw.getStatus();

    expect(status.vllmEndpoint).toBeNull();
    expect(status.ollamaEndpoint).toBeNull();
    expect(status.lmstudioEndpoint).toBeNull();
  });

  it("registers LM Studio when connected but HIDES it from status (provider allowlist — issue #362)", async () => {
    const { Gateway } = await import("../../server/gateway/index.js");
    const gw = new Gateway(fakeStorage);

    expect(gw.getStatus().lmstudio).toBe(false);

    gw.connectLmStudio("http://localhost:1234");

    // The provider IS registered in the registry…
    expect(
      (gw as unknown as { registry: Map<string, unknown> }).registry.has("lmstudio"),
    ).toBe(true);
    // …but hidden from status (+ endpoint nulled) while it's off the allowlist.
    const status = gw.getStatus();
    expect(status.lmstudio).toBe(false);
    expect(status.lmstudioEndpoint).toBeNull();
  });
});


// ─── Provider visibility allowlist (issue #362) ────────────────────────────

describe("Gateway — provider visibility allowlist", () => {
  const fakeStorage = {
    getModelBySlug: async () => null,
    createLlmRequest: async () => {},
  } as unknown as import("../../server/storage.js").IStorage;

  it("VISIBLE_PROVIDER_KEYS = only the subscription-CLI providers", async () => {
    const { VISIBLE_PROVIDER_KEYS } = await import("../../server/gateway/index.js");
    expect([...VISIBLE_PROVIDER_KEYS].sort()).toEqual(["anthropic", "antigravity", "codex", "google"]);
    for (const hidden of ["vllm", "ollama", "lmstudio", "xai"]) {
      expect(VISIBLE_PROVIDER_KEYS.has(hidden)).toBe(false);
    }
  });

  it("getStatus() reports hidden providers false even when registered", async () => {
    const { Gateway } = await import("../../server/gateway/index.js");
    const gw = new Gateway(fakeStorage);
    const reg = (gw as unknown as { registry: Map<string, unknown> }).registry;
    reg.set("ollama", { complete: async () => ({ content: "", tokensUsed: 0 }) });
    reg.set("xai", { complete: async () => ({ content: "", tokensUsed: 0 }) });

    const status = gw.getStatus();
    expect(status.ollama).toBe(false);
    expect(status.xai).toBe(false);
    expect(status.vllm).toBe(false);
    expect(status.lmstudio).toBe(false);
  });

  it("discoverModels() omits hidden providers entirely", async () => {
    const { Gateway } = await import("../../server/gateway/index.js");
    const gw = new Gateway(fakeStorage);
    const reg = (gw as unknown as { registry: Map<string, unknown> }).registry;
    reg.set("ollama", { listModels: async () => [{ id: "llama3" }] });

    const discovered = await gw.discoverModels();
    expect(discovered.ollama).toBeUndefined();
    expect(discovered.vllm).toBeUndefined();
    expect(discovered.lmstudio).toBeUndefined();
  });
});
