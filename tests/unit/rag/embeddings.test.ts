/**
 * Unit tests for the pluggable embedding provider system.
 *
 * All network calls are mocked — zero external API calls in tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
  VoyageEmbeddingProvider,
  JinaEmbeddingProvider,
  EmbeddingProviderFactory,
  DEFAULT_EMBEDDING_CONFIG,
} from "../../../server/memory/embeddings.js";
import type { EmbeddingProviderConfig } from "../../../server/memory/embeddings.js";

// ─── Mock fetch ───────────────────────────────────────────────────────────────

function makeFetchMock(responseBody: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(responseBody),
    text: () => Promise.resolve(JSON.stringify(responseBody)),
  });
}

function ollamaResponse(embedding: number[]) {
  return { embeddings: [embedding] };
}

function openaiResponse(embeddings: number[][]) {
  return {
    data: embeddings.map((embedding, index) => ({ embedding, index })),
  };
}

function voyageResponse(embeddings: number[][]) {
  return {
    data: embeddings.map((embedding, index) => ({ embedding, index })),
  };
}

function jinaResponse(embeddings: number[][]) {
  return {
    data: embeddings.map((embedding, index) => ({ embedding, index })),
  };
}

const SAMPLE_VEC_768 = Array.from({ length: 768 }, (_, i) => i * 0.001);
const SAMPLE_VEC_1536 = Array.from({ length: 1536 }, (_, i) => i * 0.001);
const SAMPLE_VEC_1024 = Array.from({ length: 1024 }, (_, i) => i * 0.001);

// ─── Ollama ───────────────────────────────────────────────────────────────────

describe("OllamaEmbeddingProvider", () => {
  let provider: OllamaEmbeddingProvider;

  beforeEach(() => {
    provider = new OllamaEmbeddingProvider("nomic-embed-text", 768, "http://localhost:11434");
  });

  it("should have correct provider name and model", () => {
    expect(provider.name).toBe("ollama");
    expect(provider.model).toBe("nomic-embed-text");
    expect(provider.dimensions).toBe(768);
  });

  it("embed() calls /api/embed and returns vector", async () => {
    const mockFetch = makeFetchMock(ollamaResponse(SAMPLE_VEC_768));
    vi.stubGlobal("fetch", mockFetch);

    const result = await provider.embed("hello world");
    expect(result).toEqual(SAMPLE_VEC_768);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/embed",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("embedBatch() calls /api/embed once per text", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(ollamaResponse([1, 2, 3])) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(ollamaResponse([4, 5, 6])) });
    vi.stubGlobal("fetch", mockFetch);

    const results = await provider.embedBatch(["text1", "text2"]);
    expect(results).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("embed() throws when API returns non-2xx", async () => {
    vi.stubGlobal("fetch", makeFetchMock({}, 500));
    await expect(provider.embed("test")).rejects.toThrow("Ollama embed failed: 500");
  });

  it("embed() throws when embedding is empty", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ embeddings: [[]] }));
    await expect(provider.embed("test")).rejects.toThrow("empty embedding");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

// ─── OpenAI ───────────────────────────────────────────────────────────────────

describe("OpenAIEmbeddingProvider", () => {
  let provider: OpenAIEmbeddingProvider;

  beforeEach(() => {
    provider = new OpenAIEmbeddingProvider("sk-test", "text-embedding-3-small", 1536);
  });

  it("should have correct metadata", () => {
    expect(provider.name).toBe("openai");
    expect(provider.model).toBe("text-embedding-3-small");
    expect(provider.dimensions).toBe(1536);
  });

  it("embed() calls /v1/embeddings with Bearer auth", async () => {
    const mockFetch = makeFetchMock(openaiResponse([SAMPLE_VEC_1536]));
    vi.stubGlobal("fetch", mockFetch);

    await provider.embed("hello");
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/embeddings");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
  });

  it("embedBatch() returns vectors in correct order", async () => {
    const vec1 = [1, 2, 3];
    const vec2 = [4, 5, 6];
    // API returns out-of-order
    const mockFetch = makeFetchMock({
      data: [
        { embedding: vec2, index: 1 },
        { embedding: vec1, index: 0 },
      ],
    });
    vi.stubGlobal("fetch", mockFetch);

    const results = await provider.embedBatch(["a", "b"]);
    expect(results[0]).toEqual(vec1);
    expect(results[1]).toEqual(vec2);
  });

  it("embedBatch() throws on non-2xx response", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ error: "quota exceeded" }, 429));
    await expect(provider.embedBatch(["text"])).rejects.toThrow("OpenAI embed failed: 429");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

// ─── Voyage ───────────────────────────────────────────────────────────────────

describe("VoyageEmbeddingProvider", () => {
  let provider: VoyageEmbeddingProvider;

  beforeEach(() => {
    provider = new VoyageEmbeddingProvider("voy-test", "voyage-2", 1024);
  });

  it("should have correct metadata", () => {
    expect(provider.name).toBe("voyage");
    expect(provider.model).toBe("voyage-2");
    expect(provider.dimensions).toBe(1024);
  });

  it("embed() returns a vector", async () => {
    vi.stubGlobal("fetch", makeFetchMock(voyageResponse([SAMPLE_VEC_1024])));
    const result = await provider.embed("test");
    expect(result).toEqual(SAMPLE_VEC_1024);
  });

  it("embedBatch() returns vectors in correct order", async () => {
    const v1 = [1], v2 = [2], v3 = [3];
    vi.stubGlobal("fetch", makeFetchMock({
      data: [
        { embedding: v3, index: 2 },
        { embedding: v1, index: 0 },
        { embedding: v2, index: 1 },
      ],
    }));
    const results = await provider.embedBatch(["a", "b", "c"]);
    expect(results).toEqual([v1, v2, v3]);
  });

  it("throws on error response", async () => {
    vi.stubGlobal("fetch", makeFetchMock({}, 401));
    await expect(provider.embed("test")).rejects.toThrow("Voyage embed failed: 401");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

// ─── Jina ─────────────────────────────────────────────────────────────────────

describe("JinaEmbeddingProvider", () => {
  let provider: JinaEmbeddingProvider;

  beforeEach(() => {
    provider = new JinaEmbeddingProvider("jina-test", "jina-embeddings-v2-base-en", 768);
  });

  it("should have correct metadata", () => {
    expect(provider.name).toBe("jina");
    expect(provider.model).toBe("jina-embeddings-v2-base-en");
    expect(provider.dimensions).toBe(768);
  });

  it("embed() sends input as array of objects with text field", async () => {
    const mockFetch = makeFetchMock(jinaResponse([SAMPLE_VEC_768]));
    vi.stubGlobal("fetch", mockFetch);

    await provider.embed("hello");
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.input[0]).toEqual({ text: "hello" });
  });

  it("throws on error response", async () => {
    vi.stubGlobal("fetch", makeFetchMock({}, 500));
    await expect(provider.embed("test")).rejects.toThrow("Jina embed failed: 500");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

// ─── Factory ─────────────────────────────────────────────────────────────────

describe("EmbeddingProviderFactory", () => {
  it("creates OllamaEmbeddingProvider by default", () => {
    const provider = EmbeddingProviderFactory.create();
    expect(provider.name).toBe("ollama");
    expect(provider.model).toBe(DEFAULT_EMBEDDING_CONFIG.model);
  });

  it("creates OllamaEmbeddingProvider for provider=ollama", () => {
    const provider = EmbeddingProviderFactory.create({ provider: "ollama", model: "nomic-embed-text", dimensions: 768 });
    expect(provider.name).toBe("ollama");
  });

  it("creates OpenAIEmbeddingProvider for provider=openai", () => {
    const provider = EmbeddingProviderFactory.create({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      options: { apiKey: "sk-test" },
    });
    expect(provider.name).toBe("openai");
  });

  it("throws when openai apiKey is missing", () => {
    expect(() =>
      EmbeddingProviderFactory.create({ provider: "openai", model: "text-embedding-3-small", dimensions: 1536 }),
    ).toThrow("apiKey");
  });

  it("creates VoyageEmbeddingProvider for provider=voyage", () => {
    const provider = EmbeddingProviderFactory.create({
      provider: "voyage",
      model: "voyage-2",
      dimensions: 1024,
      options: { apiKey: "voy-key" },
    });
    expect(provider.name).toBe("voyage");
  });

  it("throws when voyage apiKey is missing", () => {
    expect(() =>
      EmbeddingProviderFactory.create({ provider: "voyage", model: "voyage-2", dimensions: 1024 }),
    ).toThrow("apiKey");
  });

  it("creates JinaEmbeddingProvider for provider=jina", () => {
    const provider = EmbeddingProviderFactory.create({
      provider: "jina",
      model: "jina-embeddings-v2-base-en",
      dimensions: 768,
      options: { apiKey: "jina-key" },
    });
    expect(provider.name).toBe("jina");
  });

  it("throws when jina apiKey is missing", () => {
    expect(() =>
      EmbeddingProviderFactory.create({ provider: "jina", model: "jina-embeddings-v2-base-en", dimensions: 768 }),
    ).toThrow("apiKey");
  });

  it("DEFAULT_EMBEDDING_CONFIG uses ollama with local defaults", () => {
    expect(DEFAULT_EMBEDDING_CONFIG.provider).toBe("ollama");
    expect(DEFAULT_EMBEDDING_CONFIG.model).toBe("nomic-embed-text");
    expect(DEFAULT_EMBEDDING_CONFIG.dimensions).toBe(768);
  });
});
