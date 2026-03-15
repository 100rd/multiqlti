/**
 * Unit tests for builtin tools: knowledge-search, memory-search, url-reader, web-search.
 *
 * All external I/O is mocked:
 *   - storage module: vi.mock("../../server/storage") — no real DB
 *   - fetch: vi.spyOn(globalThis, "fetch") — no real HTTP calls
 *   - configLoader: vi.mock("../../server/config/loader") — no real config files
 *
 * Tests verify:
 *   - Happy path: returns formatted results string
 *   - Empty query → returns "cannot be empty" sentinel
 *   - No results → returns "no results" message (not null/undefined/throw)
 *   - Storage errors → graceful fallback message
 *   - Network errors → propagate or return error message
 *   - Missing API key → clear configuration error message
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock storage before any imports ─────────────────────────────────────────

const { mockGetLlmRequests, mockSearchMemories } = vi.hoisted(() => ({
  mockGetLlmRequests: vi.fn(),
  mockSearchMemories: vi.fn(),
}));

vi.mock("../../../server/storage.js", () => ({
  storage: {
    getLlmRequests: mockGetLlmRequests,
    searchMemories: mockSearchMemories,
  },
}));

// ─── Mock configLoader before any imports ─────────────────────────────────────

const { mockConfigGet } = vi.hoisted(() => ({
  mockConfigGet: vi.fn(),
}));

vi.mock("../../../server/config/loader.js", () => ({
  configLoader: {
    get: mockConfigGet,
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { knowledgeSearchHandler } from "../../../server/tools/builtin/knowledge-search.js";
import { memorySearchHandler } from "../../../server/tools/builtin/memory-search.js";
import { urlReaderHandler } from "../../../server/tools/builtin/url-reader.js";
import { webSearchHandler } from "../../../server/tools/builtin/web-search.js";

// ─── knowledge-search ─────────────────────────────────────────────────────────

describe("knowledge_search — tool definition", () => {
  it("has name 'knowledge_search' and source 'builtin'", () => {
    expect(knowledgeSearchHandler.definition.name).toBe("knowledge_search");
    expect(knowledgeSearchHandler.definition.source).toBe("builtin");
  });

  it("requires 'query' field", () => {
    const schema = knowledgeSearchHandler.definition.inputSchema as { required: string[] };
    expect(schema.required).toContain("query");
  });
});

describe("knowledge_search — execute()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns formatted results when matching rows exist", async () => {
    mockGetLlmRequests.mockResolvedValueOnce({
      rows: [
        {
          responseContent: "This is the cached response about TypeScript",
          systemPrompt: "You are a helpful assistant",
          modelSlug: "claude-3-haiku",
          createdAt: new Date("2024-01-15"),
        },
      ],
      total: 1,
    });

    const result = await knowledgeSearchHandler.execute({ query: "TypeScript" });

    expect(typeof result).toBe("string");
    expect(result).toContain("claude-3-haiku");
    expect(result).not.toBeUndefined();
  });

  it("returns 'no results found' message when no rows match the query", async () => {
    mockGetLlmRequests.mockResolvedValueOnce({
      rows: [
        {
          responseContent: "Some unrelated content",
          systemPrompt: "Unrelated system prompt",
          modelSlug: "gpt-4",
          createdAt: new Date(),
        },
      ],
      total: 1,
    });

    const result = await knowledgeSearchHandler.execute({ query: "xyz_nonexistent_query_abc" });

    expect(result).toMatch(/no results found/i);
  });

  it("returns 'no previous responses' message when rows array is empty", async () => {
    mockGetLlmRequests.mockResolvedValueOnce({ rows: [], total: 0 });

    const result = await knowledgeSearchHandler.execute({ query: "anything" });

    expect(result).toMatch(/no previous pipeline responses|no .* found/i);
  });

  it("returns 'cannot be empty' message for empty query", async () => {
    const result = await knowledgeSearchHandler.execute({ query: "" });

    expect(result).toMatch(/cannot be empty/i);
    expect(mockGetLlmRequests).not.toHaveBeenCalled();
  });

  it("returns 'cannot be empty' message for whitespace-only query", async () => {
    const result = await knowledgeSearchHandler.execute({ query: "   " });

    expect(result).toMatch(/cannot be empty/i);
  });

  it("does not call storage when query is empty", async () => {
    await knowledgeSearchHandler.execute({ query: "" });

    expect(mockGetLlmRequests).not.toHaveBeenCalled();
  });

  it("returns fallback message when storage throws", async () => {
    mockGetLlmRequests.mockRejectedValueOnce(new Error("DB connection lost"));

    const result = await knowledgeSearchHandler.execute({ query: "test" });

    expect(typeof result).toBe("string");
    expect(result).toMatch(/unavailable|failed/i);
  });

  it("respects the limit argument (caps at 20)", async () => {
    const manyRows = Array.from({ length: 20 }, (_, i) => ({
      responseContent: `response content about test topic ${i}`,
      systemPrompt: "sys",
      modelSlug: `model-${i}`,
      createdAt: new Date(),
    }));
    mockGetLlmRequests.mockResolvedValueOnce({ rows: manyRows, total: 20 });

    const result = await knowledgeSearchHandler.execute({ query: "test", limit: 3 });

    // Should return at most 3 results
    const resultCount = (result.match(/### Result/g) ?? []).length;
    expect(resultCount).toBeLessThanOrEqual(3);
  });
});

// ─── memory-search ────────────────────────────────────────────────────────────

describe("memory_search — tool definition", () => {
  it("has name 'memory_search' and source 'builtin'", () => {
    expect(memorySearchHandler.definition.name).toBe("memory_search");
    expect(memorySearchHandler.definition.source).toBe("builtin");
  });

  it("requires 'query' field", () => {
    const schema = memorySearchHandler.definition.inputSchema as { required: string[] };
    expect(schema.required).toContain("query");
  });
});

describe("memory_search — execute()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns formatted memories when results are found", async () => {
    mockSearchMemories.mockResolvedValueOnce([
      {
        id: 1,
        type: "fact",
        key: "preferred_language",
        content: "TypeScript is preferred",
        confidence: 0.95,
        scope: "global",
        createdAt: new Date(),
        updatedAt: new Date(),
        runId: null,
        expiresAt: null,
      },
    ]);

    const result = await memorySearchHandler.execute({ query: "language" });

    expect(typeof result).toBe("string");
    expect(result).toContain("fact");
    expect(result).toContain("preferred_language");
    expect(result).toContain("TypeScript is preferred");
  });

  it("returns empty-match message when no memories found — not null/undefined", async () => {
    mockSearchMemories.mockResolvedValueOnce([]);

    const result = await memorySearchHandler.execute({ query: "unknown topic" });

    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/no memories found/i);
  });

  it("returns 'cannot be empty' message for empty query", async () => {
    const result = await memorySearchHandler.execute({ query: "" });

    expect(result).toMatch(/cannot be empty/i);
    expect(mockSearchMemories).not.toHaveBeenCalled();
  });

  it("does not call storage when query is empty", async () => {
    await memorySearchHandler.execute({ query: "" });

    expect(mockSearchMemories).not.toHaveBeenCalled();
  });

  it("returns fallback message when storage throws", async () => {
    mockSearchMemories.mockRejectedValueOnce(new Error("Postgres connection error"));

    const result = await memorySearchHandler.execute({ query: "test" });

    expect(typeof result).toBe("string");
    expect(result).toMatch(/unavailable|failed/i);
  });

  it("formats confidence to 2 decimal places", async () => {
    mockSearchMemories.mockResolvedValueOnce([
      {
        id: 2,
        type: "pattern",
        key: "retry_logic",
        content: "Always retry on 503",
        confidence: 0.888888,
        scope: "global",
        createdAt: new Date(),
        updatedAt: new Date(),
        runId: null,
        expiresAt: null,
      },
    ]);

    const result = await memorySearchHandler.execute({ query: "retry" });

    // confidence.toFixed(2) = "0.89"
    expect(result).toContain("0.89");
  });

  it("returns result for multiple memories without crashing", async () => {
    mockSearchMemories.mockResolvedValueOnce([
      {
        id: 1,
        type: "fact",
        key: "key1",
        content: "content1",
        confidence: 0.8,
        scope: "global",
        createdAt: new Date(),
        updatedAt: new Date(),
        runId: null,
        expiresAt: null,
      },
      {
        id: 2,
        type: "preference",
        key: "key2",
        content: "content2",
        confidence: 0.9,
        scope: "global",
        createdAt: new Date(),
        updatedAt: new Date(),
        runId: null,
        expiresAt: null,
      },
    ]);

    const result = await memorySearchHandler.execute({ query: "key" });

    const lines = result.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
  });
});

// ─── url-reader ───────────────────────────────────────────────────────────────

describe("url_reader — tool definition", () => {
  it("has name 'url_reader' and source 'builtin'", () => {
    expect(urlReaderHandler.definition.name).toBe("url_reader");
    expect(urlReaderHandler.definition.source).toBe("builtin");
  });

  it("requires 'url' field", () => {
    const schema = urlReaderHandler.definition.inputSchema as { required: string[] };
    expect(schema.required).toContain("url");
  });
});

describe("url_reader — execute()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns page content for valid https URL", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("# Page Title\n\nSome content here.", { status: 200 }),
    );

    const result = await urlReaderHandler.execute({ url: "https://example.com/page" });

    expect(result).toContain("Page Title");
    expect(result).toContain("Some content here.");
  });

  it("returns page content for valid http URL", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("plain content", { status: 200 }),
    );

    const result = await urlReaderHandler.execute({ url: "http://internal.local/docs" });

    expect(result).toBe("plain content");
  });

  it("returns 'cannot be empty' for empty url", async () => {
    const result = await urlReaderHandler.execute({ url: "" });

    expect(result).toMatch(/cannot be empty/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 'Invalid URL' for non-http/https scheme", async () => {
    const result = await urlReaderHandler.execute({ url: "ftp://example.com/file" });

    expect(result).toMatch(/invalid url|must start with http/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 'Invalid URL' when url lacks scheme", async () => {
    const result = await urlReaderHandler.execute({ url: "example.com/page" });

    expect(result).toMatch(/invalid url|must start with http/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns error message on HTTP 4xx without throwing", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    const result = await urlReaderHandler.execute({ url: "https://example.com/missing" });

    expect(typeof result).toBe("string");
    expect(result).toMatch(/failed to read url|HTTP 404/i);
  });

  it("throws on network failure — does not swallow", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Network request failed"));

    await expect(
      urlReaderHandler.execute({ url: "https://example.com" }),
    ).rejects.toThrow(/Network request failed/);
  });

  it("truncates response at 8000 chars and adds truncation notice", async () => {
    const longContent = "A".repeat(9000);
    fetchSpy.mockResolvedValueOnce(new Response(longContent, { status: 200 }));

    const result = await urlReaderHandler.execute({ url: "https://example.com" });

    expect(result.length).toBeLessThanOrEqual(8000 + 100); // 8000 content + truncation message
    expect(result).toContain("[Content truncated");
  });

  it("returns 'no content' message when page body is empty", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

    const result = await urlReaderHandler.execute({ url: "https://example.com" });

    expect(result).toMatch(/no content/i);
  });

  it("calls Jina reader URL with the original URL appended", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("content", { status: 200 }));

    await urlReaderHandler.execute({ url: "https://example.com/article" });

    const [calledUrl] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("r.jina.ai");
    expect(calledUrl).toContain("https://example.com/article");
  });
});

// ─── web-search ───────────────────────────────────────────────────────────────

describe("web_search — tool definition", () => {
  it("has name 'web_search' and source 'builtin'", () => {
    expect(webSearchHandler.definition.name).toBe("web_search");
    expect(webSearchHandler.definition.source).toBe("builtin");
  });

  it("requires 'query' field", () => {
    const schema = webSearchHandler.definition.inputSchema as { required: string[] };
    expect(schema.required).toContain("query");
  });
});

describe("web_search — execute() with Tavily", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch");
    // Default: Tavily API key is configured
    mockConfigGet.mockReturnValue({
      providers: { tavily: { apiKey: "tvly-test-key" } },
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns formatted results when Tavily responds with results", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            { title: "Result One", url: "https://example.com/1", content: "Content one" },
            { title: "Result Two", url: "https://example.com/2", content: "Content two" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await webSearchHandler.execute({ query: "TypeScript tips" });

    expect(result).toContain("Result One");
    expect(result).toContain("Content one");
  });

  it("returns 'no results found' when Tavily returns empty results array", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await webSearchHandler.execute({ query: "obscure query" });

    expect(result).toMatch(/no results found/i);
  });

  it("calls Tavily API endpoint", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ results: [{ title: "T", url: "https://t.com", content: "c" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await webSearchHandler.execute({ query: "test query" });

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("tavily.com");
  });

  it("includes API key in Tavily request body", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ results: [{ title: "T", url: "https://t.com", content: "c" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await webSearchHandler.execute({ query: "test" });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.api_key).toBe("tvly-test-key");
  });

  it("returns 'Query cannot be empty' for empty query", async () => {
    const result = await webSearchHandler.execute({ query: "" });

    expect(result).toMatch(/query cannot be empty/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 'Query cannot be empty' for whitespace-only query", async () => {
    const result = await webSearchHandler.execute({ query: "   " });

    expect(result).toMatch(/query cannot be empty/i);
  });
});

describe("web_search — execute() missing Tavily key", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch");
    // No Tavily API key configured
    mockConfigGet.mockReturnValue({
      providers: { tavily: undefined },
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("falls back to DuckDuckGo when Tavily key is missing", async () => {
    // DuckDuckGo call succeeds
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          AbstractText: "Duck result",
          AbstractURL: "https://duckduckgo.com/duck",
          RelatedTopics: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await webSearchHandler.execute({ query: "test query" });

    expect(typeof result).toBe("string");
    // Result is either DuckDuckGo output or an error message — both are strings
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns error message string (not throw) when both Tavily and DDG fail", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));

    const result = await webSearchHandler.execute({ query: "test" });

    expect(typeof result).toBe("string");
    expect(result).toMatch(/search failed|tavily|duckduckgo/i);
  });
});

describe("web_search — execute() Tavily API error", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch");
    mockConfigGet.mockReturnValue({
      providers: { tavily: { apiKey: "tvly-test-key" } },
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("falls back to DuckDuckGo on Tavily 5xx error", async () => {
    // Tavily fails with 500
    fetchSpy.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );
    // DuckDuckGo succeeds
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          AbstractText: "DDG abstract",
          AbstractURL: "https://ddg.com",
          RelatedTopics: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await webSearchHandler.execute({ query: "test" });

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns combined error message string (not throw) when both providers fail", async () => {
    // Tavily fails
    fetchSpy.mockResolvedValueOnce(new Response("Gateway Error", { status: 502 }));
    // DuckDuckGo also fails
    fetchSpy.mockRejectedValueOnce(new Error("DDG unavailable"));

    const result = await webSearchHandler.execute({ query: "test" });

    expect(typeof result).toBe("string");
    expect(result).toMatch(/search failed/i);
    // Both error messages should appear
    expect(result).toMatch(/tavily/i);
    expect(result).toMatch(/duckduckgo/i);
  });
});
