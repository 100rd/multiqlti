/**
 * Pluggable embedding provider system.
 *
 * Default: Ollama (local, zero external calls).
 * Supported: openai, voyage, jina, ollama.
 *
 * Each provider implements the EmbeddingProvider interface.
 * Use EmbeddingProviderFactory.create() to instantiate per workspace config.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type EmbeddingProviderName = "ollama" | "openai" | "voyage" | "jina";

export interface EmbeddingProviderConfig {
  provider: EmbeddingProviderName;
  /** Model identifier for the provider. */
  model: string;
  /** Expected output dimensions. */
  dimensions: number;
  /** Provider-specific options (api key ref, base URL, etc.) */
  options?: Record<string, string>;
}

export interface EmbeddingProvider {
  readonly name: EmbeddingProviderName;
  readonly model: string;
  readonly dimensions: number;
  /**
   * Embed a batch of texts. Returns a 2D array: [textIndex][dimension].
   * Must respect rate limits internally.
   */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Convenience wrapper for a single text. */
  embed(text: string): Promise<number[]>;
}

// ─── Ollama provider (local-first default) ────────────────────────────────────

/** Ollama embedding API — runs on localhost:11434 by default. */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama" as const;
  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;

  constructor(model = "nomic-embed-text", dimensions = 768, baseUrl = "http://localhost:11434") {
    this.model = model;
    this.dimensions = dimensions;
    this.baseUrl = baseUrl;
  }

  async embed(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text]);
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    // Ollama /api/embed accepts one prompt at a time; process sequentially.
    for (const text of texts) {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: text }),
      });
      if (!response.ok) {
        throw new Error(`Ollama embed failed: ${response.status} ${response.statusText}`);
      }
      const data = (await response.json()) as { embeddings?: number[][] };
      const vec = data.embeddings?.[0];
      if (!vec || vec.length === 0) {
        throw new Error(`Ollama returned empty embedding for model ${this.model}`);
      }
      results.push(vec);
    }
    return results;
  }
}

// ─── OpenAI provider ─────────────────────────────────────────────────────────

const OPENAI_BATCH_SIZE = 100;
const OPENAI_BASE_URL = "https://api.openai.com/v1";

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai" as const;
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, model = "text-embedding-3-small", dimensions = 1536, baseUrl = OPENAI_BASE_URL) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
    this.baseUrl = baseUrl;
  }

  async embed(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text]);
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    // Process in batches to stay within OpenAI's 2048 item limit.
    for (let i = 0; i < texts.length; i += OPENAI_BATCH_SIZE) {
      const batch = texts.slice(i, i + OPENAI_BATCH_SIZE);
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: batch }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI embed failed: ${response.status} ${body}`);
      }
      const data = (await response.json()) as { data: Array<{ embedding: number[]; index: number }> };
      const sorted = data.data.sort((a, b) => a.index - b.index);
      results.push(...sorted.map((d) => d.embedding));
    }
    return results;
  }
}

// ─── Voyage provider ─────────────────────────────────────────────────────────

const VOYAGE_BASE_URL = "https://api.voyageai.com/v1";
const VOYAGE_BATCH_SIZE = 128;

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = "voyage" as const;
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, model = "voyage-2", dimensions = 1024, baseUrl = VOYAGE_BASE_URL) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
    this.baseUrl = baseUrl;
  }

  async embed(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text]);
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += VOYAGE_BATCH_SIZE) {
      const batch = texts.slice(i, i + VOYAGE_BATCH_SIZE);
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: batch }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Voyage embed failed: ${response.status} ${body}`);
      }
      const data = (await response.json()) as { data: Array<{ embedding: number[]; index: number }> };
      const sorted = data.data.sort((a, b) => a.index - b.index);
      results.push(...sorted.map((d) => d.embedding));
    }
    return results;
  }
}

// ─── Jina provider ───────────────────────────────────────────────────────────

const JINA_BASE_URL = "https://api.jina.ai/v1";
const JINA_BATCH_SIZE = 64;

export class JinaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "jina" as const;
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, model = "jina-embeddings-v2-base-en", dimensions = 768, baseUrl = JINA_BASE_URL) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
    this.baseUrl = baseUrl;
  }

  async embed(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text]);
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += JINA_BATCH_SIZE) {
      const batch = texts.slice(i, i + JINA_BATCH_SIZE);
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: batch.map((text) => ({ text })) }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Jina embed failed: ${response.status} ${body}`);
      }
      const data = (await response.json()) as { data: Array<{ embedding: number[]; index: number }> };
      const sorted = data.data.sort((a, b) => a.index - b.index);
      results.push(...sorted.map((d) => d.embedding));
    }
    return results;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/** Default config — local Ollama, zero external calls. */
export const DEFAULT_EMBEDDING_CONFIG: EmbeddingProviderConfig = {
  provider: "ollama",
  model: "nomic-embed-text",
  dimensions: 768,
};

export class EmbeddingProviderFactory {
  static create(config: EmbeddingProviderConfig = DEFAULT_EMBEDDING_CONFIG): EmbeddingProvider {
    switch (config.provider) {
      case "ollama": {
        const baseUrl = config.options?.baseUrl ?? "http://localhost:11434";
        return new OllamaEmbeddingProvider(config.model, config.dimensions, baseUrl);
      }
      case "openai": {
        const apiKey = config.options?.apiKey ?? "";
        if (!apiKey) throw new Error("OpenAI embedding provider requires apiKey in options");
        return new OpenAIEmbeddingProvider(apiKey, config.model, config.dimensions);
      }
      case "voyage": {
        const apiKey = config.options?.apiKey ?? "";
        if (!apiKey) throw new Error("Voyage embedding provider requires apiKey in options");
        return new VoyageEmbeddingProvider(apiKey, config.model, config.dimensions);
      }
      case "jina": {
        const apiKey = config.options?.apiKey ?? "";
        if (!apiKey) throw new Error("Jina embedding provider requires apiKey in options");
        return new JinaEmbeddingProvider(apiKey, config.model, config.dimensions);
      }
      default: {
        const _exhaustive: never = config.provider;
        throw new Error(`Unknown embedding provider: ${String(_exhaustive)}`);
      }
    }
  }
}
