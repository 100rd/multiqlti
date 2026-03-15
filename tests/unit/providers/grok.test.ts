/**
 * Unit tests for GrokProvider.
 *
 * GrokProvider extends OpenAICompatibleProvider and uses the global fetch API
 * for all HTTP calls. We mock `global.fetch` to avoid real network requests.
 *
 * Tests verify:
 *   - complete() returns correct { content, tokensUsed } structure
 *   - stream() yields correct text chunks from SSE events
 *   - Error handling: invalid API key (401) → surfaces clear error
 *   - Error handling: rate limit (429) → surfaced clearly
 *   - Retry on 502/503/504: single retry, success on second attempt
 *   - Retry on 502/503/504: both attempts fail → throws
 *   - Tool calling: tool_calls in response → ToolCall[] with finishReason "tool_use"
 *   - Tool calling: tools passed as OpenAI function format in request body
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";

// Import the provider (it uses global fetch, which we will mock)
import { GrokProvider } from "../../../server/gateway/providers/grok.js";
import type { ProviderMessage, ToolDefinition } from "../../../shared/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const USER_MESSAGES: ProviderMessage[] = [
  { role: "user", content: "Tell me a joke." },
];

const CONVERSATION: ProviderMessage[] = [
  { role: "user", content: "Hi" },
  { role: "assistant", content: "Hello!" },
  { role: "user", content: "How are you?" },
];

const SAMPLE_TOOLS: ToolDefinition[] = [
  {
    name: "web_search",
    description: "Search the web for information",
    source: "builtin",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

/** Build a minimal OpenAI-format JSON response body. */
function makeCompletionBody(content: string, totalTokens = 50): string {
  return JSON.stringify({
    choices: [
      {
        message: { content, tool_calls: undefined },
        finish_reason: "stop",
      },
    ],
    usage: { total_tokens: totalTokens },
  });
}

/** Build a completion body with tool_calls in the response. */
function makeToolCallBody(
  toolName: string,
  args: Record<string, unknown>,
  totalTokens = 25,
): string {
  return JSON.stringify({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "call_abc123",
              type: "function",
              function: {
                name: toolName,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { total_tokens: totalTokens },
  });
}

/** Build a successful JSON response. */
function makeOkResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build an error Response object. Note: each call creates a fresh Response. */
function makeErrorResponse(status: number, body = "error"): Response {
  return new Response(body, { status });
}

/** Build a ReadableStream from an array of SSE data lines. */
function makeSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + "\n"));
      }
      controller.close();
    },
  });
}

