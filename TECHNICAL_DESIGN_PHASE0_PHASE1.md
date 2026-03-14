# multiqlti — Technical Design: Phase 0 + Phase 1

**Author**: solution-architect
**Date**: 2026-03-13
**Branch**: `feature/multi-provider-integration`
**Status**: Ready for implementation

---

## Context and Constraints

Before diving into the design, the key constraints that shape every decision below:

- API keys come from environment variables only (`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`). No DB storage of keys in Phase 0/1.
- PostgreSQL is activated now (Phase 0). The Drizzle schema is already complete — only the wiring in `storage.ts` and `routes.ts` needs to change.
- The `Model` record's `endpoint` column is used only for self-hosted providers (vLLM, Ollama). Cloud providers have no endpoint to store.
- A new `modelId` column on `models` decouples the provider-side model identifier from the UI slug.
- All three cloud providers must support both `complete()` and `stream()`.
- `MockProvider` is NOT retrofitted to the new interface — it remains a fallback and continues to use its current duck-typed signature.

---

## 1. ILLMProvider Interface

Declare this in `shared/types.ts`, below the existing `GatewayResponse` type.

```typescript
// shared/types.ts — ADD after line 80

export type ProviderMessage = { role: string; content: string };

export interface ILLMProviderOptions {
  maxTokens?: number;
  temperature?: number;
}

export interface ILLMProvider {
  /**
   * Non-streaming completion. Returns full content and token count.
   */
  complete(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): Promise<{ content: string; tokensUsed: number }>;

  /**
   * Streaming completion. Yields text delta chunks as they arrive.
   * The generator MUST be exhaustible — callers do not cancel mid-stream.
   */
  stream(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): AsyncGenerator<string>;
}
```

**Rationale for `modelId` as first argument**: the provider knows nothing about slugs — it receives the provider-side model ID (e.g. `"claude-sonnet-4-6"`, `"grok-3"`) directly from the `Model` record's new `modelId` column. The Gateway does the slug→modelId translation.

**Note on MockProvider**: `MockProvider` does NOT implement `ILLMProvider`. It remains an internal fallback with its own signature. The Gateway handles it explicitly in the else branch.

---

## 2. Gateway Registry Pattern

Replace the three private provider fields and the if/else chains in `server/gateway/index.ts` with a registry map. The full replacement class:

