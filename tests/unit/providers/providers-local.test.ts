/**
 * Unit tests for local provider adapters: OpenAICompatibleProvider, VllmProvider, OllamaProvider.
 *
 * All HTTP calls are mocked via vi.spyOn(globalThis, "fetch") — no real network calls are made.
 * Tests verify:
 *   - complete() returns correct { content, tokensUsed, finishReason } shape
 *   - stream() yields text chunks and terminates cleanly
 *   - HTTP 4xx errors throw with a safe message (no API keys exposed)
 *   - Network / timeout errors propagate
 *   - Empty response body throws a descriptive error
 *   - tokensUsed matches provider usage object values
 *   - Tool calls are parsed correctly (OpenAICompatible only)
 *   - VllmProvider.listModels() maps the /v1/models response
 *   - OllamaProvider.listModels() maps the /api/tags response
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProviderMessage } from "../../../shared/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal ReadableStream that emits SSE lines then closes. */
function makeSseStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + "\n"));
      }
      controller.close();
    },
  });
}

/** Build a minimal ReadableStream emitting newline-delimited JSON (Ollama style). */
function makeNdjsonStream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(JSON.stringify(chunk) + "\n"));
      }
      controller.close();
    },
  });
}

/** Create a Response whose body is a ReadableStream. */
function makeStreamResponse(stream: ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(stream, { status });
}

/** Create a JSON Response. */
function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Create a text Response. */
function makeTextResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

const USER_MESSAGES: ProviderMessage[] = [{ role: "user", content: "Hello" }];

// ─── OpenAICompatibleProvider ─────────────────────────────────────────────────

describe("OpenAICompatibleProvider — complete()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns correct { content, tokensUsed, finishReason } on success", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: "Hello back" }, finish_reason: "stop" }],
        usage: { total_tokens: 42 },
      }),
    );

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://localhost:8080");

    const result = await provider.complete("my-model", USER_MESSAGES);

    expect(result.content).toBe("Hello back");
    expect(result.tokensUsed).toBe(42);
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toBeUndefined();
  });

  it("sets finishReason to tool_use when finish_reason is tool_calls", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "search", arguments: '{"q":"test"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { total_tokens: 20 },
      }),
    );

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://localhost:8080");

    const result = await provider.complete("my-model", USER_MESSAGES);

    expect(result.finishReason).toBe("tool_use");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("search");
    expect(result.toolCalls![0].arguments).toEqual({ q: "test" });
  });

  it("tokensUsed is 0 when usage object is missing", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
    );

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://localhost:8080");

    const result = await provider.complete("my-model", USER_MESSAGES);

    expect(result.tokensUsed).toBe(0);
  });

  it("includes Authorization header when apiKey is provided", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { total_tokens: 5 },
      }),
    );

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://localhost:8080", "sk-secret");

    await provider.complete("my-model", USER_MESSAGES);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-secret");
  });

  it("does not include Authorization header when apiKey is null", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { total_tokens: 5 },
      }),
    );

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://localhost:8080", null);

    await provider.complete("my-model", USER_MESSAGES);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("throws on HTTP 400 error with message", async () => {
    fetchSpy.mockResolvedValueOnce(makeTextResponse("Bad model id", 400));

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://localhost:8080");

    await expect(provider.complete("bad-model", USER_MESSAGES)).rejects.toThrow(/400/);
  });

  it("throws on HTTP 401 without leaking API key in message", async () => {
    fetchSpy.mockResolvedValueOnce(makeTextResponse("Unauthorized", 401));

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://localhost:8080", "sk-my-secret-key");

    await expect(provider.complete("my-model", USER_MESSAGES)).rejects.toSatisfy(
      (err: unknown) => {
        const msg = (err as Error).message;
        return !msg.includes("sk-my-secret-key");
      },
    );
  });

  it("retries once on 503 and returns result on second attempt", async () => {
    fetchSpy
      .mockResolvedValueOnce(makeTextResponse("Service Unavailable", 503))
      .mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content: "retry ok" }, finish_reason: "stop" }],
          usage: { total_tokens: 10 },
        }),
      );

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://localhost:8080");

    const result = await provider.complete("my-model", USER_MESSAGES);

    expect(result.content).toBe("retry ok");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws after two 503 failures", async () => {
    fetchSpy
      .mockResolvedValueOnce(makeTextResponse("Service Unavailable", 503))
      .mockResolvedValueOnce(makeTextResponse("Service Unavailable", 503));

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://localhost:8080");

    await expect(provider.complete("my-model", USER_MESSAGES)).rejects.toThrow();
  });

  it("throws on network error (fetch rejects)", async () => {
    fetchSpy.mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), {
        code: "ECONNREFUSED",
      }),
    );

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://localhost:8080");

    await expect(provider.complete("my-model", USER_MESSAGES)).rejects.toThrow();
  });

  it("returns empty content string when choices[0].message.content is null", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: null }, finish_reason: "stop" }],
        usage: { total_tokens: 5 },
      }),
    );

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://localhost:8080");

    const result = await provider.complete("my-model", USER_MESSAGES);

    expect(result.content).toBe("");
  });

  it("calls the correct model endpoint URL", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { total_tokens: 1 },
      }),
    );

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://myserver:9000");

    await provider.complete("my-model", USER_MESSAGES);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://myserver:9000/v1/chat/completions");
  });
});