/** Create a streaming Response with given SSE chunks. */
function makeStreamResponse(chunks: string[], done = true): Response {
  const sseLines: string[] = [];
  for (const chunk of chunks) {
    sseLines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}`);
    sseLines.push("");
  }
  if (done) {
    sseLines.push("data: [DONE]");
    sseLines.push("");
  }

  return new Response(makeSSEStream(sseLines), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GrokProvider — complete()", () => {
  let provider: GrokProvider;
  let fetchSpy: MockInstance;

  beforeEach(() => {
    provider = new GrokProvider("xai-test-key");
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns correct { content, tokensUsed } structure", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse(makeCompletionBody("Why don't scientists trust atoms?", 75)),
    );

    const result = await provider.complete("grok-3", USER_MESSAGES);

    expect(result.content).toBe("Why don't scientists trust atoms?");
    expect(result.tokensUsed).toBe(75);
    expect(result.finishReason).toBe("stop");
  });

  it("returns empty string content when choices is empty", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse(JSON.stringify({
        choices: [],
        usage: { total_tokens: 0 },
      })),
    );

    const result = await provider.complete("grok-3", USER_MESSAGES);

    expect(result.content).toBe("");
  });

  it("includes Authorization header with Bearer token", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeCompletionBody("ok")));

    await provider.complete("grok-3", USER_MESSAGES);

    const [_url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer xai-test-key");
  });

  it("posts to the xAI completions endpoint", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeCompletionBody("ok")));

    await provider.complete("grok-3", USER_MESSAGES);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.x.ai");
    expect(url).toContain("/v1/chat/completions");
  });

  it("surfaces 401 authentication error with clear message", async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(401, "invalid API key"));

    await expect(
      provider.complete("grok-3", USER_MESSAGES),
    ).rejects.toThrow(/401|invalid API key/i);
  });

  it("surfaces 429 rate limit error without swallowing message", async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(429, "rate limit exceeded"));

    await expect(
      provider.complete("grok-3", USER_MESSAGES),
    ).rejects.toThrow(/429|rate limit/i);
  });

  it("retries once on 503 and returns result on second attempt", async () => {
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(503, "Service Unavailable"))
      .mockResolvedValueOnce(makeOkResponse(makeCompletionBody("retry worked", 30)));

    const result = await provider.complete("grok-3", USER_MESSAGES);

    expect(result.content).toBe("retry worked");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws after second attempt also fails with 502", async () => {
    // Use mockImplementation to create fresh Response each time
    fetchSpy.mockImplementation(async () => makeErrorResponse(502, "Bad Gateway"));

    await expect(
      provider.complete("grok-3", USER_MESSAGES),
    ).rejects.toThrow(/502|Bad Gateway/i);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries once on 504 and throws if both fail", async () => {
    fetchSpy.mockImplementation(async () => makeErrorResponse(504, "Gateway Timeout"));

    await expect(
      provider.complete("grok-3", USER_MESSAGES),
    ).rejects.toThrow(/504/i);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("sends conversation history in correct OpenAI message format", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeCompletionBody("fine")));

    await provider.complete("grok-3", CONVERSATION);

    const [_url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].role).toBe("assistant");
    expect(body.messages[2].role).toBe("user");
  });
});

describe("GrokProvider — tool calling via OpenAI-compatible format", () => {
  let provider: GrokProvider;
  let fetchSpy: MockInstance;

  beforeEach(() => {
    provider = new GrokProvider("xai-test-key");
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns toolCalls and finishReason 'tool_use' when response has tool_calls", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse(makeToolCallBody("web_search", { query: "latest TypeScript features" })),
    );

    const result = await provider.complete("grok-3", USER_MESSAGES, {
      tools: SAMPLE_TOOLS,
    });

    expect(result.finishReason).toBe("tool_use");
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("web_search");
    expect(result.toolCalls![0].arguments).toEqual({ query: "latest TypeScript features" });
    expect(result.toolCalls![0].id).toBe("call_abc123");
  });

  it("sends tools in OpenAI function format in request body", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeCompletionBody("ok")));

    await provider.complete("grok-3", USER_MESSAGES, {
      tools: SAMPLE_TOOLS,
    });

    const [_url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      tools: Array<{
        type: string;
        function: { name: string; description: string; parameters: unknown };
      }>;
    };

    expect(body.tools).toBeDefined();
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[0].function.name).toBe("web_search");
    expect(body.tools[0].function.description).toBe("Search the web for information");
  });

  it("returns no toolCalls when finish_reason is 'stop'", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeCompletionBody("regular response")));

    const result = await provider.complete("grok-3", USER_MESSAGES, {
      tools: SAMPLE_TOOLS,
    });

    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toBeUndefined();
    expect(result.content).toBe("regular response");
  });

  it("handles malformed tool_call arguments gracefully", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_bad",
                    type: "function",
                    function: {
                      name: "broken_tool",
                      arguments: "{ this is not valid json }",
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { total_tokens: 10 },
        }),
      ),
    );

    const result = await provider.complete("grok-3", USER_MESSAGES, {
      tools: SAMPLE_TOOLS,
    });

    expect(result.toolCalls).toHaveLength(1);
    // Malformed JSON falls back to { _raw: ... }
    expect(result.toolCalls![0].arguments).toHaveProperty("_raw");
  });

  it("omits tools from request when none are provided", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeCompletionBody("ok")));

    await provider.complete("grok-3", USER_MESSAGES);

    const [_url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { tools?: unknown };
    expect(body.tools).toBeUndefined();
  });
});

describe("GrokProvider — stream()", () => {
  let provider: GrokProvider;
  let fetchSpy: MockInstance;

  beforeEach(() => {
    provider = new GrokProvider("xai-test-key");
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("yields correct text chunks from SSE stream", async () => {
    fetchSpy.mockResolvedValueOnce(makeStreamResponse(["Hello", " world", "!"]));

    const chunks: string[] = [];
    for await (const chunk of provider.stream("grok-3", USER_MESSAGES)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Hello", " world", "!"]);
  });

  it("stops at [DONE] sentinel and does not yield extra chunks", async () => {
    fetchSpy.mockResolvedValueOnce(makeStreamResponse(["only", " these"]));

    const chunks: string[] = [];
    for await (const chunk of provider.stream("grok-3", USER_MESSAGES)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["only", " these"]);
  });

  it("yields empty result when stream has no content chunks", async () => {
    fetchSpy.mockResolvedValueOnce(makeStreamResponse([]));

    const chunks: string[] = [];
    for await (const chunk of provider.stream("grok-3", USER_MESSAGES)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(0);
  });

  it("surfaces stream error for non-200 status", async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(401, "unauthorized"));

    await expect(async () => {
      for await (const _ of provider.stream("grok-3", USER_MESSAGES)) {
        // consume
      }
    }).rejects.toThrow(/401|unauthorized/i);
  });

  it("sets stream: true in request body", async () => {
    fetchSpy.mockResolvedValueOnce(makeStreamResponse(["ok"]));

    for await (const _ of provider.stream("grok-3", USER_MESSAGES)) {
      // consume
    }

    const [_url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { stream: boolean };
    expect(body.stream).toBe(true);
  });
});