```typescript
// server/gateway/index.ts — FULL REPLACEMENT

import type { IStorage } from "../storage";
import type { GatewayRequest, GatewayResponse, ILLMProvider } from "@shared/types";
import { MockProvider } from "./providers/mock";
import { VllmProvider } from "./providers/vllm";
import { OllamaProvider } from "./providers/ollama";
import { ClaudeProvider } from "./providers/claude";
import { GeminiProvider } from "./providers/gemini";
import { GrokProvider } from "./providers/grok";

export class Gateway {
  private registry: Map<string, ILLMProvider>;
  private mockProvider: MockProvider;

  constructor(private storage: IStorage) {
    this.registry = new Map();
    this.mockProvider = new MockProvider();

    // Self-hosted: endpoint-gated
    if (process.env.VLLM_ENDPOINT) {
      this.registry.set("vllm", new VllmProvider(process.env.VLLM_ENDPOINT));
    }
    if (process.env.OLLAMA_ENDPOINT) {
      this.registry.set("ollama", new OllamaProvider(process.env.OLLAMA_ENDPOINT));
    }

    // Cloud: API-key-gated
    if (process.env.ANTHROPIC_API_KEY) {
      this.registry.set("anthropic", new ClaudeProvider(process.env.ANTHROPIC_API_KEY));
    }
    if (process.env.GOOGLE_API_KEY) {
      this.registry.set("google", new GeminiProvider(process.env.GOOGLE_API_KEY));
    }
    if (process.env.XAI_API_KEY) {
      this.registry.set("xai", new GrokProvider(process.env.XAI_API_KEY));
    }
  }

  /** Resolve the ILLMProvider for a model record's provider string. */
  private getProvider(providerKey: string): ILLMProvider | null {
    return this.registry.get(providerKey) ?? null;
  }

  async complete(request: GatewayRequest): Promise<GatewayResponse> {
    const model = await this.storage.getModelBySlug(request.modelSlug);
    const providerKey = model?.provider ?? "mock";
    const modelId = model?.modelId ?? model?.name ?? request.modelSlug;

    const provider = this.getProvider(providerKey);

    let result: { content: string; tokensUsed: number };
    if (provider) {
      result = await provider.complete(modelId, request.messages, {
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      });
    } else {
      // Fallback: mock (also catches vllm/ollama when env var not set)
      result = await this.mockProvider.complete(request.messages, {
        maxTokens: request.maxTokens,
      });
    }

    return {
      content: result.content,
      tokensUsed: result.tokensUsed,
      modelSlug: request.modelSlug,
      finishReason: "stop",
    };
  }

  async *stream(request: GatewayRequest): AsyncGenerator<string> {
    const model = await this.storage.getModelBySlug(request.modelSlug);
    const providerKey = model?.provider ?? "mock";
    const modelId = model?.modelId ?? model?.name ?? request.modelSlug;

    const provider = this.getProvider(providerKey);

    if (provider) {
      yield* provider.stream(modelId, request.messages, {
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      });
    } else {
      yield* this.mockProvider.stream(request.messages);
    }
  }

  getStatus() {
    return {
      vllm: this.registry.has("vllm"),
      ollama: this.registry.has("ollama"),
      anthropic: this.registry.has("anthropic"),
      google: this.registry.has("google"),
      xai: this.registry.has("xai"),
      vllmEndpoint: process.env.VLLM_ENDPOINT ?? null,
      ollamaEndpoint: process.env.OLLAMA_ENDPOINT ?? null,
    };
  }

  async discoverModels(): Promise<Record<string, { available: boolean; models: unknown[]; error?: string }>> {
    const results: Record<string, { available: boolean; models: unknown[]; error?: string }> = {};

    for (const [key, provider] of this.registry.entries()) {
      results[key] = { available: true, models: [] };
      if ("listModels" in provider && typeof (provider as any).listModels === "function") {
        try {
          results[key].models = await (provider as any).listModels();
        } catch (e) {
          results[key].error = (e as Error).message;
        }
      }
    }

    return results;
  }

  async discoverFromEndpoint(
    endpoint: string,
    providerType: "vllm" | "ollama",
  ): Promise<unknown[]> {
    if (providerType === "vllm") return new VllmProvider(endpoint).listModels();
    return new OllamaProvider(endpoint).listModels();
  }
}
```

**Key design notes**:
- Adding a new provider in the future requires: write a class file, add one `if` block in the constructor, and add one entry to `DEFAULT_MODELS`. Zero changes to `complete()` or `stream()`.
- `discoverModels()` now introspects the registry rather than requiring a code change per provider.
- The `model?.modelId ?? model?.name` fallback is safe: existing vLLM/Ollama records don't have `modelId` yet; they still work via `model.name`.

---

## 3. Schema Changes

Add `modelId` to the `models` table in `shared/schema.ts`. No `apiKey` column — keys come from env.

```typescript
// shared/schema.ts — models table, ADD two fields after isActive

export const models = pgTable("models", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  // Provider-side model identifier, e.g. "claude-sonnet-4-6", "grok-3"
  // Null for self-hosted models where model name IS the modelId.
  modelId: text("model_id"),
  endpoint: text("endpoint"),
  provider: text("provider").notNull().default("mock"),
  contextLimit: integer("context_limit").notNull().default(4096),
  capabilities: jsonb("capabilities").notNull().default(sql`'[]'::jsonb`),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});
```

After adding this column, run `npm run db:push` to apply the migration. The column is nullable, so all existing rows remain valid.

The `Model` TypeScript type (`typeof models.$inferSelect`) automatically picks up `modelId: string | null`.

Update `MemStorage.createModel` to handle the new field:

```typescript
// storage.ts — MemStorage.createModel, ADD to the model object literal
modelId: insert.modelId ?? null,
```

---

## 4. OpenAICompatibleProvider Base Class

Create `server/gateway/providers/openai-compatible.ts`. Both `VllmProvider` and `GrokProvider` extend this. `OllamaProvider` does NOT — Ollama uses a different API format (`/api/chat`, not `/v1/chat/completions`).