describe("OpenAICompatibleProvider — stream()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("yields text chunks from SSE stream", async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      "data: [DONE]",
    ];
    fetchSpy.mockResolvedValueOnce(makeStreamResponse(makeSseStream(sseLines)));

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://localhost:8080");

    const chunks: string[] = [];
    for await (const chunk of provider.stream("my-model", USER_MESSAGES)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Hello", " world"]);
  });

  it("terminates cleanly on [DONE] sentinel before end of stream", async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"chunk1"}}]}',
      "data: [DONE]",
      'data: {"choices":[{"delta":{"content":"should-not-appear"}}]}',
    ];
    fetchSpy.mockResolvedValueOnce(makeStreamResponse(makeSseStream(sseLines)));

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://localhost:8080");

    const chunks: string[] = [];
    for await (const chunk of provider.stream("my-model", USER_MESSAGES)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["chunk1"]);
  });

  it("skips SSE lines without content delta", async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{}}]}',
      'data: {"choices":[{"delta":{"content":"real"}}]}',
      "data: [DONE]",
    ];
    fetchSpy.mockResolvedValueOnce(makeStreamResponse(makeSseStream(sseLines)));

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://localhost:8080");

    const chunks: string[] = [];
    for await (const chunk of provider.stream("my-model", USER_MESSAGES)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["real"]);
  });

  it("throws on HTTP 4xx before streaming begins", async () => {
    fetchSpy.mockResolvedValueOnce(makeTextResponse("Unauthorized", 401));

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://localhost:8080");

    const gen = provider.stream("my-model", USER_MESSAGES);
    await expect(gen.next()).rejects.toThrow(/401/);
  });

  it("throws when response body is null", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://localhost:8080");

    const gen = provider.stream("my-model", USER_MESSAGES);
    await expect(gen.next()).rejects.toThrow(/No response body/);
  });

  it("yields no chunks for empty stream before [DONE]", async () => {
    fetchSpy.mockResolvedValueOnce(makeStreamResponse(makeSseStream(["data: [DONE]"])));

    const { OpenAICompatibleProvider } = await import(
      "../../../server/gateway/providers/openai-compatible.js"
    );
    const provider = new OpenAICompatibleProvider("http://localhost:8080");

    const chunks: string[] = [];
    for await (const chunk of provider.stream("my-model", USER_MESSAGES)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(0);
  });
});

// ─── VllmProvider ─────────────────────────────────────────────────────────────

describe("VllmProvider — complete() (inherits OpenAICompatible)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns correct result shape on success", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: "vllm response" }, finish_reason: "stop" }],
        usage: { total_tokens: 30 },
      }),
    );

    const { VllmProvider } = await import(
      "../../../server/gateway/providers/vllm.js"
    );
    const provider = new VllmProvider("http://vllm-host:8000");

    const result = await provider.complete("llama-3", USER_MESSAGES);

    expect(result.content).toBe("vllm response");
    expect(result.tokensUsed).toBe(30);
    expect(result.finishReason).toBe("stop");
  });

  it("does not set Authorization header (vLLM needs no key)", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { total_tokens: 5 },
      }),
    );

    const { VllmProvider } = await import(
      "../../../server/gateway/providers/vllm.js"
    );
    const provider = new VllmProvider("http://vllm-host:8000");

    await provider.complete("llama-3", USER_MESSAGES);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("throws on HTTP 400 error", async () => {
    fetchSpy.mockResolvedValueOnce(makeTextResponse("invalid model", 400));

    const { VllmProvider } = await import(
      "../../../server/gateway/providers/vllm.js"
    );
    const provider = new VllmProvider("http://vllm-host:8000");

    await expect(provider.complete("bad-model", USER_MESSAGES)).rejects.toThrow(/400/);
  });
});

