/**
 * Gateway-level test for the Anthropic provider selection (issue #347).
 *
 * Verifies that:
 *   - Default mode registers the CLI subscription provider (ClaudeCliProvider)
 *     and NEVER constructs the Anthropic SDK provider (ClaudeProvider) →
 *     0 calls to api.anthropic.com.
 *   - "api" mode WITH an apiKey constructs the SDK provider.
 *   - "api" mode WITHOUT a key still falls back to the CLI provider.
 *
 * All provider modules and the config loader are mocked; no real network or
 * child-process activity occurs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const claudeCliCtor = vi.fn();
const claudeApiCtor = vi.fn();
const getConfig = vi.fn();

vi.mock("../../server/gateway/providers/claude-cli", () => ({
  ClaudeCliProvider: class {
    constructor(...args: unknown[]) {
      claudeCliCtor(...args);
    }
  },
}));

vi.mock("../../server/gateway/providers/claude", () => ({
  ClaudeProvider: class {
    constructor(...args: unknown[]) {
      claudeApiCtor(...args);
    }
  },
}));

// Stub the remaining provider modules so the Gateway constructor stays cheap.
vi.mock("../../server/gateway/providers/mock", () => ({ MockProvider: class {} }));
vi.mock("../../server/gateway/providers/vllm", () => ({ VllmProvider: class {} }));
vi.mock("../../server/gateway/providers/ollama", () => ({ OllamaProvider: class {} }));
vi.mock("../../server/gateway/providers/gemini", () => ({ GeminiProvider: class {} }));
vi.mock("../../server/gateway/providers/grok", () => ({ GrokProvider: class {} }));
vi.mock("../../server/gateway/providers/lmstudio", () => ({ LmStudioProvider: class {} }));
vi.mock("../../server/privacy/anonymizer", () => ({ AnonymizerService: class {} }));
vi.mock("../../server/services/cost-service", () => ({ CostService: class {} }));
vi.mock("../../server/tools/index", () => ({ toolRegistry: {} }));

vi.mock("../../server/config/loader", () => ({
  configLoader: { get: () => getConfig() },
}));

import { Gateway } from "../../server/gateway/index.js";
import type { IStorage } from "../../server/storage.js";

const storage = {} as IStorage;

function configWith(anthropic: { apiKey?: string; mode: "cli" | "api" }) {
  return {
    providers: {
      anthropic,
      google: {},
      antigravity: { enabled: false },
      xai: {},
      vllm: {},
      ollama: {},
      lmstudio: {},
      tavily: {},
    },
  };
}

describe("Gateway — Anthropic provider selection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("default mode uses the CLI provider and never constructs the SDK provider", () => {
    getConfig.mockReturnValue(configWith({ mode: "cli" }));

    new Gateway(storage);

    expect(claudeCliCtor).toHaveBeenCalledTimes(1);
    expect(claudeApiCtor).not.toHaveBeenCalled();
  });

  it("default mode ignores a present apiKey and still uses the CLI provider", () => {
    getConfig.mockReturnValue(configWith({ mode: "cli", apiKey: "sk-ant-xxx" }));

    new Gateway(storage);

    expect(claudeCliCtor).toHaveBeenCalledTimes(1);
    expect(claudeApiCtor).not.toHaveBeenCalled();
  });

  it("api mode with a key constructs the SDK provider", () => {
    getConfig.mockReturnValue(configWith({ mode: "api", apiKey: "sk-ant-xxx" }));

    new Gateway(storage);

    expect(claudeApiCtor).toHaveBeenCalledWith("sk-ant-xxx");
    expect(claudeCliCtor).not.toHaveBeenCalled();
  });

  it("api mode without a key falls back to the CLI provider", () => {
    getConfig.mockReturnValue(configWith({ mode: "api" }));

    new Gateway(storage);

    expect(claudeCliCtor).toHaveBeenCalledTimes(1);
    expect(claudeApiCtor).not.toHaveBeenCalled();
  });
});