```typescript
// server/gateway/providers/openai-compatible.ts

import type { ILLMProvider, ILLMProviderOptions, ProviderMessage } from "@shared/types";

interface OpenAIChoice {
  message: { content: string };
  finish_reason: string;
}

interface OpenAIStreamChunk {
  choices: Array<{ delta: { content?: string } }>;
}

export class OpenAICompatibleProvider implements ILLMProvider {
  constructor(
    protected readonly baseUrl: string,
    protected readonly apiKey: string | null = null,
    protected readonly defaultTimeout: number = 30_000,
  ) {}

  protected buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async complete(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): Promise<{ content: string; tokensUsed: number }> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        model: modelId,
        messages,
        max_tokens: options?.maxTokens ?? 4096,
        temperature: options?.temperature ?? 0.7,
        stream: false,
      }),
      signal: AbortSignal.timeout(this.defaultTimeout),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${this.baseUrl} error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      choices: OpenAIChoice[];
      usage: { total_tokens: number };
    };

    return {
      content: data.choices[0]?.message?.content ?? "",
      tokensUsed: data.usage?.total_tokens ?? 0,
    };
  }

  async *stream(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): AsyncGenerator<string> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        model: modelId,
        messages,
        max_tokens: options?.maxTokens ?? 4096,
        temperature: options?.temperature ?? 0.7,
        stream: true,
      }),
      signal: AbortSignal.timeout(this.defaultTimeout),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${this.baseUrl} stream error ${res.status}: ${text}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") return;

        try {
          const chunk = JSON.parse(payload) as OpenAIStreamChunk;
          const content = chunk.choices[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  }
}
```

**Retrofit VllmProvider**: `VllmProvider` now extends `OpenAICompatibleProvider`. Its existing `listModels()` method is kept, but `complete()` and `stream()` are removed — they're inherited. The updated class:

```typescript
// server/gateway/providers/vllm.ts — REPLACEMENT

import { OpenAICompatibleProvider } from "./openai-compatible";

export interface RemoteModel {
  id: string;
  name: string;
  provider: "vllm";
  contextLength?: number;
  owned_by?: string;
}

export class VllmProvider extends OpenAICompatibleProvider {
  constructor(baseUrl: string) {
    super(baseUrl, null); // vLLM: no API key header
  }

  async listModels(): Promise<RemoteModel[]> {
    const res = await fetch(`${this.baseUrl}/v1/models`);
    if (!res.ok) {
      throw new Error(`vLLM list models error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      data: Array<{ id: string; object: string; owned_by?: string; max_model_len?: number }>;
    };
    return (data.data ?? []).map((m) => ({
      id: m.id,
      name: m.id,
      provider: "vllm" as const,
      contextLength: m.max_model_len,
      owned_by: m.owned_by,
    }));
  }
}
```

---

## 5. ClaudeProvider

Create `server/gateway/providers/claude.ts`. Uses `@anthropic-ai/sdk`.

```typescript
// server/gateway/providers/claude.ts

import Anthropic from "@anthropic-ai/sdk";
import type { ILLMProvider, ILLMProviderOptions, ProviderMessage } from "@shared/types";

export class ClaudeProvider implements ILLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  /**
   * Anthropic requires the system prompt to be extracted from the messages array
   * and passed as a top-level `system` parameter. Any message with role "system"
   * is extracted; remaining messages are forwarded as-is.
   */
  private extractSystem(messages: ProviderMessage[]): {
    system: string | undefined;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  } {
    const systemParts = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");

    const conversationMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    return {
      system: systemParts.length > 0 ? systemParts : undefined,
      messages: conversationMessages,
    };
  }

  async complete(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): Promise<{ content: string; tokensUsed: number }> {
    const { system, messages: msgs } = this.extractSystem(messages);

    const response = await this.client.messages.create({
      model: modelId,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
      ...(system ? { system } : {}),
      messages: msgs,
    });

    const content = response.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { type: "text"; text: string }).text)
      .join("");

    return {
      content,
      tokensUsed: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
    };
  }

  async *stream(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): AsyncGenerator<string> {
    const { system, messages: msgs } = this.extractSystem(messages);

    const stream = this.client.messages.stream({
      model: modelId,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
      ...(system ? { system } : {}),
      messages: msgs,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }
  }
}
```

**Package needed**: `@anthropic-ai/sdk` — add to `package.json` dependencies.

**System prompt extraction rule**: The `extractSystem` helper handles the case where multiple system messages are present (concatenated with newline). If there are no system messages, `system` is omitted from the request body entirely (the `...{}` spread).

---

## 6. GeminiProvider

Create `server/gateway/providers/gemini.ts`. Uses `@google/generative-ai`.

```typescript
// server/gateway/providers/gemini.ts