describe("VllmProvider — listModels()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("maps /v1/models response to RemoteModel array", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({
        data: [
          { id: "llama-3-8b", object: "model", owned_by: "meta", max_model_len: 8192 },
          { id: "mistral-7b", object: "model" },
        ],
      }),
    );

    const { VllmProvider } = await import(
      "../../../server/gateway/providers/vllm.js"
    );
    const provider = new VllmProvider("http://vllm-host:8000");

    const models = await provider.listModels();

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("llama-3-8b");
    expect(models[0].provider).toBe("vllm");
    expect(models[0].contextLength).toBe(8192);
    expect(models[0].owned_by).toBe("meta");
  });

  it("returns empty array when data is empty", async () => {
    fetchSpy.mockResolvedValueOnce(makeJsonResponse({ data: [] }));

    const { VllmProvider } = await import(
      "../../../server/gateway/providers/vllm.js"
    );
    const provider = new VllmProvider("http://vllm-host:8000");

    const models = await provider.listModels();

    expect(models).toEqual([]);
  });

  it("throws on HTTP error from /v1/models", async () => {
    fetchSpy.mockResolvedValueOnce(makeTextResponse("Service unavailable", 503));

    const { VllmProvider } = await import(
      "../../../server/gateway/providers/vllm.js"
    );
    const provider = new VllmProvider("http://vllm-host:8000");

    await expect(provider.listModels()).rejects.toThrow(/503/);
  });
});

describe("VllmProvider — stream()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("yields SSE stream chunks", async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"token1"}}]}',
      'data: {"choices":[{"delta":{"content":"token2"}}]}',
      "data: [DONE]",
    ];
    fetchSpy.mockResolvedValueOnce(makeStreamResponse(makeSseStream(sseLines)));

    const { VllmProvider } = await import(
      "../../../server/gateway/providers/vllm.js"
    );
    const provider = new VllmProvider("http://vllm-host:8000");

    const chunks: string[] = [];
    for await (const chunk of provider.stream("llama-3", USER_MESSAGES)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["token1", "token2"]);
  });
});

// ─── OllamaProvider ───────────────────────────────────────────────────────────

describe("OllamaProvider — complete()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns correct { content, tokensUsed, finishReason } on success", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({
        message: { content: "Ollama says hi" },
        eval_count: 20,
        prompt_eval_count: 10,
      }),
    );

    const { OllamaProvider } = await import(
      "../../../server/gateway/providers/ollama.js"
    );
    const provider = new OllamaProvider("http://localhost:11434");

    const result = await provider.complete("llama3", [{ role: "user", content: "Hi" }]);

    expect(result.content).toBe("Ollama says hi");
    expect(result.tokensUsed).toBe(30); // 20 + 10
    expect(result.finishReason).toBe("stop");
  });

  it("tokensUsed is 0 when eval counts are absent", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({ message: { content: "ok" } }),
    );

    const { OllamaProvider } = await import(
      "../../../server/gateway/providers/ollama.js"
    );
    const provider = new OllamaProvider("http://localhost:11434");

    const result = await provider.complete("llama3", [{ role: "user", content: "Hi" }]);

    expect(result.tokensUsed).toBe(0);
  });

  it("returns empty content when message.content is absent", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({ message: {} }),
    );

    const { OllamaProvider } = await import(
      "../../../server/gateway/providers/ollama.js"
    );
    const provider = new OllamaProvider("http://localhost:11434");

    const result = await provider.complete("llama3", [{ role: "user", content: "Hi" }]);

    expect(result.content).toBe("");
  });

  it("throws on HTTP 4xx error", async () => {
    fetchSpy.mockResolvedValueOnce(makeTextResponse("model not found", 404));

    const { OllamaProvider } = await import(
      "../../../server/gateway/providers/ollama.js"
    );
    const provider = new OllamaProvider("http://localhost:11434");

    await expect(
      provider.complete("unknown-model", [{ role: "user", content: "Hi" }]),
    ).rejects.toThrow(/404/);
  });

  it("throws on network error", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"));

    const { OllamaProvider } = await import(
      "../../../server/gateway/providers/ollama.js"
    );
    const provider = new OllamaProvider("http://localhost:11434");

    await expect(
      provider.complete("llama3", [{ role: "user", content: "Hi" }]),
    ).rejects.toThrow();
  });

  it("calls /api/chat endpoint", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({ message: { content: "ok" } }),
    );

    const { OllamaProvider } = await import(
      "../../../server/gateway/providers/ollama.js"
    );
    const provider = new OllamaProvider("http://localhost:11434");

    await provider.complete("llama3", [{ role: "user", content: "Hi" }]);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/api/chat");
  });
});

