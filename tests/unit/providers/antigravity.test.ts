/**
 * Unit tests for AntigravityProvider and its CLI adapter (issue #348).
 *
 * The CLI adapter (antigravity-cli) is mocked — no real `agy` process is
 * spawned. Tests verify:
 *   - complete() returns { content, tokensUsed, finishReason: "stop" }
 *   - stream() yields the full completion once
 *   - The billed Gemini API (GoogleGenerativeAI) is NEVER instantiated
 *   - Safe argv: prompt/model/timeout passed as an ARG ARRAY (no shell string)
 *   - Error path: CLI missing / not logged in surfaces a clear error
 *   - Malformed output: empty CLI output surfaces a clear error
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderMessage } from "../../../shared/types.js";

// ─── Spy on the real @google/generative-ai to prove it is never constructed ──
const googleGenAiCtor = vi.fn();
vi.mock("@google/generative-ai", () => {
  class MockGoogleGenerativeAI {
    constructor(apiKey: string) {
      googleGenAiCtor(apiKey);
    }
    getGenerativeModel = vi.fn();
  }
  return { GoogleGenerativeAI: MockGoogleGenerativeAI };
});

// ─── Mock the CLI adapter ────────────────────────────────────────────────────
const invokeAntigravityCli = vi.fn();
vi.mock("../../../server/gateway/providers/antigravity-cli.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../server/gateway/providers/antigravity-cli.js")
  >("../../../server/gateway/providers/antigravity-cli.js");
  return {
    ...actual,
    invokeAntigravityCli: (...args: unknown[]) => invokeAntigravityCli(...args),
  };
});

import { AntigravityProvider, renderPrompt } from "../../../server/gateway/providers/antigravity.js";
import {
  AntigravityCliError,
  buildCliArgs,
} from "../../../server/gateway/providers/antigravity-cli.js";

const USER_MESSAGES: ProviderMessage[] = [{ role: "user", content: "What is 2+2?" }];

const SYSTEM_WITH_USER: ProviderMessage[] = [
  { role: "system", content: "You are a math tutor." },
  { role: "user", content: "What is 2+2?" },
];

function mockCliText(text: string, promptBytes = 100): void {
  invokeAntigravityCli.mockResolvedValueOnce({ text, promptBytes });
}

describe("AntigravityProvider — complete()", () => {
  let provider: AntigravityProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AntigravityProvider({ binPath: "agy" });
  });

  it("returns { content, tokensUsed, finishReason: 'stop' }", async () => {
    mockCliText("4", 40);

    const result = await provider.complete("Gemini 3.5 Flash (Medium)", USER_MESSAGES);

    expect(result.content).toBe("4");
    expect(result.finishReason).toBe("stop");
    expect(result.tokensUsed).toBeGreaterThan(0);
    expect(result.toolCalls).toBeUndefined();
  });

  it("does NOT instantiate the billed Gemini API (GoogleGenerativeAI)", async () => {
    mockCliText("local answer");

    await provider.complete("Gemini 3.5 Flash (Medium)", USER_MESSAGES);

    expect(googleGenAiCtor).not.toHaveBeenCalled();
    expect(invokeAntigravityCli).toHaveBeenCalledTimes(1);
  });

  it("passes the caller modelId through to the CLI adapter", async () => {
    mockCliText("ok");

    await provider.complete("Gemini 3.1 Pro (High)", USER_MESSAGES);

    const callArg = invokeAntigravityCli.mock.calls[0][0] as { model: string };
    expect(callArg.model).toBe("Gemini 3.1 Pro (High)");
  });

  it("falls back to the default model when modelId is blank", async () => {
    mockCliText("ok");
    const withDefault = new AntigravityProvider({ defaultModel: "Gemini 3.5 Flash (Low)" });

    await withDefault.complete("   ", USER_MESSAGES);

    const callArg = invokeAntigravityCli.mock.calls[0][0] as { model: string };
    expect(callArg.model).toBe("Gemini 3.5 Flash (Low)");
  });

  it("renders system + user messages into a single prompt", async () => {
    mockCliText("4");

    await provider.complete("Gemini 3.5 Flash (Medium)", SYSTEM_WITH_USER);

    const callArg = invokeAntigravityCli.mock.calls[0][0] as { prompt: string };
    expect(callArg.prompt).toContain("System: You are a math tutor.");
    expect(callArg.prompt).toContain("User: What is 2+2?");
  });

  it("throws when there are no messages", async () => {
    await expect(
      provider.complete("Gemini 3.5 Flash (Medium)", []),
    ).rejects.toThrow(/no messages/i);
  });

  it("surfaces a clear error when the CLI is missing", async () => {
    invokeAntigravityCli.mockRejectedValueOnce(
      new AntigravityCliError("Antigravity CLI binary not found on PATH."),
    );

    await expect(
      provider.complete("Gemini 3.5 Flash (Medium)", USER_MESSAGES),
    ).rejects.toThrow(/not found on PATH/i);
  });

  it("surfaces a clear error when the CLI is not logged in", async () => {
    invokeAntigravityCli.mockRejectedValueOnce(
      new AntigravityCliError("Antigravity CLI is not logged in. Run `agy` once."),
    );

    await expect(
      provider.complete("Gemini 3.5 Flash (Medium)", USER_MESSAGES),
    ).rejects.toThrow(/not logged in/i);
  });

  it("surfaces a clear error on empty/malformed CLI output", async () => {
    invokeAntigravityCli.mockRejectedValueOnce(
      new AntigravityCliError("Antigravity CLI returned empty output."),
    );

    await expect(
      provider.complete("Gemini 3.5 Flash (Medium)", USER_MESSAGES),
    ).rejects.toThrow(/empty output/i);
  });
});

describe("AntigravityProvider — stream()", () => {
  let provider: AntigravityProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AntigravityProvider();
  });

  it("yields the full completion once", async () => {
    mockCliText("Hello world!");

    const chunks: string[] = [];
    for await (const chunk of provider.stream("Gemini 3.5 Flash (Medium)", USER_MESSAGES)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Hello world!"]);
  });

  it("yields nothing when the completion is empty after trim", async () => {
    // Adapter contract guarantees non-empty text, but guard the provider too.
    mockCliText("");

    const chunks: string[] = [];
    for await (const chunk of provider.stream("Gemini 3.5 Flash (Medium)", USER_MESSAGES)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(0);
  });
});

describe("antigravity-cli — buildCliArgs (injection-safe argv)", () => {
  it("builds an ARG ARRAY with print, model, and timeout flags", () => {
    const args = buildCliArgs({
      prompt: "hello; rm -rf /",
      model: "Gemini 3.5 Flash (Medium)",
      binPath: "agy",
      timeoutMs: 30_000,
    });

    expect(Array.isArray(args)).toBe(true);
    // The dangerous prompt lives inside ONE argv element — never a shell token.
    expect(args).toContain("--print=hello; rm -rf /");
    expect(args).toContain("--model=Gemini 3.5 Flash (Medium)");
    expect(args).toContain("--print-timeout=30s");
  });

  it("rounds sub-second timeouts up to whole seconds", () => {
    const args = buildCliArgs({
      prompt: "p",
      model: "m",
      binPath: "agy",
      timeoutMs: 1_500,
    });

    expect(args).toContain("--print-timeout=2s");
  });
});

describe("antigravity provider — renderPrompt", () => {
  it("orders roles and ends with an Assistant turn cue", () => {
    const prompt = renderPrompt([
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ]);

    expect(prompt.startsWith("System: sys")).toBe(true);
    expect(prompt).toContain("User: u1");
    expect(prompt).toContain("Assistant: a1");
    expect(prompt.trimEnd().endsWith("Assistant:")).toBe(true);
  });
});