import {
  GoogleGenerativeAI,
  type Content,
  type GenerateContentStreamResult,
} from "@google/generative-ai";
import type { ILLMProvider, ILLMProviderOptions, ProviderMessage } from "@shared/types";

export class GeminiProvider implements ILLMProvider {
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  /**
   * Gemini uses "model" for the assistant role (not "assistant").
   * System messages are handled via systemInstruction on the model config.
   */
  private mapMessages(messages: ProviderMessage[]): {
    systemInstruction: string | undefined;
    history: Content[];
  } {
    const systemParts = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");

    const history: Content[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    return {
      systemInstruction: systemParts.length > 0 ? systemParts : undefined,
      history,
    };
  }

  async complete(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): Promise<{ content: string; tokensUsed: number }> {
    const { systemInstruction, history } = this.mapMessages(messages);

    // The last message must be the user turn; it's sent via sendMessage
    const lastMessage = history.pop();
    if (!lastMessage) throw new Error("GeminiProvider: no user message");

    const model = this.client.getGenerativeModel({
      model: modelId,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        maxOutputTokens: options?.maxTokens ?? 4096,
        temperature: options?.temperature ?? 0.7,
      },
    });

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(
      lastMessage.parts.map((p) => p.text ?? "").join(""),
    );

    const response = result.response;
    const content = response.text();
    const tokensUsed = response.usageMetadata?.totalTokenCount ?? 0;

    return { content, tokensUsed };
  }

  async *stream(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): AsyncGenerator<string> {
    const { systemInstruction, history } = this.mapMessages(messages);

    const lastMessage = history.pop();
    if (!lastMessage) throw new Error("GeminiProvider: no user message");

    const model = this.client.getGenerativeModel({
      model: modelId,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        maxOutputTokens: options?.maxTokens ?? 4096,
        temperature: options?.temperature ?? 0.7,
      },
    });

    const chat = model.startChat({ history });
    const result: GenerateContentStreamResult = await chat.sendMessageStream(
      lastMessage.parts.map((p) => p.text ?? "").join(""),
    );

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) yield text;
    }
  }
}
```

**Package needed**: `@google/generative-ai` — add to `package.json` dependencies.

**Role mapping rule**: `"assistant"` → `"model"` is applied in `mapMessages`. Gemini's chat API requires the last message to be from the user; the implementation pops the final message from `history` and sends it via `sendMessage`/`sendMessageStream`. This is the correct Gemini SDK pattern.

---

## 7. GrokProvider

Create `server/gateway/providers/grok.ts`. Extends `OpenAICompatibleProvider`.

```typescript
// server/gateway/providers/grok.ts

import { OpenAICompatibleProvider } from "./openai-compatible";

const XAI_BASE_URL = "https://api.x.ai/v1";

export class GrokProvider extends OpenAICompatibleProvider {
  constructor(apiKey: string) {
    // xAI uses standard Bearer auth; base URL is fixed
    super(XAI_BASE_URL, apiKey);
  }
  // complete() and stream() are fully inherited from OpenAICompatibleProvider.
  // No overrides needed — xAI's API is OpenAI-wire-compatible.
}
```

That's the entire file. The base class handles headers (`Authorization: Bearer {apiKey}`), SSE parsing, and the `/v1/chat/completions` endpoint. GrokProvider provides only the two constructor arguments.

---

## 8. PostgreSQL Persistence Activation

### Step 1: Create `server/db.ts`

This file must not exist yet. Create it:

```typescript
// server/db.ts — NEW FILE

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });
```

### Step 2: Create `server/storage-pg.ts`

Create a Drizzle-backed implementation of `IStorage`. This is a new file alongside the existing `storage.ts`:

```typescript
// server/storage-pg.ts — NEW FILE

import { eq, desc, and, isNull, or } from "drizzle-orm";
import { db } from "./db";
import type { IStorage } from "./storage";
import {
  users, models, pipelines, pipelineRuns,
  stageExecutions, questions, chatMessages,
  type User, type InsertUser,
  type Model, type InsertModel,
  type Pipeline, type InsertPipeline,
  type PipelineRun, type InsertPipelineRun,
  type StageExecution, type InsertStageExecution,
  type Question, type InsertQuestion,
  type ChatMessage, type InsertChatMessage,
} from "@shared/schema";