describe("OllamaProvider — stream()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("yields content from ndjson chunks", async () => {
    const chunks = [
      { message: { content: "part1" }, done: false },
      { message: { content: "part2" }, done: false },
      { message: { content: "" }, done: true },
    ];
    fetchSpy.mockResolvedValueOnce(makeStreamResponse(makeNdjsonStream(chunks)));

    const { OllamaProvider } = await import(
      "../../../server/gateway/providers/ollama.js"
    );
    const provider = new OllamaProvider("http://localhost:11434");

    const yielded: string[] = [];
    for await (const chunk of provider.stream("llama3", [{ role: "user", content: "Hi" }])) {
      yielded.push(chunk);
    }

    expect(yielded).toEqual(["part1", "part2"]);
  });

  it("stops yielding on done: true even if more data follows", async () => {
    const chunks = [
      { message: { content: "first" }, done: false },
      { message: { content: "" }, done: true },
      { message: { content: "after-done" }, done: false },
    ];
    fetchSpy.mockResolvedValueOnce(makeStreamResponse(makeNdjsonStream(chunks)));

    const { OllamaProvider } = await import(
      "../../../server/gateway/providers/ollama.js"
    );
    const provider = new OllamaProvider("http://localhost:11434");

    const yielded: string[] = [];
    for await (const chunk of provider.stream("llama3", [{ role: "user", content: "Hi" }])) {
      yielded.push(chunk);
    }

    expect(yielded).toEqual(["first"]);
  });

  it("throws on HTTP 4xx before streaming", async () => {
    fetchSpy.mockResolvedValueOnce(makeTextResponse("model not found", 404));

    const { OllamaProvider } = await import(
      "../../../server/gateway/providers/ollama.js"
    );
    const provider = new OllamaProvider("http://localhost:11434");

    const gen = provider.stream("llama3", [{ role: "user", content: "Hi" }]);
    await expect(gen.next()).rejects.toThrow(/404/);
  });

  it("throws when response body is null", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const { OllamaProvider } = await import(
      "../../../server/gateway/providers/ollama.js"
    );
    const provider = new OllamaProvider("http://localhost:11434");

    const gen = provider.stream("llama3", [{ role: "user", content: "Hi" }]);
    await expect(gen.next()).rejects.toThrow(/No response body/);
  });
});

describe("OllamaProvider — listModels()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("maps /api/tags response to RemoteModel array", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({
        models: [
          {
            name: "llama3:latest",
            model: "llama3:latest",
            size: 4_200_000_000,
            details: {
              parameter_size: "8B",
              quantization_level: "Q4_0",
              family: "llama",
            },
          },
        ],
      }),
    );

    const { OllamaProvider } = await import(
      "../../../server/gateway/providers/ollama.js"
    );
    const provider = new OllamaProvider("http://localhost:11434");

    const models = await provider.listModels();

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("llama3:latest");
    expect(models[0].provider).toBe("ollama");
    expect(models[0].parameterSize).toBe("8B");
    expect(models[0].quantization).toBe("Q4_0");
    expect(models[0].family).toBe("llama");
  });

  it("returns empty array when models list is empty", async () => {
    fetchSpy.mockResolvedValueOnce(makeJsonResponse({ models: [] }));

    const { OllamaProvider } = await import(
      "../../../server/gateway/providers/ollama.js"
    );
    const provider = new OllamaProvider("http://localhost:11434");

    const models = await provider.listModels();

    expect(models).toEqual([]);
  });

  it("throws on HTTP error from /api/tags", async () => {
    fetchSpy.mockResolvedValueOnce(makeTextResponse("connection refused", 503));

    const { OllamaProvider } = await import(
      "../../../server/gateway/providers/ollama.js"
    );
    const provider = new OllamaProvider("http://localhost:11434");

    await expect(provider.listModels()).rejects.toThrow(/503/);
  });
});
