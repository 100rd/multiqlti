/**
 * Unit tests for GeminiProvider.
 *
 * The @google/generative-ai SDK is mocked — no real API calls are made.
 * Tests verify:
 *   - complete() returns correct { content, tokensUsed } structure
 *   - stream() yields correct text chunks
 *   - Role mapping: "assistant" → "model" in chat history
 *   - System message extraction: role:"system" → systemInstruction config
 *   - Error handling: invalid API key → surfaces clear error
 *   - Error handling: rate limit → surfaced clearly
 *   - Tool calling: functionCall parts → ToolCall[] with finishReason "tool_use"
 *   - Tool calling: tools passed to getGenerativeModel as functionDeclarations
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock @google/generative-ai before importing provider ────────────────────

const mockSendMessage = vi.fn();
const mockSendMessageStream = vi.fn();
const mockStartChat = vi.fn().mockReturnValue({
  sendMessage: mockSendMessage,
  sendMessageStream: mockSendMessageStream,
});
const mockGetGenerativeModel = vi.fn().mockReturnValue({
  startChat: mockStartChat,
});

vi.mock("@google/generative-ai", () => {
  class MockGoogleGenerativeAI {
    getGenerativeModel = mockGetGenerativeModel;
    constructor(_apiKey: string) {}
  }
  return { GoogleGenerativeAI: MockGoogleGenerativeAI };
});

// Import after mocking
import { GeminiProvider } from "../../../server/gateway/providers/gemini.js";
import type { ProviderMessage, ToolDefinition } from "../../../shared/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setupStreamChunks(chunks: string[]) {
  const chunkIterator = async function* () {
    for (const text of chunks) {
      yield { text: () => text };
    }
  };
  mockSendMessageStream.mockResolvedValue({ stream: chunkIterator() });
}

const USER_MESSAGES: ProviderMessage[] = [
  { role: "user", content: "What is 2+2?" },
];

const SYSTEM_WITH_USER: ProviderMessage[] = [
  { role: "system", content: "You are a math tutor." },
  { role: "user", content: "What is 2+2?" },
];

const CONVERSATION: ProviderMessage[] = [
  { role: "user", content: "Hi" },
  { role: "assistant", content: "Hello!" },
  { role: "user", content: "How are you?" },
];

const SAMPLE_TOOLS: ToolDefinition[] = [
  {
    name: "web_search",
    description: "Search the web",
    source: "builtin",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GeminiProvider — complete()", () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset return values after clearAllMocks
    mockStartChat.mockReturnValue({
      sendMessage: mockSendMessage,
      sendMessageStream: mockSendMessageStream,
    });
    mockGetGenerativeModel.mockReturnValue({ startChat: mockStartChat });
    provider = new GeminiProvider("AIza-test-key");
  });

  it("returns correct { content, tokensUsed } structure", async () => {
    mockSendMessage.mockResolvedValueOnce({
      response: {
        text: () => "4",
        usageMetadata: { totalTokenCount: 42 },
        candidates: [],
      },
    });

    const result = await provider.complete("gemini-2.0-flash", USER_MESSAGES);

    expect(result.content).toBe("4");
    expect(result.tokensUsed).toBe(42);
    expect(result.finishReason).toBe("stop");
  });

  it("returns 0 tokensUsed when usageMetadata is absent", async () => {
    mockSendMessage.mockResolvedValueOnce({
      response: {
        text: () => "answer",
        usageMetadata: undefined,
        candidates: [],
      },
    });

    const result = await provider.complete("gemini-2.0-flash", USER_MESSAGES);

    expect(result.tokensUsed).toBe(0);
  });

  it("passes system message as systemInstruction", async () => {
    mockSendMessage.mockResolvedValueOnce({
      response: { text: () => "ok", usageMetadata: { totalTokenCount: 10 }, candidates: [] },
    });

    await provider.complete("gemini-2.0-flash", SYSTEM_WITH_USER);

    const modelConfig = mockGetGenerativeModel.mock.calls[0][0] as {
      systemInstruction?: string;
    };
    expect(modelConfig.systemInstruction).toBe("You are a math tutor.");
  });

  it("omits systemInstruction when no system messages are present", async () => {
    mockSendMessage.mockResolvedValueOnce({
      response: { text: () => "ok", usageMetadata: { totalTokenCount: 5 }, candidates: [] },
    });

    await provider.complete("gemini-2.0-flash", USER_MESSAGES);

    const modelConfig = mockGetGenerativeModel.mock.calls[0][0] as {
      systemInstruction?: string;
    };
    expect(modelConfig.systemInstruction).toBeUndefined();
  });

  it("maps assistant role to model in chat history", async () => {
    mockSendMessage.mockResolvedValueOnce({
      response: { text: () => "fine", usageMetadata: { totalTokenCount: 10 }, candidates: [] },
    });

    await provider.complete("gemini-2.0-flash", CONVERSATION);

    const chatConfig = mockStartChat.mock.calls[0][0] as {
      history: Array<{ role: string; parts: Array<{ text: string }> }>;
    };

    // The last user message is sent via sendMessage, so history has 2 entries
    expect(chatConfig.history).toHaveLength(2);
    expect(chatConfig.history[0].role).toBe("user");
    expect(chatConfig.history[1].role).toBe("model"); // "assistant" → "model"
  });

  it("surfaces authentication error with clear message", async () => {
    mockSendMessage.mockRejectedValueOnce(
      new Error("API_KEY_INVALID: invalid API key"),
    );

    await expect(
      provider.complete("gemini-2.0-flash", USER_MESSAGES),
    ).rejects.toThrow(/invalid API key|API_KEY_INVALID/i);
  });

  it("surfaces rate limit error without swallowing message", async () => {
    mockSendMessage.mockRejectedValueOnce(
      new Error("429 Too Many Requests: quota exceeded"),
    );

    await expect(
      provider.complete("gemini-2.0-flash", USER_MESSAGES),
    ).rejects.toThrow(/429|quota exceeded/i);
  });

  it("retries once on 503 error and returns result", async () => {
    mockSendMessage
      .mockRejectedValueOnce(new Error("503 Service Unavailable"))
      .mockResolvedValueOnce({
        response: {
          text: () => "retry worked",
          usageMetadata: { totalTokenCount: 20 },
          candidates: [],
        },
      });

    const result = await provider.complete("gemini-2.0-flash", USER_MESSAGES);

    expect(result.content).toBe("retry worked");
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it("throws when no user message is present", async () => {
    const systemOnlyMessages: ProviderMessage[] = [
      { role: "system", content: "You are a bot." },
    ];

    await expect(
      provider.complete("gemini-2.0-flash", systemOnlyMessages),
    ).rejects.toThrow(/no user message/i);
  });
});

describe("GeminiProvider — tool calling", () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStartChat.mockReturnValue({
      sendMessage: mockSendMessage,
      sendMessageStream: mockSendMessageStream,
    });
    mockGetGenerativeModel.mockReturnValue({ startChat: mockStartChat });
    provider = new GeminiProvider("AIza-test-key");
  });

  it("returns toolCalls and finishReason 'tool_use' when response has functionCall parts", async () => {
    mockSendMessage.mockResolvedValueOnce({
      response: {
        text: () => "",
        usageMetadata: { totalTokenCount: 15 },
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "web_search",
                    args: { query: "TypeScript best practices" },
                  },
                },
              ],
            },
          },
        ],
      },
    });

    const result = await provider.complete("gemini-2.0-flash", USER_MESSAGES, {
      tools: SAMPLE_TOOLS,
    });

    expect(result.finishReason).toBe("tool_use");
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("web_search");
    expect(result.toolCalls![0].arguments).toEqual({ query: "TypeScript best practices" });
    expect(result.toolCalls![0].id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
  });

  it("maps multiple functionCall parts to multiple ToolCalls", async () => {
    mockSendMessage.mockResolvedValueOnce({
      response: {
        text: () => "",
        usageMetadata: { totalTokenCount: 30 },
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: "web_search", args: { query: "node.js" } } },
                { functionCall: { name: "web_search", args: { query: "typescript" } } },
              ],
            },
          },
        ],
      },
    });

    const result = await provider.complete("gemini-2.0-flash", USER_MESSAGES, {
      tools: SAMPLE_TOOLS,
    });

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0].name).toBe("web_search");
    expect(result.toolCalls![1].name).toBe("web_search");
    expect(result.toolCalls![0].arguments).toEqual({ query: "node.js" });
    expect(result.toolCalls![1].arguments).toEqual({ query: "typescript" });
  });

  it("returns finishReason 'stop' when no functionCall parts in response", async () => {
    mockSendMessage.mockResolvedValueOnce({
      response: {
        text: () => "normal text response",
        usageMetadata: { totalTokenCount: 20 },
        candidates: [
          {
            content: {
              parts: [{ text: "normal text response" }],
            },
          },
        ],
      },
    });

    const result = await provider.complete("gemini-2.0-flash", USER_MESSAGES, {
      tools: SAMPLE_TOOLS,
    });

    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toBeUndefined();
    expect(result.content).toBe("normal text response");
  });

  it("passes tools as functionDeclarations to getGenerativeModel", async () => {
    mockSendMessage.mockResolvedValueOnce({
      response: {
        text: () => "ok",
        usageMetadata: { totalTokenCount: 5 },
        candidates: [],
      },
    });

    await provider.complete("gemini-2.0-flash", USER_MESSAGES, {
      tools: SAMPLE_TOOLS,
    });

    const modelConfig = mockGetGenerativeModel.mock.calls[0][0] as {
      tools?: Array<{ functionDeclarations: Array<{ name: string; description: string }> }>;
    };

    expect(modelConfig.tools).toBeDefined();
    expect(modelConfig.tools).toHaveLength(1);
    expect(modelConfig.tools![0].functionDeclarations).toHaveLength(1);
    expect(modelConfig.tools![0].functionDeclarations[0].name).toBe("web_search");
    expect(modelConfig.tools![0].functionDeclarations[0].description).toBe("Search the web");
  });

  it("omits tools from model config when no tools are provided", async () => {
    mockSendMessage.mockResolvedValueOnce({
      response: {
        text: () => "ok",
        usageMetadata: { totalTokenCount: 5 },
        candidates: [],
      },
    });

    await provider.complete("gemini-2.0-flash", USER_MESSAGES);

    const modelConfig = mockGetGenerativeModel.mock.calls[0][0] as {
      tools?: unknown;
    };
    expect(modelConfig.tools).toBeUndefined();
  });

  it("handles empty functionCall.args gracefully", async () => {
    mockSendMessage.mockResolvedValueOnce({
      response: {
        text: () => "",
        usageMetadata: { totalTokenCount: 10 },
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "no_args_tool",
                    args: null,
                  },
                },
              ],
            },
          },
        ],
      },
    });

    const result = await provider.complete("gemini-2.0-flash", USER_MESSAGES, {
      tools: SAMPLE_TOOLS,
    });

    expect(result.finishReason).toBe("tool_use");
    expect(result.toolCalls![0].arguments).toEqual({});
  });
});

describe("GeminiProvider — stream()", () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStartChat.mockReturnValue({
      sendMessage: mockSendMessage,
      sendMessageStream: mockSendMessageStream,
    });
    mockGetGenerativeModel.mockReturnValue({ startChat: mockStartChat });
    provider = new GeminiProvider("AIza-test-key");
  });

  it("yields correct text chunks from stream", async () => {
    setupStreamChunks(["Hello", " world", "!"]);

    const chunks: string[] = [];
    for await (const chunk of provider.stream("gemini-2.0-flash", USER_MESSAGES)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Hello", " world", "!"]);
  });

  it("skips empty string chunks", async () => {
    setupStreamChunks(["non-empty", "", "also non-empty"]);

    const chunks: string[] = [];
    for await (const chunk of provider.stream("gemini-2.0-flash", USER_MESSAGES)) {
      chunks.push(chunk);
    }

    // GeminiProvider: `if (text) yield text` — empty string is skipped
    expect(chunks).toEqual(["non-empty", "also non-empty"]);
  });

  it("yields no chunks when stream is empty", async () => {
    setupStreamChunks([]);

    const chunks: string[] = [];
    for await (const chunk of provider.stream("gemini-2.0-flash", USER_MESSAGES)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(0);
  });

  it("passes systemInstruction in streaming calls", async () => {
    setupStreamChunks(["ok"]);

    for await (const _ of provider.stream("gemini-2.0-flash", SYSTEM_WITH_USER)) {
      // consume
    }

    const modelConfig = mockGetGenerativeModel.mock.calls[0][0] as {
      systemInstruction?: string;
    };
    expect(modelConfig.systemInstruction).toBe("You are a math tutor.");
  });

  it("passes tools as functionDeclarations in streaming calls", async () => {
    setupStreamChunks(["ok"]);

    for await (const _ of provider.stream("gemini-2.0-flash", USER_MESSAGES, {
      tools: SAMPLE_TOOLS,
    })) {
      // consume
    }

    const modelConfig = mockGetGenerativeModel.mock.calls[0][0] as {
      tools?: Array<{ functionDeclarations: Array<{ name: string }> }>;
    };

    expect(modelConfig.tools).toBeDefined();
    expect(modelConfig.tools![0].functionDeclarations[0].name).toBe("web_search");
  });
});