export class PgStorage implements IStorage {

  // ─── Users ──────────────────────────────────────────

  async getUser(id: string): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.id, id));
    return row;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.username, username));
    return row;
  }

  async createUser(user: InsertUser): Promise<User> {
    const [row] = await db.insert(users).values(user).returning();
    return row;
  }

  // ─── Models ─────────────────────────────────────────

  async getModels(): Promise<Model[]> {
    return db.select().from(models);
  }

  async getActiveModels(): Promise<Model[]> {
    return db.select().from(models).where(eq(models.isActive, true));
  }

  async getModelBySlug(slug: string): Promise<Model | undefined> {
    const [row] = await db.select().from(models).where(eq(models.slug, slug));
    return row;
  }

  async createModel(model: InsertModel): Promise<Model> {
    const [row] = await db.insert(models).values(model).returning();
    return row;
  }

  async updateModel(id: string, updates: Partial<InsertModel>): Promise<Model> {
    const [row] = await db
      .update(models)
      .set(updates)
      .where(eq(models.id, id))
      .returning();
    if (!row) throw new Error(`Model not found: ${id}`);
    return row;
  }

  async deleteModel(id: string): Promise<void> {
    await db.delete(models).where(eq(models.id, id));
  }

  // ─── Pipelines ──────────────────────────────────────

  async getPipelines(): Promise<Pipeline[]> {
    return db.select().from(pipelines);
  }

  async getPipeline(id: string): Promise<Pipeline | undefined> {
    const [row] = await db.select().from(pipelines).where(eq(pipelines.id, id));
    return row;
  }

  async getTemplates(): Promise<Pipeline[]> {
    return db.select().from(pipelines).where(eq(pipelines.isTemplate, true));
  }

  async createPipeline(pipeline: InsertPipeline): Promise<Pipeline> {
    const [row] = await db.insert(pipelines).values(pipeline).returning();
    return row;
  }

  async updatePipeline(id: string, updates: Partial<InsertPipeline>): Promise<Pipeline> {
    const [row] = await db
      .update(pipelines)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(pipelines.id, id))
      .returning();
    if (!row) throw new Error(`Pipeline not found: ${id}`);
    return row;
  }

  async deletePipeline(id: string): Promise<void> {
    await db.delete(pipelines).where(eq(pipelines.id, id));
  }

  // ─── Pipeline Runs ──────────────────────────────────

  async getPipelineRuns(pipelineId?: string): Promise<PipelineRun[]> {
    if (pipelineId) {
      return db
        .select()
        .from(pipelineRuns)
        .where(eq(pipelineRuns.pipelineId, pipelineId))
        .orderBy(desc(pipelineRuns.createdAt));
    }
    return db.select().from(pipelineRuns).orderBy(desc(pipelineRuns.createdAt));
  }

  async getPipelineRun(id: string): Promise<PipelineRun | undefined> {
    const [row] = await db
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, id));
    return row;
  }

  async createPipelineRun(run: InsertPipelineRun): Promise<PipelineRun> {
    const [row] = await db.insert(pipelineRuns).values(run).returning();
    return row;
  }

  async updatePipelineRun(id: string, updates: Partial<PipelineRun>): Promise<PipelineRun> {
    const [row] = await db
      .update(pipelineRuns)
      .set(updates)
      .where(eq(pipelineRuns.id, id))
      .returning();
    if (!row) throw new Error(`Run not found: ${id}`);
    return row;
  }

  // ─── Stage Executions ───────────────────────────────

  async getStageExecutions(runId: string): Promise<StageExecution[]> {
    return db
      .select()
      .from(stageExecutions)
      .where(eq(stageExecutions.runId, runId))
      .orderBy(stageExecutions.stageIndex);
  }

  async getStageExecution(id: string): Promise<StageExecution | undefined> {
    const [row] = await db
      .select()
      .from(stageExecutions)
      .where(eq(stageExecutions.id, id));
    return row;
  }

  async createStageExecution(execution: InsertStageExecution): Promise<StageExecution> {
    const [row] = await db.insert(stageExecutions).values(execution).returning();
    return row;
  }

  async updateStageExecution(
    id: string,
    updates: Partial<StageExecution>,
  ): Promise<StageExecution> {
    const [row] = await db
      .update(stageExecutions)
      .set(updates)
      .where(eq(stageExecutions.id, id))
      .returning();
    if (!row) throw new Error(`Stage execution not found: ${id}`);
    return row;
  }

  // ─── Questions ──────────────────────────────────────

  async getQuestions(runId: string): Promise<Question[]> {
    return db
      .select()
      .from(questions)
      .where(eq(questions.runId, runId))
      .orderBy(questions.createdAt);
  }

  async getPendingQuestions(runId?: string): Promise<Question[]> {
    if (runId) {
      return db
        .select()
        .from(questions)
        .where(
          and(eq(questions.status, "pending"), eq(questions.runId, runId)),
        );
    }
    return db
      .select()
      .from(questions)
      .where(eq(questions.status, "pending"));
  }

  async getQuestion(id: string): Promise<Question | undefined> {
    const [row] = await db
      .select()
      .from(questions)
      .where(eq(questions.id, id));
    return row;
  }

  async createQuestion(question: InsertQuestion): Promise<Question> {
    const [row] = await db.insert(questions).values(question).returning();
    return row;
  }

  async answerQuestion(id: string, answer: string): Promise<Question> {
    const [row] = await db
      .update(questions)
      .set({ answer, status: "answered", answeredAt: new Date() })
      .where(eq(questions.id, id))
      .returning();
    if (!row) throw new Error(`Question not found: ${id}`);
    return row;
  }

  async dismissQuestion(id: string): Promise<Question> {
    const [row] = await db
      .update(questions)
      .set({ status: "dismissed" })
      .where(eq(questions.id, id))
      .returning();
    if (!row) throw new Error(`Question not found: ${id}`);
    return row;
  }

  // ─── Chat Messages ──────────────────────────────────

  async getChatMessages(runId?: string, limit?: number): Promise<ChatMessage[]> {
    let query = db
      .select()
      .from(chatMessages)
      .orderBy(chatMessages.createdAt)
      .$dynamic();

    if (runId) {
      query = query.where(eq(chatMessages.runId, runId));
    }

    const rows = await query;
    return limit ? rows.slice(-limit) : rows;
  }

  async createChatMessage(message: InsertChatMessage): Promise<ChatMessage> {
    const [row] = await db.insert(chatMessages).values(message).returning();
    return row;
  }
}
```

### Step 3: Switch the singleton in `server/storage.ts`

Change only the export at the bottom of `storage.ts`. The `MemStorage` class stays in place for tests. The exported `storage` singleton switches to PgStorage when `DATABASE_URL` is set:

```typescript
// server/storage.ts — REPLACE the last line (line 369):

