/**
 * Unit tests for ClaudeProvider.
 *
 * All Anthropic SDK calls are mocked — no real API calls are made.
 * Tests verify:
 *   - complete() returns correct { content, tokensUsed } structure
 *   - stream() yields correct text chunks
 *   - System message extraction: role:"system" → top-level `system` param
 *   - Error handling: invalid API key / auth error → surfaces clear error
 *   - Error handling: rate limit (429) → surfaced clearly (no SDK-level retry)
 *   - Retry on 502/503/504 (single retry via withRetry)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock the Anthropic SDK before importing the provider ────────────────────
// We need the mock to expose `mockCreate` and `mockStream` so tests can
// control return values. We do this via a module-level variable captured
// in the factory closure.

const mockCreate = vi.fn();
const mockStream = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = {
      create: mockCreate,
      stream: mockStream,
    };
    constructor(_opts: unknown) {}
  }
  return { default: MockAnthropic };
});

// Import after mocking so the provider picks up the mock
import { ClaudeProvider } from "../../../server/gateway/providers/claude.js";
import type { ProviderMessage } from "../../../shared/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTextBlock(text: string) {
  return { type: "text" as const, text };
}

function makeToolUseBlock(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_use" as const, id, name, input };
}

function makeCompleteResponse(
  text: string,
  inputTokens = 10,
  outputTokens = 20,
  stopReason: string = "end_turn",
) {
  return {
    content: [makeTextBlock(text)],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    stop_reason: stopReason,
  };
}

const SYSTEM_MESSAGES: ProviderMessage[] = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "Hello!" },
];

const USER_ONLY_MESSAGES: ProviderMessage[] = [
  { role: "user", content: "What is 2+2?" },
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ClaudeProvider — complete()", () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeProvider("sk-ant-test-key");
  });

  it("returns correct { content, tokensUsed } structure", async () => {
    mockCreate.mockResolvedValueOnce(makeCompleteResponse("Hello there!", 15, 25));

    const result = await provider.complete("claude-3-haiku-20240307", USER_ONLY_MESSAGES);

    expect(result.content).toBe("Hello there!");
    expect(result.tokensUsed).toBe(40); // 15 + 25
    expect(result.finishReason).toBe("stop");
  });

  it("returns empty toolCalls when no tool use blocks are present", async () => {
    mockCreate.mockResolvedValueOnce(makeCompleteResponse("Just text"));

    const result = await provider.complete("claude-3-haiku-20240307", USER_ONLY_MESSAGES);

    expect(result.toolCalls).toBeUndefined();
  });

  it("returns toolCalls when response contains tool_use blocks", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        makeTextBlock("I'll search for that."),
        makeToolUseBlock("call-1", "search", { query: "test" }),
      ],
      usage: { input_tokens: 10, output_tokens: 30 },
      stop_reason: "tool_use",
    });

    const result = await provider.complete("claude-3-haiku-20240307", USER_ONLY_MESSAGES);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("search");
    expect(result.toolCalls![0].arguments).toEqual({ query: "test" });
    expect(result.finishReason).toBe("tool_use");
  });

  it("extracts system messages as top-level system param", async () => {
    mockCreate.mockResolvedValueOnce(makeCompleteResponse("response"));

    await provider.complete("claude-3-haiku-20240307", SYSTEM_MESSAGES);

    const callArgs = mockCreate.mock.calls[0][0] as { system?: string; messages: unknown[] };
    expect(callArgs.system).toBe("You are a helpful assistant.");
    // The messages array should NOT contain the system message
    const msgs = callArgs.messages as Array<{ role: string }>;
    expect(msgs.every((m) => m.role !== "system")).toBe(true);
  });

  it("omits system param when no system messages are present", async () => {
    mockCreate.mockResolvedValueOnce(makeCompleteResponse("response"));

    await provider.complete("claude-3-haiku-20240307", USER_ONLY_MESSAGES);

    const callArgs = mockCreate.mock.calls[0][0] as { system?: string };
    expect(callArgs.system).toBeUndefined();
  });

  it("concatenates multiple system messages", async () => {
    const messages: ProviderMessage[] = [
      { role: "system", content: "Part one." },
      { role: "system", content: "Part two." },
      { role: "user", content: "Hello" },
    ];
    mockCreate.mockResolvedValueOnce(makeCompleteResponse("ok"));

    await provider.complete("claude-3-haiku-20240307", messages);

    const callArgs = mockCreate.mock.calls[0][0] as { system?: string };
    expect(callArgs.system).toBe("Part one.\nPart two.");
  });

  it("surfaces authentication error with clear message", async () => {
    const authError = Object.assign(new Error("401 Unauthorized: invalid API key"), {
      status: 401,
    });
    mockCreate.mockRejectedValueOnce(authError);

    await expect(
      provider.complete("claude-3-haiku-20240307", USER_ONLY_MESSAGES),
    ).rejects.toThrow(/invalid API key|401/i);
  });

  it("surfaces rate limit error without swallowing message", async () => {
    const rateLimitError = Object.assign(new Error("429 Too Many Requests: rate limit exceeded"), {
      status: 429,
    });
    mockCreate.mockRejectedValueOnce(rateLimitError);

    await expect(
      provider.complete("claude-3-haiku-20240307", USER_ONLY_MESSAGES),
    ).rejects.toThrow(/rate limit|429/i);
  });

  it("retries once on 503 and returns result on second attempt", async () => {
    const serverError = Object.assign(new Error("503 Service Unavailable"), { status: 503 });
    mockCreate
      .mockRejectedValueOnce(serverError)
      .mockResolvedValueOnce(makeCompleteResponse("retry worked"));

    const result = await provider.complete("claude-3-haiku-20240307", USER_ONLY_MESSAGES);

    expect(result.content).toBe("retry worked");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("throws after second attempt also fails with 503", async () => {
    const serverError = Object.assign(new Error("503 Service Unavailable"), { status: 503 });
    mockCreate.mockRejectedValue(serverError);

    await expect(
      provider.complete("claude-3-haiku-20240307", USER_ONLY_MESSAGES),
    ).rejects.toThrow("503");
  });
});

describe("ClaudeProvider — stream()", () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeProvider("sk-ant-test-key");
  });

  function makeStreamEvents(texts: string[]) {
    const events = texts.map((text) => ({
      type: "content_block_delta" as const,
      delta: { type: "text_delta" as const, text },
    }));

    return {
      [Symbol.asyncIterator]: async function* () {
        // Emit a non-text event first to ensure it's ignored
        yield { type: "message_start" as const };
        for (const event of events) {
          yield event;
        }
      },
    };
  }

  it("yields correct text chunks", async () => {
    const fakeStream = makeStreamEvents(["Hello", " world", "!"]);
    mockStream.mockReturnValueOnce(fakeStream);

    const chunks: string[] = [];
    for await (const chunk of provider.stream("claude-3-haiku-20240307", USER_ONLY_MESSAGES)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Hello", " world", "!"]);
  });

  it("ignores non-text-delta events and only yields text chunks", async () => {
    const fakeStream = makeStreamEvents(["Only text"]);
    mockStream.mockReturnValueOnce(fakeStream);

    const chunks: string[] = [];
    for await (const chunk of provider.stream("claude-3-haiku-20240307", USER_ONLY_MESSAGES)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Only text"]);
  });

  it("yields no chunks when stream has no text-delta events", async () => {
    const emptyStream = {
      [Symbol.asyncIterator]: async function* () {
        yield { type: "message_start" as const };
      },
    };
    mockStream.mockReturnValueOnce(emptyStream);

    const chunks: string[] = [];
    for await (const chunk of provider.stream("claude-3-haiku-20240307", USER_ONLY_MESSAGES)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(0);
  });

  it("extracts system message in streaming calls", async () => {
    const fakeStream = makeStreamEvents(["ok"]);
    mockStream.mockReturnValueOnce(fakeStream);

    for await (const _ of provider.stream("claude-3-haiku-20240307", SYSTEM_MESSAGES)) {
      // consume
    }

    const callArgs = mockStream.mock.calls[0][0] as { system?: string };
    expect(callArgs.system).toBe("You are a helpful assistant.");
  });
});