// BEFORE:
export const storage = new MemStorage();

// AFTER:
import { PgStorage } from "./storage-pg";

export const storage: IStorage = process.env.DATABASE_URL
  ? new PgStorage()
  : new MemStorage();
```

**Important**: This import must be placed at the top of the file with the other imports, not inline. The inline placement above is shown only for clarity.

### Step 4: Apply the schema migration

```bash
DATABASE_URL=postgresql://... npm run db:push
```

This applies the `model_id` column addition and any other schema drift. No migration file is needed — `drizzle-kit push` applies diffs directly for development.

### What does NOT change in `server/index.ts`

Nothing. The `routes.ts` file imports `storage` from `./storage`, which now returns `PgStorage` when `DATABASE_URL` is present. The `registerRoutes` function is unmodified.

---

## 9. New Default Models in `shared/constants.ts`

Add these entries to the `DEFAULT_MODELS` array. These are seeded only when the models table is empty (the existing seed guard in `routes.ts` already handles this).

```typescript
// shared/constants.ts — ADD to DEFAULT_MODELS array

// ─── Anthropic ──────────────────────────────────────
{
  name: "Claude Sonnet 4.6",
  slug: "claude-sonnet-4-6",
  modelId: "claude-sonnet-4-6",
  provider: "anthropic" as const,
  endpoint: null,
  contextLimit: 200000,
  capabilities: ["planning", "architecture", "code_review", "reasoning", "general"],
  isActive: true,
},
{
  name: "Claude Haiku 4.5",
  slug: "claude-haiku-4-5",
  modelId: "claude-haiku-4-5",
  provider: "anthropic" as const,
  endpoint: null,
  contextLimit: 200000,
  capabilities: ["testing", "summarization", "lightweight", "fast"],
  isActive: true,
},

// ─── Google ─────────────────────────────────────────
{
  name: "Gemini 2.0 Flash",
  slug: "gemini-2-0-flash",
  modelId: "gemini-2.0-flash",
  provider: "google" as const,
  endpoint: null,
  contextLimit: 1048576,
  capabilities: ["development", "testing", "analysis", "multimodal", "fast"],
  isActive: true,
},

// ─── xAI ────────────────────────────────────────────
{
  name: "Grok 3",
  slug: "grok-3",
  modelId: "grok-3",
  provider: "xai" as const,
  endpoint: null,
  contextLimit: 131072,
  capabilities: ["planning", "architecture", "development", "reasoning"],
  isActive: true,
},
{
  name: "Grok 3 Mini",
  slug: "grok-3-mini",
  modelId: "grok-3-mini",
  provider: "xai" as const,
  endpoint: null,
  contextLimit: 131072,
  capabilities: ["testing", "summarization", "lightweight", "fast"],
  isActive: true,
},
```

**Note on seeding guard**: The existing guard in `routes.ts` is `if (existingModels.length === 0)`. After switching to PostgreSQL, the first startup seeds all models including the new cloud entries. On subsequent startups, nothing is re-seeded. If the engineer needs to add models to an already-seeded database, they must use the API or a one-off migration.

**Note on `modelId` in `InsertModel`**: Since `insertModelSchema` is derived from the table via `createInsertSchema`, the `modelId` field will be picked up automatically once the column is added to the schema. No manual schema change is needed for the Zod schema.

---

## 10. Settings UI Additions (Backend Engineer deliverables)

The Frontend Engineer needs the following API surface to build the cloud providers section in `Settings.tsx`.

### 10a. Extend `GET /api/gateway/status`

The existing `getStatus()` method returns `{ vllm, ollama, vllmEndpoint, ollamaEndpoint }`. Extend it to include cloud provider connectivity:

```typescript
// Gateway.getStatus() — extended return type
{
  vllm: boolean;
  ollama: boolean;
  anthropic: boolean;         // NEW — true if ANTHROPIC_API_KEY is set
  google: boolean;            // NEW — true if GOOGLE_API_KEY is set
  xai: boolean;               // NEW — true if XAI_API_KEY is set
  vllmEndpoint: string | null;
  ollamaEndpoint: string | null;
}
```

This is already handled by the new `getStatus()` implementation in Section 2. No route change needed — `GET /api/gateway/status` calls `gateway.getStatus()` and returns the result verbatim.

### 10b. New endpoint: `POST /api/gateway/test/:provider`

Allows the frontend to test connectivity for a specific provider.

```
POST /api/gateway/test/:provider
provider: "anthropic" | "google" | "xai" | "vllm" | "ollama"

Response 200:
{ ok: true, latencyMs: number }

Response 200 (failure — don't use 4xx, provider errors are not client errors):
{ ok: false, error: string }
```

Implementation: send a minimal `complete()` call with a short "ping" prompt and a `maxTokens: 5` option. The provider is looked up from the registry. If the provider is not registered (env var not set), return `{ ok: false, error: "Provider not configured" }`.

### 10c. What the Frontend Engineer builds in `Settings.tsx`

A "Cloud Providers" section with one card per provider:

| Element | Detail |
|---------|--------|
| Provider name + icon | Anthropic / Google / xAI |
| Status badge | "Connected" (green) or "Not configured" (gray) — driven by `GET /api/gateway/status` |
| Env var hint | Show the env var name the user needs to set (e.g. `ANTHROPIC_API_KEY`) — read-only informational text |
| "Test connection" button | Calls `POST /api/gateway/test/:provider`, shows latency on success or error message |
| No API key input field | Phase 0/1: keys come from env only. The UI informs but does not accept key input. |

---

## 11. File Ownership Map

### Backend Engineer owns

| File | Action |
|------|--------|
| `shared/types.ts` | ADD `ProviderMessage`, `ILLMProviderOptions`, `ILLMProvider` |
| `shared/schema.ts` | ADD `modelId: text("model_id")` to models table |
| `shared/constants.ts` | ADD 5 new model entries to `DEFAULT_MODELS` |
| `server/db.ts` | CREATE — Drizzle + pg pool setup |
| `server/storage-pg.ts` | CREATE — full `PgStorage` class |
| `server/storage.ts` | MODIFY — switch singleton export; add `modelId` to `MemStorage.createModel` |
| `server/gateway/index.ts` | FULL REPLACEMENT — registry pattern |
| `server/gateway/providers/openai-compatible.ts` | CREATE — base class |
| `server/gateway/providers/vllm.ts` | MODIFY — extend `OpenAICompatibleProvider`, remove `complete()`/`stream()` |
| `server/gateway/providers/claude.ts` | CREATE — `ClaudeProvider` |
| `server/gateway/providers/gemini.ts` | CREATE — `GeminiProvider` |
| `server/gateway/providers/grok.ts` | CREATE — `GrokProvider` |
| `server/routes/gateway.ts` | MODIFY — add `POST /api/gateway/test/:provider` endpoint |
| `package.json` | ADD `@anthropic-ai/sdk`, `@google/generative-ai` to dependencies |

### Frontend Engineer owns

| File | Action |
|------|--------|
| `client/src/pages/Settings.tsx` | ADD "Cloud Providers" section — status display + test buttons |
| `client/src/components/pipeline/StageProgress.tsx` | ADD model slug badge per stage |

### Shared (read-only for Frontend Engineer)

| File | What the Frontend reads |
|------|------------------------|
| `shared/types.ts` | `ModelProvider` union (now includes `"anthropic" \| "google" \| "xai"`) |
| `shared/schema.ts` | `Model` type (now has `modelId: string \| null`) |

### No changes needed

| File | Reason |
|------|--------|
| `server/index.ts` | Storage swap is transparent; no wiring change |
| `server/routes.ts` | Seed logic unchanged; `storage` import is the same symbol |
| `server/gateway/providers/ollama.ts` | Ollama uses a different API format; not refactored to base class in this phase |
| `server/gateway/providers/mock.ts` | Remains duck-typed; not brought under `ILLMProvider` |
| `server/teams/` | Unchanged; already calls `gateway.complete()` which routes internally |

---

## Package Installation Summary

```bash
npm install @anthropic-ai/sdk @google/generative-ai
```

No new `@types/*` packages needed — both SDKs ship their own TypeScript declarations.

---

## Implementation Order (recommended)

1. Schema change + `db:push` (unlocks PostgreSQL, unblocks seeding with new fields)
2. `ILLMProvider` interface in `shared/types.ts` (unblocks provider files)
3. `ModelProvider` type extension in `shared/types.ts` (unblocks constants)
4. `OpenAICompatibleProvider` base class (unblocks VllmProvider refactor + GrokProvider)
5. VllmProvider refactor (extend base class)
6. `ClaudeProvider`, `GeminiProvider`, `GrokProvider` (parallel — no dependencies between them)
7. Gateway registry replacement (depends on all 3 cloud providers existing)
8. `PgStorage` + `db.ts` + storage.ts switch (can be done in parallel with steps 5-7)
9. `DEFAULT_MODELS` additions (depends on schema having `modelId`)
10. Gateway test endpoint (depends on Gateway registry)
11. Settings UI cloud provider section (depends on test endpoint + status endpoint)
12. StageProgress model badge (independent frontend task)

---

## Open Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Gemini `sendMessage` requires last message to be a user turn | Medium | The `mapMessages` implementation explicitly pops the last message and validates. Throw early if the conversation ends with an assistant turn. |
| `@anthropic-ai/sdk` streaming event shape changes with SDK versions | Low | Pin the SDK version. The `content_block_delta` + `text_delta` event types are stable in v0.x. |
| `AbortSignal.timeout()` availability | Low | Node 18+ (LTS). The project already uses Node 20 per the Dockerfile in mock.ts comments. |
| MemStorage `modelId` field missing causes TS error | Low | Add `modelId: insert.modelId ?? null` to `MemStorage.createModel` alongside the schema change. |
| Seeding new models into already-seeded databases | Medium | Document that the `DEFAULT_MODELS` seeding only runs on empty databases. Provide a one-liner SQL insert in the PR description for teams with existing data. |
