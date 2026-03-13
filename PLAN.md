# multiqlti — Implementation Plan

**Created**: 2026-03-13
**Status**: Planning — memory system designed, other design questions open (see bottom)

---

## Phase 0 — Foundation Fixes (unblock everything else)

- [ ] **Activate real PostgreSQL persistence** — Drizzle schema exists but only `MemStorage` is wired. Switch `storage.ts` to use the Drizzle PG implementation so data survives restarts.
- [ ] **Add Zod validation at API boundaries** — `Pipeline.stages` JSONB cast is unvalidated; route handlers pass `req.body` directly. Apply existing `insertModelSchema` and add stage config schema.
- [ ] **Formal `ILLMProvider` interface** — declare `interface ILLMProvider { complete(...): Promise<...>; stream(...): AsyncGenerator<string> }` in `shared/types.ts`. Retro-fit existing providers.
- [ ] **Provider registry in Gateway** — replace hard-coded if/else dispatch with `Map<string, ILLMProvider>`. Register at init, lookup at call. Eliminates 4-file edits per new provider.

---

## Phase 1 — Cloud Provider Integration (core goal)

### Backend

- [ ] **Add `api_key` + `model_id` fields to `models` schema** — decouple provider-side model ID from UI slug. Store API key encrypted at rest (or via env var fallback).
- [ ] **Update `ModelProvider` type** — extend `"vllm" | "ollama" | "mock"` to include `"anthropic" | "google" | "xai"`.
- [ ] **`ClaudeProvider`** (`server/gateway/providers/claude.ts`)
  - Use `@anthropic-ai/sdk`
  - Extract `system` role from messages array → pass as top-level `system` param (Anthropic API requirement)
  - Implement `complete()` + `stream()` (via `client.messages.stream()`, yield `event.delta.text`)
- [ ] **`GeminiProvider`** (`server/gateway/providers/gemini.ts`)
  - Use `@google/generative-ai`
  - Map `role: "assistant"` → `"model"` in message array
  - Token count from `response.usageMetadata.totalTokenCount`
  - Implement `complete()` + `stream()`
- [ ] **`GrokProvider`** (`server/gateway/providers/grok.ts`)
  - Extract `OpenAICompatibleProvider` base class from `VllmProvider` (parameterized: base URL + API key header)
  - `GrokProvider` extends it with `https://api.x.ai/v1` + `Authorization: Bearer {apiKey}`
- [ ] **Wire new providers into Gateway registry**
- [ ] **Add default model entries** in `shared/constants.ts` for Claude Sonnet/Opus/Haiku, Gemini Flash/Pro, Grok 3/mini
- [ ] **Timeout + retry on provider HTTP calls** — wrap all external calls with a configurable timeout; retry once on transient errors; surface provider errors clearly in run output

### Frontend

- [ ] **Provider API key configuration UI** (`Settings.tsx`)
  - New "Cloud Providers" section
  - Per-provider card: provider type selector, API key input (masked/show toggle), model ID field, "Test connection" button
  - Save keys to DB (or show env var instruction if env-only mode)
- [ ] **Per-stage model slug badge in `StageProgress.tsx`** — show which model is running each stage during live runs

---

## Phase 2 — Multi-model Pipeline UX

- [ ] **System prompt override editor per stage** (`AgentNode.tsx`) — expandable `<Textarea>` for `systemPromptOverride`. Already in the type, just needs UI.
- [ ] **Per-stage temperature + maxTokens** — add fields to `PipelineStageConfig`; expose sliders/inputs in `AgentNode.tsx`
- [ ] **Multi-pipeline selector** (`Workflow.tsx` + `MultiAgentPipeline.tsx`) — remove `pipelines[0]` hardcoding; add pipeline list/tabs/dropdown
- [ ] **Strategy presets** (optional) — named presets like "Claude for reasoning + Grok for code + Gemini for testing" that pre-fill stage model assignments

---

## Phase 3 — Quality & Reliability

- [ ] **Grok as fact-checker / web search agent** — Grok's strong suit is real-time web search and fact-checking. Add a dedicated `FactCheckTeam` (or optional pipeline stage) that uses Grok to verify claims, check for hallucinations, and enrich outputs with live web data. This can run:
  - As a **post-stage hook** — after any stage completes, Grok validates its output against web sources
  - As a **standalone pipeline stage** — inserted between Code Review and Deployment to verify architectural decisions, library versions, and security advisories
  - As a **parallel branch** — fact-checking runs alongside Development/Testing without blocking the pipeline
  - xAI API supports `search` tool / live web grounding — leverage this for real-time verification
- [ ] **Full-pipeline context accumulation** — stages currently only see `previousOutputs[i-1]`. Pass full `previousOutputs` array; update team `buildPrompt` methods to summarize prior context.
- [ ] **Replace mock dashboard data** (`Dashboard.tsx`) — wire traffic chart to real run/token telemetry API. Remove or update "Data Exfiltration: 0 B / locally contained" stat (breaks when cloud providers are added).
- [ ] **Eliminate redundant polling** — polling fires alongside WebSocket. Switch to WS-only for live run data; keep polling only as reconnect fallback.
- [ ] **Syntax highlighting in code blocks** (`StageOutput.tsx`, `CodePreview.tsx`) — add Shiki or Prism for language-aware rendering.
- [ ] **Error boundaries** — wrap all pages and heavy components with `<ErrorBoundary>` to prevent full-app crashes.
- [ ] **Chat page fixes**:
  - Default `selectedModel` to `models[0]?.slug` after query resolves (not hardcoded `"llama3-70b"`)
  - Persist chat history via API or `localStorage`
  - Remove or implement paperclip attachment button
- [ ] **Settings page — manual model entry** — add "Add model manually" form for non-discoverable deployments. Allow editing model capabilities after import.

### 3.1 — MCP, Tools & Knowledge Bases

> Цель: дать pipeline stages доступ к инструментам — веб-поиск, базы знаний, код, инфраструктура — через MCP протокол и встроенные tools. Модель сама решает когда и какой инструмент вызвать (agentic loop).

#### 3.1.0 — Архитектура: Agentic Tool Loop

```
┌──────────────┐
│  BaseTeam     │
│  .execute()   │
└──────┬───────┘
       │ messages + tools[]
       ▼
┌──────────────────────────┐
│  Gateway.completeWithTools()  │  ← НОВЫЙ метод
│                               │
│  loop {                       │
│    response = provider.complete(messages, tools)  │
│                               │
│    if response.tool_calls:    │
│      for each call:           │
│        result = toolRegistry.execute(call)        │
│        messages.push(tool_result)                 │
│      continue loop            │
│                               │
│    if response.content:       │
│      break (final answer)     │
│  }                            │
│  max iterations: 10           │
└──────────────────────────────┘
       │ final content + tool call log
       ▼
┌──────────────┐
│  TeamResult   │
│  + toolCalls[]│
└──────────────┘
```

**Ключевой принцип**: модель решает вызывать ли инструмент. Мы даём ей список доступных tools, она возвращает `tool_use` блоки. Gateway исполняет их и передаёт результат обратно. Цикл до финального текстового ответа (max 10 итераций).

#### 3.1.1 — Расширение ILLMProvider для Tool Calling

- [ ] **Новый тип `ToolDefinition`**:
  ```typescript
  // shared/types.ts
  export interface ToolDefinition {
    name: string;                              // unique ID: "web_search", "mcp__github__search_code"
    description: string;                       // для модели: когда вызывать
    inputSchema: Record<string, unknown>;      // JSON Schema параметров
    source: "builtin" | "mcp";                 // откуда инструмент
    mcpServer?: string;                        // имя MCP сервера (если source=mcp)
  }

  export interface ToolCall {
    id: string;                                // уникальный ID вызова
    name: string;                              // имя инструмента
    arguments: Record<string, unknown>;        // аргументы от модели
  }

  export interface ToolResult {
    toolCallId: string;
    content: string;                           // результат исполнения
    isError?: boolean;
  }

  // Расширенный ProviderMessage для tool calling
  export type ProviderMessage =
    | { role: "system" | "user" | "assistant"; content: string }
    | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
    | { role: "tool"; toolCallId: string; content: string };
  ```

- [ ] **Расширить `ILLMProviderOptions`**:
  ```typescript
  export interface ILLMProviderOptions {
    maxTokens?: number;
    temperature?: number;
    tools?: ToolDefinition[];                  // ← НОВОЕ: доступные инструменты
    toolChoice?: "auto" | "none" | "required"; // ← НОВОЕ: стратегия вызова
  }
  ```

- [ ] **Расширить return type `complete()`**:
  ```typescript
  complete(...): Promise<{
    content: string;
    tokensUsed: number;
    inputTokens?: number;
    outputTokens?: number;
    toolCalls?: ToolCall[];                    // ← НОВОЕ: если модель хочет вызвать инструмент
    finishReason: "stop" | "tool_use";         // ← НОВОЕ
  }>
  ```

- [ ] **Имплементация в каждом провайдере**:
  - **ClaudeProvider**: Anthropic API нативно поддерживает tools — `tools` param + `tool_use` content blocks
  - **GeminiProvider**: Google API поддерживает `functionDeclarations` + `functionCall` response parts
  - **GrokProvider**: xAI OpenAI-compatible — `tools` param + `tool_calls` в response (как OpenAI)
  - **VllmProvider/OllamaProvider**: зависит от модели, но OpenAI-compatible format поддерживается vLLM

#### 3.1.2 — Tool Registry (`server/tools/registry.ts`)

- [ ] **Единый реестр всех доступных инструментов**:
  ```typescript
  class ToolRegistry {
    private tools: Map<string, ToolHandler> = new Map();

    register(name: string, handler: ToolHandler): void;
    unregister(name: string): void;
    getAvailableTools(filter?: { tags?: string[], source?: string }): ToolDefinition[];
    async execute(call: ToolCall): Promise<ToolResult>;
  }

  interface ToolHandler {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
  }
  ```

- [ ] **Категории инструментов**:
  ```
  ToolRegistry
  ├── builtin/          — встроенные инструменты (web search, RAG, code)
  │   ├── web_search        — поиск в интернете
  │   ├── url_reader        — извлечение контента из URL
  │   ├── knowledge_search  — RAG по llm_requests + docs
  │   ├── code_search       — поиск по codebase (grep/ast)
  │   ├── file_read         — чтение файла из workspace
  │   └── calculator        — вычисления
  │
  └── mcp/              — инструменты из подключённых MCP серверов
      ├── github__*         — GitHub операции
      ├── terraform__*      — Terraform docs/commands
      ├── kubernetes__*     — K8s cluster operations
      ├── notion__*         — Notion pages/databases
      └── {custom}__*       — любой пользовательский MCP сервер
  ```

#### 3.1.3 — MCP Client Manager (`server/tools/mcp-client.ts`)

- [ ] **Подключение к внешним MCP серверам** через `@modelcontextprotocol/sdk`:
  ```typescript
  class McpClientManager {
    private connections: Map<string, McpConnection> = new Map();

    // Подключить MCP сервер
    async connect(config: McpServerConfig): Promise<void>;
    // Отключить
    async disconnect(serverName: string): Promise<void>;
    // Получить все tools от всех подключённых серверов
    getTools(): ToolDefinition[];
    // Вызвать tool на конкретном сервере
    async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string>;
    // Статус подключений
    getStatus(): Record<string, { connected: boolean; tools: number; error?: string }>;
  }

  interface McpServerConfig {
    name: string;                             // уникальное имя: "github", "terraform", "my-notion"
    transport: "stdio" | "sse" | "streamable-http";
    command?: string;                         // для stdio: путь к бинарнику
    args?: string[];                          // аргументы команды
    url?: string;                             // для sse/http: URL сервера
    env?: Record<string, string>;             // переменные окружения (API ключи и т.д.)
    enabled: boolean;
    autoConnect: boolean;                     // подключать при старте приложения
  }
  ```

- [ ] **DB: таблица `mcp_servers`** — хранение конфигураций:
  ```typescript
  export const mcpServers = pgTable("mcp_servers", {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull().unique(),
    transport: text("transport").notNull(),     // "stdio" | "sse" | "streamable-http"
    command: text("command"),
    args: jsonb("args"),
    url: text("url"),
    env: jsonb("env"),                          // encrypted env vars
    enabled: boolean("enabled").notNull().default(true),
    autoConnect: boolean("auto_connect").notNull().default(false),
    toolCount: integer("tool_count").default(0),
    lastConnectedAt: timestamp("last_connected_at"),
    createdAt: timestamp("created_at").defaultNow(),
  });
  ```

#### 3.1.4 — Встроенные инструменты (Built-in Tools)

##### Web Search

- [ ] **`web_search`** — поиск в интернете:
  ```typescript
  // server/tools/builtin/web-search.ts
  // Поддержка нескольких провайдеров через абстракцию:

  interface SearchProvider {
    search(query: string, options?: { limit?: number; domain?: string }): Promise<SearchResult[]>;
  }

  // Реализации:
  class TavilySearch implements SearchProvider { }   // TAVILY_API_KEY — лучшее качество, платный
  class BraveSearch implements SearchProvider { }    // BRAVE_API_KEY — бесплатный tier
  class ExaSearch implements SearchProvider { }      // EXA_API_KEY — semantic search
  class DuckDuckGoSearch implements SearchProvider { } // бесплатный, без API ключа

  // Tool definition:
  {
    name: "web_search",
    description: "Search the internet for current information. Use when you need up-to-date data, documentation, library versions, or facts you're not sure about.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", default: 5 },
      },
      required: ["query"]
    }
  }
  ```

- [ ] **`url_reader`** — извлечение контента из URL:
  ```typescript
  // Jina AI Reader (https://r.jina.ai/{url}) или Firecrawl
  {
    name: "url_reader",
    description: "Read and extract content from a web page URL. Returns clean markdown text.",
    inputSchema: {
      properties: {
        url: { type: "string" },
        format: { enum: ["markdown", "text", "html"], default: "markdown" }
      }
    }
  }
  ```

##### Knowledge Base / RAG

- [ ] **`knowledge_search`** — поиск по внутренней базе знаний (RAG из `llm_requests` таблицы из Phase 3.2):
  ```typescript
  {
    name: "knowledge_search",
    description: "Search through previous pipeline runs, LLM responses, and project knowledge. Use when a similar question may have been answered before.",
    inputSchema: {
      properties: {
        query: { type: "string" },
        scope: { enum: ["all", "this_pipeline", "this_run"], default: "all" },
        limit: { type: "number", default: 5 }
      }
    }
  }
  ```
  **Реализация**:
  - Phase 1: PostgreSQL full-text search по `llm_requests.responseContent` (pg_trgm)
  - Phase 2: pgvector embeddings — `CREATE EXTENSION vector` + embedding column + cosine similarity
  - Phase 3: External vector store (Qdrant/Pinecone) для масштабирования

- [ ] **`memory_search`** — поиск по памяти системы (из Phase 3.3):
  ```typescript
  {
    name: "memory_search",
    description: "Search project memories — decisions, patterns, known issues, user preferences. Use to recall what was decided or learned in previous runs.",
    inputSchema: {
      properties: {
        query: { type: "string" },
        type: { enum: ["decision", "pattern", "fact", "preference", "issue", "dependency"] }
      }
    }
  }
  ```

##### Code & Files

- [ ] **`code_search`** — поиск по кодовой базе workspace (Phase 4 dependency):
  ```typescript
  {
    name: "code_search",
    description: "Search through the project codebase. Find functions, classes, patterns, or text across all source files.",
    inputSchema: {
      properties: {
        query: { type: "string" },
        type: { enum: ["text", "filename", "symbol"], default: "text" },
        filePattern: { type: "string", description: "Glob pattern, e.g. '*.ts'" }
      }
    }
  }
  ```

- [ ] **`file_read`** — чтение файла из workspace:
  ```typescript
  {
    name: "file_read",
    description: "Read the content of a file from the workspace.",
    inputSchema: {
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" }
      },
      required: ["path"]
    }
  }
  ```

#### 3.1.5 — Рекомендуемые MCP серверы

| MCP сервер | Что даёт | Какие stages используют | Env vars |
|------------|----------|------------------------|----------|
| **GitHub** (`@modelcontextprotocol/server-github`) | Repos, issues, PRs, code search | Development, Code Review, Monitoring | `GITHUB_TOKEN` |
| **Terraform** (`hashicorp/terraform-mcp-server`) | Provider docs, module search | Architecture, Deployment | — |
| **Kubernetes** (`kubernetes-mcp-server`) | Pods, deployments, logs, events | Deployment, Monitoring | `KUBECONFIG` |
| **PostgreSQL** (`@modelcontextprotocol/server-postgres`) | Query DB for context | All stages (project data) | `DATABASE_URL` |
| **Filesystem** (`@modelcontextprotocol/server-filesystem`) | Read/write workspace files | Development, Testing | workspace path |
| **Notion** (`notion-mcp-server`) | Pages, databases | Planning, Architecture | `NOTION_TOKEN` |
| **Confluence** (`confluence-mcp-server`) | Wiki pages | Planning, Architecture | `CONFLUENCE_*` |
| **Slack** (`slack-mcp-server`) | Messages, channels | Monitoring, notifications | `SLACK_TOKEN` |
| **Brave Search** (`@anthropic/brave-search-mcp`) | Web search | All stages | `BRAVE_API_KEY` |
| **Memory** (custom, built-in) | Project memory from 3.3 | All stages | — |

#### 3.1.6 — Per-Stage Tool Assignment

- [ ] **Расширить `PipelineStageConfig`**:
  ```typescript
  export interface PipelineStageConfig {
    teamId: TeamId;
    modelSlug: string;
    systemPromptOverride?: string;
    enabled: boolean;
    sandbox?: SandboxConfig;
    tools?: StageToolConfig;              // ← НОВОЕ
  }

  export interface StageToolConfig {
    enabled: boolean;                     // вкл/выкл tools для stage
    allowedTools?: string[];              // whitelist tool names (null = all available)
    blockedTools?: string[];              // blacklist (useful for security)
    maxToolCalls?: number;                // лимит вызовов за stage (default: 10)
    toolChoice?: "auto" | "none" | "required";
  }
  ```

- [ ] **Default tool assignments по team type**:
  ```typescript
  export const DEFAULT_TEAM_TOOLS: Record<TeamId, string[]> = {
    planning:     ["web_search", "knowledge_search", "memory_search"],
    architecture: ["web_search", "knowledge_search", "memory_search", "code_search"],
    development:  ["web_search", "code_search", "file_read", "knowledge_search"],
    testing:      ["code_search", "file_read", "knowledge_search"],
    code_review:  ["web_search", "code_search", "file_read", "knowledge_search", "memory_search"],
    deployment:   ["web_search", "knowledge_search", "memory_search"],
    monitoring:   ["web_search", "knowledge_search"],
  };
  ```

#### 3.1.7 — Gateway: completeWithTools()

- [ ] **Новый метод в Gateway** — agentic tool loop:
  ```typescript
  async completeWithTools(request: GatewayRequest & {
    tools: ToolDefinition[];
    maxIterations?: number;
  }): Promise<GatewayResponse & { toolCallLog: ToolCallLogEntry[] }> {

    const messages = [...request.messages];
    const toolCallLog: ToolCallLogEntry[] = [];
    let totalTokens = 0;

    for (let i = 0; i < (request.maxIterations ?? 10); i++) {
      const result = await provider.complete(modelId, messages, {
        ...options,
        tools: request.tools,
        toolChoice: i === 0 ? "auto" : "auto",
      });

      totalTokens += result.tokensUsed;

      // Модель вернула финальный ответ
      if (result.finishReason === "stop" || !result.toolCalls?.length) {
        return { content: result.content, tokensUsed: totalTokens, toolCallLog, ... };
      }

      // Модель хочет вызвать инструменты
      messages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });

      for (const call of result.toolCalls) {
        const toolResult = await this.toolRegistry.execute(call);
        messages.push({ role: "tool", toolCallId: call.id, content: toolResult.content });
        toolCallLog.push({ iteration: i, call, result: toolResult });
      }
    }

    // Max iterations reached — return last content
    return { content: messages.at(-1)?.content ?? "", tokensUsed: totalTokens, toolCallLog, ... };
  }
  ```

- [ ] **BaseTeam обновление** — использовать `completeWithTools` если tools включены:
  ```typescript
  // base.ts — execute()
  const tools = this.getAvailableTools(context);  // из StageToolConfig + defaults

  const response = tools.length > 0
    ? await this.gateway.completeWithTools({ modelSlug, messages, tools })
    : await this.gateway.complete({ modelSlug, messages });
  ```

#### 3.1.8 — API Endpoints

- [ ] **MCP Server management**:
  ```
  GET    /api/mcp/servers              — список подключённых MCP серверов
  POST   /api/mcp/servers              — добавить MCP сервер
  PUT    /api/mcp/servers/:id          — обновить конфигурацию
  DELETE /api/mcp/servers/:id          — удалить
  POST   /api/mcp/servers/:id/connect  — подключиться
  POST   /api/mcp/servers/:id/disconnect — отключиться
  GET    /api/mcp/servers/:id/tools    — список tools от сервера
  POST   /api/mcp/servers/:id/test     — тестовый вызов
  ```

- [ ] **Tools**:
  ```
  GET    /api/tools                    — все доступные инструменты (builtin + mcp)
  GET    /api/tools/builtin            — только встроенные
  GET    /api/tools/status             — статус провайдеров (какие API ключи настроены)
  POST   /api/tools/:name/test         — тестовый вызов инструмента
  ```

#### 3.1.9 — Frontend

- [ ] **Settings → Tools & MCP** — новая секция:
  - Встроенные инструменты: статус (configured/not), env var hints
  - MCP серверы: список, add/remove, connect/disconnect, test
  - Каждый сервер: иконка, имя, transport, tool count, status badge

- [ ] **Pipeline Builder → Stage config → Tools tab**:
  - Toggle "Enable tool calling" per stage
  - Checklist доступных tools (pre-selected по DEFAULT_TEAM_TOOLS)
  - Max iterations slider
  - Tool choice selector (auto/none/required)

- [ ] **Stage output → Tool calls section**:
  - Collapsible log tool вызовов: tool name, args, result, duration
  - Иконки по типу tool (search, code, file, mcp)

#### 3.1.10 — Пакеты

```bash
npm install @modelcontextprotocol/sdk                # MCP client
npm install @anthropic-ai/sdk                         # уже есть — поддерживает tools
npm install @tavily/core                              # Tavily search (optional)
```

#### 3.1.11 — Порядок реализации

1. Types: `ToolDefinition`, `ToolCall`, `ToolResult`, расширение `ProviderMessage`
2. `ToolRegistry` — базовый registry + execute
3. Расширить `ILLMProvider.complete()` для tool calling
4. Имплементация tool calling в ClaudeProvider (Anthropic API нативно)
5. `Gateway.completeWithTools()` — agentic loop
6. Built-in tools: `web_search` (Tavily/DuckDuckGo), `url_reader`
7. Built-in tools: `knowledge_search` (PostgreSQL full-text)
8. `McpClientManager` — подключение внешних MCP серверов
9. Per-stage tool config в `PipelineStageConfig`
10. `BaseTeam` обновление — автовыбор completeWithTools
11. DB: `mcp_servers` таблица
12. API endpoints
13. Frontend: Settings → Tools & MCP
14. Frontend: Pipeline Builder → tool config per stage
15. Frontend: Stage output → tool call log

#### Связи с другими фазами

| Зависит от | Что даёт |
|------------|----------|
| Phase 3.2 (llm_requests) | `knowledge_search` ищет по сохранённым ответам |
| Phase 3.3 (memory) | `memory_search` ищет по памяти проекта |
| Phase 3.5 (sandbox) | Sandbox может вызываться как tool (`code_execute`) |
| Phase 4 (workspace) | `code_search` и `file_read` работают с workspace файлами |

### 3.1b — Other DeerFlow-Inspired Features

- [ ] **Parallel sub-agent execution** — allow pipeline stages to spawn parallel sub-tasks. Example: Development stage can fan out into frontend + backend + database sub-agents, each on a different model, then merge results
- [ ] **Persistent memory across runs** — see **Memory System Design** (3.3) below for full architecture
- [ ] **Skills system (markdown-based)** — extensible skill definitions as markdown files. Each skill = system prompt + tools + output schema. Users can create custom skills and assign them to pipeline stages

### 3.2 — Statistics, Request Log & Cost Tracking

> Цель: детальная статистика использования моделей, хранение всех запросов/ответов для последующего RAG и fine-tuning inference.

#### 3.2.1 — DB: таблица `llm_requests` (лог всех LLM-вызовов)

- [ ] **Новая таблица `llm_requests`** — каждый вызов к провайдеру записывается:
  ```typescript
  // shared/schema.ts
  export const llmRequests = pgTable("llm_requests", {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    // Контекст вызова
    runId: varchar("run_id").references(() => pipelineRuns.id),       // nullable — standalone chat тоже логируется
    stageExecutionId: varchar("stage_execution_id").references(() => stageExecutions.id),
    // Модель и провайдер
    modelSlug: text("model_slug").notNull(),
    modelId: text("model_id").notNull(),                              // provider-side ID (claude-sonnet-4-6, grok-3, etc.)
    provider: text("provider").notNull(),                              // anthropic, google, xai, vllm, ollama
    // Запрос
    messages: jsonb("messages").notNull(),                             // полный массив messages (для RAG/replay)
    systemPrompt: text("system_prompt"),                               // system prompt отдельно для удобства поиска
    temperature: real("temperature"),
    maxTokens: integer("max_tokens"),
    // Ответ
    responseContent: text("response_content").notNull(),               // полный текст ответа
    responseRaw: jsonb("response_raw"),                                // raw provider response (для debug)
    // Метрики
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),             // время от запроса до полного ответа
    estimatedCostUsd: real("estimated_cost_usd"),                      // расчёт по прайсу модели
    // Мета
    status: text("status").notNull().default("success"),               // success | error | timeout
    errorMessage: text("error_message"),
    teamId: text("team_id"),                                           // planning, development, testing, etc.
    tags: jsonb("tags").default(sql`'[]'::jsonb`),                     // произвольные теги для фильтрации
    createdAt: timestamp("created_at").defaultNow(),
  });
  ```

- [ ] **Индексы** для быстрой аналитики:
  ```sql
  CREATE INDEX idx_llm_requests_model ON llm_requests(model_slug, created_at);
  CREATE INDEX idx_llm_requests_provider ON llm_requests(provider, created_at);
  CREATE INDEX idx_llm_requests_run ON llm_requests(run_id);
  CREATE INDEX idx_llm_requests_created ON llm_requests(created_at);
  ```

#### 3.2.2 — Gateway: логирование запросов

- [ ] **Обернуть `Gateway.complete()` и `Gateway.stream()`** — записывать каждый вызов в `llm_requests`:
  ```typescript
  // Gateway.complete() — после получения результата
  const startTime = Date.now();
  const result = await provider.complete(modelId, messages, options);
  const latencyMs = Date.now() - startTime;

  await this.storage.createLlmRequest({
    runId, stageExecutionId, modelSlug, modelId, provider: providerKey,
    messages, systemPrompt, temperature, maxTokens,
    responseContent: result.content,
    inputTokens: result.inputTokens ?? 0,
    outputTokens: result.outputTokens ?? 0,
    totalTokens: result.tokensUsed,
    latencyMs,
    estimatedCostUsd: this.estimateCost(providerKey, modelId, result.inputTokens, result.outputTokens),
    teamId, status: "success",
  });
  ```

- [ ] **Расширить `GatewayRequest`** — добавить optional `runId`, `stageExecutionId`, `teamId` для связки с контекстом pipeline

- [ ] **`ILLMProvider` возвращает раздельные токены** — расширить return type:
  ```typescript
  complete(...): Promise<{ content: string; tokensUsed: number; inputTokens?: number; outputTokens?: number }>
  ```

- [ ] **Таблица цен `MODEL_PRICING`** в `shared/constants.ts`:
  ```typescript
  export const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
    "claude-sonnet-4-6":  { inputPer1M: 3.00,  outputPer1M: 15.00 },
    "claude-haiku-4-5":   { inputPer1M: 0.80,  outputPer1M: 4.00 },
    "gemini-2.0-flash":   { inputPer1M: 0.075, outputPer1M: 0.30 },
    "grok-3":             { inputPer1M: 3.00,  outputPer1M: 15.00 },
    "grok-3-mini":        { inputPer1M: 0.30,  outputPer1M: 0.50 },
    "vllm":               { inputPer1M: 0,     outputPer1M: 0 },
    "ollama":             { inputPer1M: 0,     outputPer1M: 0 },
  };
  ```

#### 3.2.3 — API: эндпоинты статистики

- [ ] **`GET /api/stats/overview`** — общая сводка:
  ```json
  { "totalRequests": 1234, "totalTokens": { "input": 890000, "output": 340000 }, "totalCostUsd": 4.56, "totalRuns": 42 }
  ```

- [ ] **`GET /api/stats/by-model`** — статистика по каждой модели:
  ```json
  [{ "modelSlug": "claude-sonnet-4-6", "provider": "anthropic", "requests": 456, "tokens": { "input": 320000, "output": 120000 }, "costUsd": 2.76, "avgLatencyMs": 2340, "errorRate": 0.02 }]
  ```

- [ ] **`GET /api/stats/by-provider`** — агрегация по провайдерам

- [ ] **`GET /api/stats/by-team`** — агрегация по SDLC team (planning, development, testing, ...)

- [ ] **`GET /api/stats/by-run/:runId`** — стоимость и токены конкретного run'а

- [ ] **`GET /api/stats/timeline`** — временной ряд для графиков:
  ```
  ?granularity=hour|day|week  &from=...  &to=...  &groupBy=model|provider|team
  ```

- [ ] **`GET /api/stats/requests`** — пагинированный лог запросов:
  ```
  ?page=1  &limit=50  &model=...  &provider=...  &runId=...  &from=...  &to=...
  ```

- [ ] **`GET /api/stats/requests/:id`** — полный запрос с messages и response (для replay/debug)

- [ ] **`POST /api/stats/export`** — экспорт в CSV/JSON/JSONL

#### 3.2.4 — Frontend: страница `/stats`

- [ ] **Новая страница Statistics** (`client/src/pages/Statistics.tsx`):
  ```
  ┌──────────────────────────────────────────────────────────────────┐
  │  Statistics                              [Export CSV] [Export JSON]│
  ├──────────────────────────────────────────────────────────────────┤
  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │
  │  │ Total    │ │ Total    │ │ Total    │ │ Estimated│           │
  │  │ Requests │ │ Tokens   │ │ Runs     │ │ Cost     │           │
  │  │ 1,234    │ │ 1.23M    │ │ 42       │ │ $4.56    │           │
  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘           │
  │                                                                  │
  │  ┌── Token Usage Over Time (stacked area chart) ─────────────┐  │
  │  │  Granularity: [Hour] [Day] [Week]                         │  │
  │  │  Group by: [Model] [Provider] [Team]                      │  │
  │  └───────────────────────────────────────────────────────────┘  │
  │                                                                  │
  │  ┌── Per-Model Breakdown (sortable table) ───────────────────┐  │
  │  │  Model │ Provider │ Requests │ Tokens │ Cost │ Avg Latency│  │
  │  └───────────────────────────────────────────────────────────┘  │
  │                                                                  │
  │  ┌── Cost Distribution ──┐  ┌── Latency Distribution ────────┐  │
  │  │  Donut by provider    │  │  Histogram by model             │  │
  │  └───────────────────────┘  └─────────────────────────────────┘  │
  │                                                                  │
  │  ┌── Request Log (paginated, expandable rows) ───────────────┐  │
  │  │  Time │ Model │ Team │ Tokens │ Latency │ Cost │ Status   │  │
  │  │  Filters: model, provider, team, status, date range       │  │
  │  │  Click row → full messages + response                     │  │
  │  └───────────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────────────┘
  ```

- [ ] **Router** — добавить `/stats` в `App.tsx`, навигация в sidebar

- [ ] **Hooks** — `useStatsOverview()`, `useStatsTimeline()`, `useStatsRequests()` в `use-pipeline.ts`

- [ ] **Dashboard обновление** — заменить mock traffic chart на реальные данные из `/api/stats/timeline`

#### 3.2.5 — Хранение для будущего RAG и Inference

- [ ] **Полные messages в `llm_requests.messages`** (JSONB) — training data:
  - system prompt + user messages + assistant response
  - Полный контекст каждого вызова для replay
  - Fine-tuning: prompt → response pairs
  - RAG: поиск по прошлым ответам, similar questions

- [ ] **`responseContent` как text** — для полнотекстового поиска:
  - Trigram index: `CREATE INDEX ... USING gin(response_content gin_trgm_ops)`
  - Или pg_tsvector для полнотекстового поиска

- [ ] **Tags** — `llm_requests.tags` (JSONB array):
  - Auto-tags: `["pipeline:web-app", "stage:testing", "lang:typescript"]`
  - User tags через UI
  - Фильтрация в `/api/stats/requests`

- [ ] **Export для training** — `POST /api/stats/export-training`:
  - Format: JSONL (для fine-tuning)
  - Фильтры: model, status=success, date range
  - Выход: пары prompt/completion

- [ ] **Embeddings-ready** — структура готова для Phase 5 RAG:
  - `messages` + `responseContent` → embed → vector store
  - Semantic cache: поиск похожих прошлых запросов → reuse ответа
  - Снижает повторные вызовы LLM

#### 3.2.6 — Порядок реализации

1. Таблица `llm_requests` + миграция + индексы
2. Storage methods (`createLlmRequest`, `getLlmRequests`, `getLlmRequestStats`)
3. Gateway logging wrapper
4. `MODEL_PRICING` + `estimateCost()`
5. API endpoints `/api/stats/*`
6. Frontend: `/stats` page
7. Dashboard: замена mock данных
8. Export (CSV/JSON/JSONL)
9. Полнотекстовый поиск + trigram индекс

### 3.3 — Governance & Gates

- [ ] **Approval gates per stage** — configurable human-in-the-loop checkpoints. Before a stage executes, optionally require user approval of the previous stage's output. More granular than current pause-on-question
- [ ] **Run export & reports** — generate downloadable report from pipeline run: executive summary, per-stage outputs, code files as ZIP, cost breakdown, timeline. PDF or Markdown

### 3.3 — Memory System Design

> Persistent cross-run memory that allows pipeline stages to learn from previous runs, remember user preferences, and accumulate project knowledge.

#### Design Decisions (Resolved)

| # | Question | Decision |
|---|----------|----------|
| D1 | **Scope hierarchy** | `global > workspace > pipeline > run` — narrower scope overrides broader on conflict |
| D2 | **Auto-extract vs explicit** | **Hybrid** — hard rules per stage type + optional `"memories"` array in model output |
| D3 | **Injection point** | **System message append** — memories injected at end of system prompt, max 15% of context limit |
| D4 | **Conflict resolution** | **Latest-wins + confidence decay** — 0.1 decay per run without confirmation, explicit user preference always wins |

#### 3.3.1 — DB Schema

```sql
CREATE TABLE memories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         TEXT NOT NULL,           -- "global" | "workspace" | "pipeline" | "run"
  scope_id      TEXT,                    -- null for global, workspace/pipeline/run ID for others
  type          TEXT NOT NULL,           -- "decision" | "pattern" | "fact" | "preference" | "issue" | "dependency"
  key           TEXT NOT NULL,           -- unique within scope, e.g. "db-choice", "auth-approach"
  content       TEXT NOT NULL,           -- human-readable memory content
  source        TEXT,                    -- "planning/run-3", "user/explicit", "code_review/run-7"
  confidence    REAL NOT NULL DEFAULT 1.0,  -- 0.0–1.0, decays over time
  tags          TEXT[] DEFAULT '{}',     -- searchable tags
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,            -- optional TTL
  created_by_run_id  UUID REFERENCES pipeline_runs(id),

  UNIQUE(scope, scope_id, key)          -- one memory per key per scope
);

CREATE INDEX idx_memories_scope ON memories(scope, scope_id);
CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_key ON memories(key);
CREATE INDEX idx_memories_confidence ON memories(confidence) WHERE confidence >= 0.3;
```

#### 3.3.2 — Types

```typescript
// shared/types.ts

export type MemoryScope = "global" | "workspace" | "pipeline" | "run";
export type MemoryType = "decision" | "pattern" | "fact" | "preference" | "issue" | "dependency";

export interface Memory {
  id: string;
  scope: MemoryScope;
  scopeId: string | null;
  type: MemoryType;
  key: string;
  content: string;
  source: string | null;
  confidence: number;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  createdByRunId: string | null;
}

export interface InsertMemory {
  scope: MemoryScope;
  scopeId?: string | null;
  type: MemoryType;
  key: string;
  content: string;
  source?: string | null;
  confidence?: number;
  tags?: string[];
  expiresAt?: Date | null;
  createdByRunId?: string | null;
}

// Optional field in any team's JSON output
export interface TeamMemoryHint {
  key: string;
  content: string;
  type: MemoryType;
}
```

#### 3.3.3 — MemoryExtractor (`server/memory/extractor.ts`)

Runs after each stage completes. Two extraction modes:

**A) Hard rules per stage type** (always run):

| Stage | Auto-extracted memories |
|-------|----------------------|
| `planning` | tasks[].title → `decision`, risks[].description → `issue`, acceptanceCriteria → `fact` |
| `architecture` | techStack.* → `decision`, components[].name → `fact`, apiEndpoints → `pattern` |
| `development` | dependencies[].name → `dependency`, file structure patterns → `pattern` |
| `testing` | coverageTargets → `fact`, issues[].severity=critical → `issue` |
| `code_review` | securityIssues[].severity ≥ high → `issue`, score → `fact`, approved → `decision` |
| `deployment` | deploymentStrategy → `decision`, environments → `fact` |
| `monitoring` | alerts[].condition → `pattern`, healthChecks → `fact` |

**B) Model-provided hints** (optional):

Any team can include `"memories": [{ key, content, type }]` in its JSON output. The extractor picks these up and stores them with `source: "{teamId}/run-{runId}"`.

```typescript
class MemoryExtractor {
  async extractFromStageResult(
    teamId: TeamId,
    runId: string,
    pipelineId: string,
    output: Record<string, unknown>,
  ): Promise<InsertMemory[]>;

  // Hard rules return memories for known fields
  private extractByRules(teamId: TeamId, output: Record<string, unknown>): InsertMemory[];

  // Parse optional "memories" array from model output
  private extractModelHints(output: Record<string, unknown>): InsertMemory[];
}
```

#### 3.3.4 — MemoryProvider (`server/memory/provider.ts`)

Injects relevant memories into stage prompts before LLM call.

```typescript
class MemoryProvider {
  // Get memories relevant to this stage execution
  async getRelevantMemories(params: {
    pipelineId: string;
    runId: string;
    teamId: TeamId;
    workspaceId?: string;
    maxTokenBudget: number;  // 15% of model's contextLimit
  }): Promise<Memory[]>;

  // Format memories for system prompt injection
  formatForPrompt(memories: Memory[]): string;

  // Apply confidence decay to all memories not confirmed in this run
  async decayUnconfirmedMemories(runId: string): Promise<void>;
}
```

**Relevance ranking** (memories sorted by this score, top N fit in token budget):

```
score = scopeWeight × confidence × recencyBoost

scopeWeight:
  run (exact match)     = 1.0
  pipeline (same)       = 0.8
  workspace (same)      = 0.6
  global                = 0.4

recencyBoost:
  updated < 1 day ago   = 1.0
  updated < 7 days      = 0.9
  updated < 30 days     = 0.7
  updated > 30 days     = 0.5
```

**Prompt injection format** (appended to system message):

```
## Project Memory

**Decisions:**
- [2026-03-10] Auth: JWT with refresh tokens (confidence: 0.9, source: architecture/run-3)
- [2026-03-09] DB: PostgreSQL 16 (confidence: 0.85, source: planning/run-2)

**Patterns:**
- API endpoints follow REST conventions with /api/v1 prefix
- All services use structured logging with correlation IDs

**Known Issues:**
- SQL injection risk in user search endpoint (severity: high, source: code_review/run-5)

**User Preferences:**
- Prefers TypeScript over JavaScript
- Wants comprehensive error handling

**Dependencies:**
- express@4.18, drizzle-orm@0.30, zod@3.22
```

#### 3.3.5 — Conflict Resolution Rules

1. **Same scope + same key** → newer `updatedAt` wins (upsert on `UNIQUE(scope, scope_id, key)`)
2. **Confidence decay** → every completed run triggers `decayUnconfirmedMemories()`: memories not referenced or re-confirmed lose 0.1 confidence. Below 0.3 = `stale`, excluded from injection
3. **Explicit user preference** → type=`preference` always created with confidence=1.0, never decays automatically
4. **Scope override** → narrower scope wins: `run > pipeline > workspace > global`. If `pipeline` says "use PostgreSQL" but `run` says "use MongoDB", the run-level memory is injected
5. **Conflict detection** → if two memories have the same key, different content, and both confidence > 0.7, MemoryProvider injects both with a warning: `⚠️ Conflicting memories — previous runs disagreed on this`

#### 3.3.6 — Integration into Pipeline Controller

```typescript
// pipeline-controller.ts — inside stage execution loop

// 1. Before LLM call: get relevant memories
const memories = await this.memoryProvider.getRelevantMemories({
  pipelineId: run.pipelineId,
  runId: run.id,
  teamId: stage.teamId,
  maxTokenBudget: Math.floor(model.contextLimit * 0.15),
});

// 2. Inject into team context
const memoryContext = this.memoryProvider.formatForPrompt(memories);
const teamContext: StageContext = {
  ...context,
  memoryContext,  // new field, used in BaseTeam.buildPrompt()
};

// 3. Execute stage as usual
const result = await team.execute(stageInput, teamContext);

// 4. After LLM call: extract and store new memories
const newMemories = await this.memoryExtractor.extractFromStageResult(
  stage.teamId, run.id, run.pipelineId, result.output,
);
await Promise.all(newMemories.map(m => this.storage.upsertMemory(m)));

// 5. After full pipeline run: decay unconfirmed memories
// (called once after all stages complete)
await this.memoryProvider.decayUnconfirmedMemories(run.id);
```

#### 3.3.7 — BaseTeam Integration

```typescript
// server/teams/base.ts — updated buildSystemMessage()

protected buildSystemMessage(memoryContext?: string): string {
  const parts = [this.systemPromptTemplate];

  if (memoryContext) {
    parts.push(memoryContext);  // Already formatted by MemoryProvider
  }

  return parts.join("\n\n");
}
```

Each team's `buildPrompt()` passes `context.memoryContext` to `buildSystemMessage()`.

#### 3.3.8 — IStorage Extension

```typescript
// server/storage.ts — add to IStorage interface

// Memories
getMemories(scope: MemoryScope, scopeId?: string): Promise<Memory[]>;
getMemoryByKey(scope: MemoryScope, scopeId: string | null, key: string): Promise<Memory | undefined>;
upsertMemory(memory: InsertMemory): Promise<Memory>;  // insert or update on conflict
deleteMemory(id: string): Promise<void>;
decayMemories(excludeRunId: string, decayAmount: number): Promise<number>;  // returns count updated
getStaleMemories(threshold: number): Promise<Memory[]>;  // confidence < threshold
searchMemories(query: string, scope?: MemoryScope): Promise<Memory[]>;  // full-text search
```

#### 3.3.9 — API Endpoints

```
GET    /api/memories                         — list all (filterable by scope, type, key)
GET    /api/memories/search?q=postgresql     — full-text search
GET    /api/pipelines/:id/memories           — memories scoped to pipeline
POST   /api/memories                         — create/upsert explicit memory (user preference)
PUT    /api/memories/:id                     — update memory content/confidence
DELETE /api/memories/:id                     — delete memory
DELETE /api/memories/stale                   — bulk delete stale memories (confidence < 0.3)
```

#### 3.3.10 — Frontend: Memory UI

- [ ] **Memory panel** in Pipeline Run detail view — show memories used during this run + newly created
- [ ] **Memory browser** page (`/memories`) — searchable list of all memories, grouped by scope → type
  - Edit/delete individual memories
  - Confidence bar visualization
  - Filter by scope, type, staleness
- [ ] **User preferences panel** in Settings — explicit key-value preferences (type=`preference`, scope=`global`)
  - "Preferred language: TypeScript"
  - "Error handling style: comprehensive"
  - "Preferred DB: PostgreSQL"

#### 3.3.11 — Implementation Order

1. Types (`shared/types.ts`) + DB schema (`shared/schema.ts`)
2. `IStorage` extension + `MemStorage` implementation
3. `PgStorage` implementation (if PG active)
4. `MemoryExtractor` with hard rules per stage
5. `MemoryProvider` with relevance ranking + prompt formatting
6. Pipeline Controller integration (inject + extract)
7. `BaseTeam.buildSystemMessage()` update
8. API endpoints
9. Frontend: memory panel in run detail
10. Frontend: memory browser page
11. Frontend: user preferences in settings
12. Confidence decay cron job / post-run hook

---

## Phase 3.5 — Docker Sandbox Execution (Isolated Stage Runtime)

> Цель: дать пайплайну возможность не только генерировать код/тесты через LLM, но и **реально исполнять** их в изолированном Docker-контейнере. Каждый stage может опционально запустить сгенерированный артефакт (сборку, тесты, линтинг, произвольные команды) внутри эфемерного контейнера — без доступа к хост-системе.

### Архитектура

```
Pipeline Stage (e.g. Development / Testing)
    │
    ▼
┌───────────────────────┐
│ 1. LLM генерирует код │  ← team.execute() — как сейчас
└──────────┬────────────┘
           │ result.output содержит код / файлы / команды
           ▼
┌───────────────────────┐
│ 2. SandboxExecutor    │  ← НОВЫЙ компонент
│    (если sandbox      │
│     включён для       │
│     этого stage)      │
│                       │
│  • Создаёт tmp dir    │
│  • Записывает файлы   │
│  • docker run ...     │
│  • Собирает stdout/   │
│    stderr/exitCode    │
│  • Удаляет контейнер  │
└──────────┬────────────┘
           │ SandboxResult: { exitCode, stdout, stderr, artifacts[] }
           ▼
┌───────────────────────┐
│ 3. Результат          │
│    объединяется с     │
│    output stage'а     │
│    → идёт дальше      │
│    по пайплайну       │
└───────────────────────┘
```

### 3.5.1 — Типы и конфигурация

- [ ] **`SandboxConfig` в `PipelineStageConfig`** — расширить тип stage:
  ```typescript
  // shared/types.ts — расширение PipelineStageConfig
  export interface SandboxConfig {
    enabled: boolean;
    image: string;                      // Docker image, e.g. "node:20-alpine", "python:3.12-slim", "golang:1.22"
    command: string;                    // Команда для исполнения, e.g. "npm test", "pytest", "go build ./..."
    workdir?: string;                   // Рабочая директория внутри контейнера (default: /workspace)
    timeout?: number;                   // Timeout в секундах (default: 120, max: 600)
    memoryLimit?: string;               // Docker memory limit, e.g. "512m", "1g"
    cpuLimit?: number;                  // CPU limit, e.g. 1.0
    networkDisabled?: boolean;          // Отключить сеть (default: true — безопасность)
    env?: Record<string, string>;       // Переменные окружения для контейнера
    extractArtifacts?: string[];        // Glob-паттерны файлов для извлечения из контейнера (e.g. ["dist/**", "coverage/**"])
    installCommand?: string;            // Команда установки зависимостей перед основной (e.g. "npm install", "pip install -r requirements.txt")
  }

  export interface PipelineStageConfig {
    teamId: TeamId;
    modelSlug: string;
    systemPromptOverride?: string;
    enabled: boolean;
    sandbox?: SandboxConfig;            // ← НОВОЕ опциональное поле
  }
  ```

- [ ] **`SandboxResult` тип** — результат исполнения:
  ```typescript
  export interface SandboxResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    artifacts: SandboxArtifact[];       // Извлечённые файлы
    containerImage: string;
    command: string;
    timedOut: boolean;
  }

  export interface SandboxArtifact {
    path: string;                       // Относительный путь внутри контейнера
    content: string;                    // Base64 для бинарных, plain text для текстовых
    sizeBytes: number;
    isBinary: boolean;
  }
  ```

### 3.5.2 — SandboxExecutor (Backend Service)

- [ ] **Создать `server/sandbox/executor.ts`** — основной сервис:
  ```
  class SandboxExecutor {
    async execute(config: SandboxConfig, files: SandboxFile[]): Promise<SandboxResult>
    async isDockerAvailable(): Promise<boolean>
    async pullImage(image: string): Promise<void>
    async cleanup(containerId: string): Promise<void>
  }
  ```

  Алгоритм `execute()`:
  1. Создать временную директорию (`os.tmpdir()` + random suffix)
  2. Записать файлы из `files[]` в tmp dir (код сгенерированный LLM)
  3. Если `installCommand` — запустить `docker run` с install command первым
  4. Запустить `docker run` с основной `command`:
     ```
     docker run --rm \
       --name multiqlti-sandbox-{runId}-{stageIndex} \
       --memory={memoryLimit} \
       --cpus={cpuLimit} \
       --network={networkDisabled ? "none" : "bridge"} \
       --workdir=/workspace \
       -v {tmpDir}:/workspace:rw \
       {envFlags} \
       {image} \
       sh -c "{command}"
     ```
  5. Дождаться завершения с timeout (kill контейнер при превышении)
  6. Собрать stdout/stderr через `docker logs` или pipe
  7. Извлечь артефакты по `extractArtifacts` glob-паттернам
  8. Удалить tmp dir и контейнер
  9. Вернуть `SandboxResult`

- [ ] **Docker API через `dockerode`** — использовать npm пакет `dockerode` вместо spawn'а CLI:
  - Прямой доступ к Docker Engine API через Unix socket
  - Стриминг логов в реальном времени
  - Программное управление жизненным циклом контейнера
  - Fallback на CLI (`child_process.exec("docker ...")`) если dockerode недоступен

- [ ] **Предустановленные образы (image presets)**:
  ```typescript
  // shared/constants.ts
  export const SANDBOX_IMAGE_PRESETS: Record<string, { image: string; installCmd: string; buildCmd: string; testCmd: string }> = {
    "node":    { image: "node:20-alpine",       installCmd: "npm install",   buildCmd: "npm run build", testCmd: "npm test" },
    "python":  { image: "python:3.12-slim",     installCmd: "pip install -r requirements.txt", buildCmd: "python -m build", testCmd: "pytest" },
    "go":      { image: "golang:1.22-alpine",   installCmd: "go mod download", buildCmd: "go build ./...", testCmd: "go test ./..." },
    "rust":    { image: "rust:1.77-slim",       installCmd: "cargo fetch",   buildCmd: "cargo build --release", testCmd: "cargo test" },
    "java":    { image: "eclipse-temurin:21-jdk-alpine", installCmd: "mvn dependency:resolve", buildCmd: "mvn package -DskipTests", testCmd: "mvn test" },
    "custom":  { image: "",                     installCmd: "",              buildCmd: "",             testCmd: "" },
  };
  ```

### 3.5.3 — Интеграция в Pipeline Controller

- [ ] **Post-LLM execution hook** — после `team.execute()` в `PipelineController.executeStages()`:
  ```typescript
  // pipeline-controller.ts — внутри цикла стейджей, после result = await team.execute(...)

  let sandboxResult: SandboxResult | null = null;

  if (stage.sandbox?.enabled) {
    // Извлечь файлы из LLM output
    const files = this.extractFilesFromOutput(result.output);

    this.broadcast(run.id, {
      type: "stage:sandbox_started",
      payload: { stageIndex: i, image: stage.sandbox.image, command: stage.sandbox.command },
    });

    sandboxResult = await this.sandboxExecutor.execute(stage.sandbox, files);

    // Дополнить output stage'а результатом sandbox
    result.output = {
      ...result.output,
      sandboxResult: {
        exitCode: sandboxResult.exitCode,
        stdout: sandboxResult.stdout,
        stderr: sandboxResult.stderr,
        durationMs: sandboxResult.durationMs,
        timedOut: sandboxResult.timedOut,
        passed: sandboxResult.exitCode === 0,
        artifacts: sandboxResult.artifacts.map(a => ({ path: a.path, sizeBytes: a.sizeBytes })),
      },
    };

    this.broadcast(run.id, {
      type: "stage:sandbox_completed",
      payload: { stageIndex: i, exitCode: sandboxResult.exitCode, passed: sandboxResult.exitCode === 0 },
    });

    // Опционально: фейлить stage если sandbox вернул ≠ 0
    if (stage.sandbox.failOnNonZero !== false && sandboxResult.exitCode !== 0) {
      throw new Error(`Sandbox execution failed (exit code ${sandboxResult.exitCode}): ${sandboxResult.stderr.slice(0, 500)}`);
    }
  }
  ```

- [ ] **Метод `extractFilesFromOutput()`** — парсить сгенерированные файлы из LLM output:
  - Ищет markdown code blocks с именами файлов (```typescript // filename: src/index.ts)
  - Ищет JSON-массив `files` в output (если team форматирует output как `{ files: [{ path, content }], ... }`)
  - Ищет поле `code` / `sourceCode` / `testCode` в output

### 3.5.4 — WebSocket Events

- [ ] **Новые WS event типы**:
  ```typescript
  // shared/types.ts — расширить WsEventType
  | "stage:sandbox_started"       // Sandbox запущен
  | "stage:sandbox_progress"      // Стриминг stdout/stderr в реальном времени
  | "stage:sandbox_completed"     // Sandbox завершён (exitCode, passed)
  ```

### 3.5.5 — DB Schema (опционально)

- [ ] **Таблица `sandbox_executions`** — для аудита и отладки:
  ```
  id, stageExecutionId, image, command, exitCode, stdout (text), stderr (text),
  durationMs, timedOut, artifacts (jsonb), createdAt
  ```
  Связь: `sandbox_executions.stageExecutionId → stage_executions.id` (1:1)

### 3.5.6 — Frontend: Sandbox UI

- [ ] **Sandbox config в Pipeline Builder** (`AgentNode.tsx` или `StageConfig`):
  - Toggle "Enable sandbox execution" per stage
  - Image selector (dropdown из presets + custom input)
  - Command input (pre-filled из preset: build/test)
  - Timeout slider (30s — 600s)
  - Resource limits (memory, CPU)
  - Network toggle (on/off)
  - Artifact extraction patterns

- [ ] **Sandbox output в StageProgress/StageOutput**:
  - Индикатор "Sandbox running..." с таймером
  - Встроенный терминал-подобный блок для stdout/stderr (стриминг через WS)
  - Бейдж Pass/Fail с exit code
  - Скачивание артефактов

### 3.5.7 — API Endpoints

- [ ] **`GET /api/sandbox/status`** — проверка доступности Docker на хосте
- [ ] **`GET /api/sandbox/presets`** — список доступных image presets
- [ ] **`POST /api/sandbox/test`** — тестовый запуск (`echo "hello"` в выбранном образе)
- [ ] **`GET /api/sandbox/executions/:stageExecutionId`** — получить результат sandbox для stage
- [ ] **`GET /api/sandbox/executions/:id/artifacts/:path`** — скачать конкретный артефакт

### 3.5.8 — Безопасность

- [ ] **Контейнер запускается без привилегий** — `--security-opt=no-new-privileges`, `--cap-drop=ALL`
- [ ] **Read-only root filesystem** — `--read-only` + tmpfs для `/tmp`
- [ ] **Сеть отключена по умолчанию** — `--network=none`. Включается явно если stage'у нужен `npm install` из registry
- [ ] **Memory + CPU limits обязательны** — fallback на `512m` / `1.0 CPU` если не указаны
- [ ] **Timeout обязателен** — kill контейнер через `timeout` секунд (default 120, max 600)
- [ ] **Нет bind mounts к хост-системе** — только tmpdir с сгенерированными файлами
- [ ] **Whitelist образов** (опционально) — admin может ограничить допустимые images в конфиге
- [ ] **Логирование** — все sandbox-запуски пишутся в `sandbox_executions` для аудита
- [ ] **Контейнер всегда `--rm`** — автоудаление после завершения, никаких "зависших" контейнеров

### 3.5.9 — Docker-in-Docker (DinD) для продакшена

- [ ] **docker-compose.yml** — добавить sandbox-ready конфигурацию:
  ```yaml
  services:
    multiqlti:
      volumes:
        - /var/run/docker.sock:/var/run/docker.sock  # Доступ к Docker Engine хоста
        - sandbox-tmp:/tmp/multiqlti-sandbox          # Shared tmpdir для файлов
      environment:
        - SANDBOX_ENABLED=true
        - SANDBOX_MAX_CONCURRENT=3          # Макс. параллельных контейнеров
        - SANDBOX_DEFAULT_TIMEOUT=120
        - SANDBOX_ALLOWED_IMAGES=node:20-alpine,python:3.12-slim,golang:1.22-alpine
  ```

- [ ] **Альтернатива: sysbox runtime** — для полной изоляции без проброса docker.sock:
  - `docker run --runtime=sysbox-runc` — контейнер с собственным Docker daemon
  - Безопаснее для multi-tenant, но сложнее настройка

### 3.5.10 — Сценарии использования

| Сценарий | Stage | Image | Command | Сеть |
|----------|-------|-------|---------|------|
| Сборка Node.js проекта | Development | `node:20-alpine` | `npm install && npm run build` | on (npm registry) |
| Запуск unit тестов | Testing | `node:20-alpine` | `npm test` | off |
| Линтинг Python кода | Code Review | `python:3.12-slim` | `pip install ruff && ruff check .` | on (pip) |
| Компиляция Go сервиса | Development | `golang:1.22-alpine` | `go build -o /workspace/dist/app ./cmd/server` | on (go modules) |
| Security scan | Code Review | `aquasec/trivy:latest` | `trivy fs --exit-code 1 /workspace` | on (vuln DB) |
| Terraform validate | Deployment | `hashicorp/terraform:latest` | `terraform init && terraform validate` | on (providers) |
| Изолированный shell | Custom | любой | user-defined | user-defined |

### 3.5.11 — Пакеты

```bash
npm install dockerode @types/dockerode
```

### 3.5.12 — Порядок реализации

1. `SandboxConfig` + `SandboxResult` типы в `shared/types.ts`
2. `SandboxExecutor` сервис (`server/sandbox/executor.ts`)
3. Интеграция в `PipelineController` (post-LLM hook)
4. WS events для sandbox lifecycle
5. API endpoints (`/api/sandbox/*`)
6. DB таблица `sandbox_executions`
7. Frontend: config UI в pipeline builder
8. Frontend: output display в StageProgress
9. Docker-compose обновление
10. Security hardening + тесты

### Open Design Questions (Phase 3.5)

| # | Вопрос | Варианты |
|---|--------|----------|
| 15 | **Docker доступ** | A) Docker socket mount (простой, менее безопасный) B) Docker-in-Docker (sysbox) C) Remote Docker API (TCP) |
| 16 | **Файлы из LLM** | A) Парсить markdown code blocks B) Требовать JSON `{ files: [...] }` от teams C) Оба |
| 17 | **Fail policy** | A) Sandbox fail = stage fail (default) B) Sandbox fail = warning, stage продолжается C) Настраиваемо per-stage |
| 18 | **Стриминг логов** | A) Полный stdout/stderr через WS в реальном времени B) Только итоговый результат C) Стриминг + итог |
| 19 | **Workspace привязка** | A) Sandbox работает только с LLM-generated файлами B) Sandbox может монтировать workspace из Phase 4 C) Оба |
| 20 | **Образы** | A) Только из whitelist B) Любой публичный образ C) Whitelist + admin может добавлять |

---

## Phase 3.6 — Multi-Model Execution Strategies (MoA, Debate, Voting)

> Goal: allow each pipeline stage to use multiple models simultaneously with different orchestration strategies — Mixture-of-Agents for creative synthesis, Multi-Agent Debate for adversarial quality, and Majority Voting for deterministic validation. The user picks a strategy per stage; default remains `single` (backwards-compatible).

### Core Concept

Currently each stage runs **one model → one response**. With execution strategies, a stage can run **N models → orchestrated result**:

```
┌─────────────────────────────────────────────────────────┐
│                    Stage Execution                       │
│                                                         │
│  ┌─── single ──┐  ┌──── moa ─────┐  ┌── debate ──┐    │
│  │ 1 model     │  │ N proposers   │  │ A proposes │    │
│  │ 1 response  │  │ 1 aggregator  │  │ B critiques│    │
│  │ (default)   │  │ best-of-all   │  │ C judges   │    │
│  └─────────────┘  └───────────────┘  └────────────┘    │
│                                                         │
│  ┌── voting ───┐                                        │
│  │ N candidates│                                        │
│  │ validator   │                                        │
│  │ consensus   │                                        │
│  └─────────────┘                                        │
└─────────────────────────────────────────────────────────┘
```

### Recommended Strategy per SDLC Stage

| Stage | Best Strategy | Why |
|-------|--------------|-----|
| **Planning** | MoA | Creative task — diverse perspectives, then synthesize |
| **Architecture** | Debate | Adversarial critique — one designs, another finds weaknesses |
| **Development** | MoA + Voting | Multiple models generate → aggregator merges → voting validates via tests |
| **Testing** | Voting | Deterministic — code either passes tests or doesn't |
| **Code Review** | Debate | Reviewer critiques, author defends, judge decides |
| **Deployment** | Voting | Config validation — majority consensus |
| **Monitoring** | MoA | Different models analyze metrics from different angles |

### Type Definitions

```typescript
type ExecutionStrategy =
  | SingleStrategy
  | MoaStrategy
  | DebateStrategy
  | VotingStrategy;

interface SingleStrategy {
  type: 'single';
}

interface MoaStrategy {
  type: 'moa';
  proposers: ProposerConfig[];     // 2-5 models generating in parallel
  aggregator: AggregatorConfig;    // strongest model synthesizes
  proposerPromptOverride?: string;
}

interface ProposerConfig {
  modelId: string;
  role?: string;                   // "optimist", "skeptic", "security-focused"
  temperature?: number;
}

interface AggregatorConfig {
  modelId: string;
  systemPrompt?: string;
}

interface DebateStrategy {
  type: 'debate';
  participants: DebateParticipant[];
  judge: JudgeConfig;
  rounds: number;                  // 2-5 (default: 3)
  stopEarly?: boolean;
}

interface DebateParticipant {
  modelId: string;
  role: 'proposer' | 'critic' | 'devil_advocate';
  persona?: string;
}

interface JudgeConfig {
  modelId: string;
  criteria?: string[];             // ["correctness", "security", "performance"]
}

interface VotingStrategy {
  type: 'voting';
  candidates: CandidateConfig[];   // 3-7 models/runs
  threshold: number;               // 0.5-1.0
  validationMode: 'text_similarity' | 'test_execution' | 'custom';
  validationFn?: string;
}

interface CandidateConfig {
  modelId: string;
  temperature?: number;            // same model + different temps = cheap diversity
}

interface StrategyResult {
  finalContent: string;
  strategy: ExecutionStrategy['type'];
  details: MoaDetails | DebateDetails | VotingDetails;
  totalTokensUsed: number;
  totalCost: number;
  durationMs: number;
}
```

### Strategy Executor Service

```typescript
// server/services/strategy-executor.ts

class StrategyExecutor {
  constructor(
    private gateway: Gateway,
    private sandbox?: SandboxExecutor  // Phase 3.5
  ) {}

  async execute(
    strategy: ExecutionStrategy,
    basePrompt: ProviderMessage[],
    context: StageContext
  ): Promise<StrategyResult> {
    switch (strategy.type) {
      case 'single':  return this.executeSingle(basePrompt, context);
      case 'moa':     return this.executeMoA(strategy, basePrompt, context);
      case 'debate':  return this.executeDebate(strategy, basePrompt, context);
      case 'voting':  return this.executeVoting(strategy, basePrompt, context);
    }
  }
}
```

### Strategy 1: MoA — parallel proposers + aggregator
1. `Promise.all()` — fire all proposers in parallel
2. Build aggregation prompt with all proposer responses
3. Single `gateway.complete()` to aggregator
4. Return aggregated response + all intermediate data

### Strategy 2: Debate — round loop + judge
1. Round loop (1..N): proposer generates, critic critiques
2. Each round broadcast via WS `debate:round`
3. Early stop if consensus detected
4. Judge produces final verdict

### Strategy 3: Voting — candidates + validator
- `test_execution`: runs code in Docker sandbox (Phase 3.5)
- `text_similarity`: embed + cluster by cosine similarity
- `custom`: user-provided validator function

### Strategy Presets

| Preset | Planning | Architecture | Development | Testing | Code Review | Deployment | Monitoring |
|--------|----------|-------------|-------------|---------|-------------|------------|------------|
| **Single** | single | single | single | single | single | single | single |
| **Quality Max** | moa(3) | debate(3r) | moa(3)+voting | voting(5) | debate(3r) | voting(5) | moa(3) |
| **Balanced** | moa(2) | debate(2r) | single | voting(3) | debate(2r) | single | single |
| **Cost Optimized** | single | debate(2r) | single | voting(3) | single | single | single |
| **Code Focus** | single | single | moa(3)+voting | voting(5) | debate(3r) | voting(3) | single |

### DB Schema Extension

```sql
ALTER TABLE stage_executions ADD COLUMN execution_strategy jsonb;
ALTER TABLE stage_executions ADD COLUMN strategy_result jsonb;
ALTER TABLE llm_requests ADD COLUMN strategy_role text;
-- values: 'proposer', 'aggregator', 'critic', 'judge', 'candidate', null
```

### WebSocket Events

```typescript
interface StrategyEvents {
  'strategy:started':    { runId, stageId, strategy: ExecutionStrategy };
  'strategy:proposer':   { runId, stageId, modelId, role, content, index };
  'strategy:aggregating':{ runId, stageId, aggregatorModelId };
  'strategy:debate:round':{ runId, stageId, round, participant, role, content };
  'strategy:debate:judge':{ runId, stageId, verdict, reasoning };
  'strategy:voting:candidate': { runId, stageId, modelId, index, passed };
  'strategy:voting:result': { runId, stageId, winnerIndex, agreement };
  'strategy:completed':  { runId, stageId, result: StrategyResult };
}
```

### Implementation Order

1. `ExecutionStrategy` types in `shared/types.ts`
2. `StrategyExecutor` service with `single` mode (refactor)
3. `PipelineStageConfig.executionStrategy` field + DB migration
4. MoA executor — parallel proposers + aggregator
5. Debate executor — round loop + judge
6. Voting executor — candidates + validators
7. Voting + Docker sandbox integration (`test_execution`)
8. API endpoints for strategy CRUD + presets
9. Frontend: strategy config UI + execution viewer
10. Strategy presets + cost estimation endpoint

### Open Design Questions (Phase 3.6)

| # | Question | Options |
|---|---------|---------|
| 21 | **MoA: same prompt or varied?** | A) Identical prompt B) Persona-tailored C) Configurable |
| 22 | **Debate: who speaks first?** | A) Always proposer B) Random C) Configurable |
| 23 | **Voting: tie-breaking** | A) First passing B) Lowest-cost C) Extra tiebreaker round |
| 24 | **Streaming during strategy** | A) Final only B) Each sub-request live C) Proposers live, aggregator buffered |
| 25 | **Cost ceiling** | A) Hard limit B) Soft warning C) Both configurable |
| 26 | **Hybrid strategies** | A) Single per stage B) Chaining (MoA → Voting) C) User DAG |

---

## Phase 3.7 — Privacy Proxy Layer (Optional, Late Priority)

> **Status: Optional feature, disabled by default.**
> Goal: prevent sensitive data leakage to public LLM APIs by intercepting requests through a pseudonymization proxy. Identifiers (domains, IPs, cluster names, repo URLs, service names) are replaced with pseudonyms before leaving the system, and restored in responses. No smart routing to private models — all requests go to configured public providers, but with data sanitized.

### The Problem

When the platform orchestrates infrastructure work (especially via ArgoCD MCP), prompts contain:

| Data Type | Example | Risk |
|-----------|---------|------|
| Domain names | `api.acme-corp.io` | Client identification |
| IP addresses | `10.42.3.15`, `172.16.0.0/12` | Network topology leak |
| K8s namespaces | `prod-payments`, `staging-auth` | Business logic exposure |
| ArgoCD app names | `acme-checkout-v2` | Product roadmap leak |
| Git repo URLs | `github.com/acme-corp/billing-engine` | Org structure exposure |
| Docker images | `acme.azurecr.io/services/fraud-detector:v3` | Registry + service names |
| Env variables | `DATABASE_URL=postgres://prod-db.acme...` | Credential + infra leak |
| Helm values | `ingress.host: checkout.acme-corp.com` | Deployment topology |
| Service names | `fraud-detection-ml`, `kyc-verification` | Competitive intelligence |
| Cloud account IDs | `arn:aws:iam::123456789:role/deploy` | Account targeting |

**Compliance drivers**: SOC 2, GDPR (data minimization), PCI DSS, internal InfoSec.

### Architecture: Privacy Proxy Layer

```
┌─────────────────────────────────────────────────────────────────┐
│                         Pipeline Stage                           │
│  ┌──────────┐                                                    │
│  │ BaseTeam  │─── prompt with real data                          │
│  └────┬──────┘                                                   │
│       ▼                                                          │
│  ┌────────────────────────────────────────┐                      │
│  │     Interceptor (Privacy Proxy)         │                      │
│  │                                        │                      │
│  │  1. Scan text for PII & identifiers    │                      │
│  │  2. Pseudonymize:                       │                      │
│  │     prod-db.client.com → service-A     │                      │
│  │     192.168.1.45 → IP_ADDR_1           │                      │
│  │     Project-Phoenix → Core-App         │                      │
│  │  3. Store mapping in Vault (never      │                      │
│  │     leaves your perimeter)             │                      │
│  │  4. Forward sanitized prompt           │──── to Public LLM    │
│  │                                        │                      │
│  │  On response (Rehydration):            │                      │
│  │  5. Reverse-map pseudonyms → real      │                      │
│  │  6. User sees real names               │                      │
│  └────────────────────────────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

### Data Classification Engine

```typescript
interface ClassificationResult {
  sensitivityScore: number;        // 0.0 - 1.0
  detectedEntities: DetectedEntity[];
  recommendedRoute: 'private' | 'anonymized_public' | 'public';
  complianceFlags: ComplianceFlag[];
}

interface DetectedEntity {
  type: EntityType;
  value: string;
  position: { start: number; end: number };
  confidence: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

type EntityType =
  | 'domain' | 'ip_address' | 'ip_cidr' | 'k8s_namespace' | 'k8s_resource'
  | 'argocd_app' | 'git_url' | 'docker_image' | 'cloud_account'
  | 'cloud_resource_id' | 'env_variable' | 'api_key' | 'email'
  | 'hostname' | 'helm_value' | 'service_name' | 'custom_pattern';
```

### Detection Patterns (Built-in)

```typescript
const BUILTIN_PATTERNS: PatternDef[] = [
  { type: 'domain', severity: 'high',
    patterns: [/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|io|dev|net|org|co|app|cloud|internal)/gi],
    allowlist: ['github.com', 'docker.io', 'registry.terraform.io', 'kubernetes.io'] },
  { type: 'git_url', severity: 'high',
    patterns: [/(?:https?:\/\/|git@)(?:github|gitlab|bitbucket)[^\s]+/gi] },
  { type: 'ip_address', severity: 'high',
    patterns: [/\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g] },
  { type: 'docker_image', severity: 'high',
    patterns: [/[a-z0-9.-]+\.(?:azurecr|gcr|ecr\.[a-z-]+\.amazonaws)\.(?:io|com)\/[^\s]+/gi] },
  { type: 'cloud_account', severity: 'critical',
    patterns: [/arn:aws:[a-z0-9-]+:[a-z0-9-]*:(\d{12}):/g,
               /projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\//g,
               /\/subscriptions\/([0-9a-f-]{36})\//gi] },
  { type: 'api_key', severity: 'critical',
    patterns: [/(?:sk|pk|api[_-]?key|token|secret|password|Bearer)\s*[=:]\s*['"]?[\w\-./]{20,}/gi,
               /AKIA[0-9A-Z]{16}/g, /ghp_[A-Za-z0-9_]{36}/g] },
  { type: 'k8s_namespace', severity: 'medium',
    patterns: [/namespace:\s*['"]?([a-z0-9-]+)/gi],
    allowlist: ['default', 'kube-system', 'kube-public', 'argocd', 'monitoring'] },
];
```

### Pseudonym Generation (Context-Preserving)

Pseudonyms **preserve semantic structure** so the LLM can still reason about the architecture:

```typescript
const PSEUDONYM_STRATEGIES: Record<EntityType, PseudonymStrategy> = {
  domain: {
    // api.acme-corp.io → api.alpha-org.example (same org = same pseudonym)
    generate: (value, ctx) => {
      const parts = value.split('.');
      const org = ctx.getOrCreateOrgPseudonym(extractOrg(value));
      return `${parts[0]}.${org}.example`;
    }
  },
  ip_address: {
    // 10.42.3.15 → 10.0.{random}.15 (preserve /8, keep host octet)
    generate: (value) => {
      const octets = value.split('.');
      return `10.0.${randomInt(1, 254)}.${octets[3]}`;
    }
  },
  k8s_namespace: {
    // prod-payments → prod-service-a (preserve env prefix)
    generate: (value, ctx) => {
      const env = extractEnvPrefix(value);
      return env ? `${env}${ctx.getOrCreateServicePseudonym(value)}` : ctx.getOrCreateServicePseudonym(value);
    }
  },
  git_url: {
    // github.com/acme-corp/billing → github.com/org-alpha/repo-a
    generate: (value, ctx) => {
      const { host, org, repo } = parseGitUrl(value);
      return `${host}/${ctx.getOrCreateOrgPseudonym(org)}/${ctx.getOrCreateRepoPseudonym(repo)}`;
    }
  },
  api_key: {
    generate: () => '<REDACTED_SECRET>',  // never send
  },
};
```

### Consistency Within Session

Same real value → same pseudonym within a session:

```
Real:                              Anonymized:
api.acme-corp.io                →  api.alpha-org.example
db.acme-corp.io                 →  db.alpha-org.example      ← same org!
prod-payments namespace         →  prod-service-a
staging-payments namespace      →  staging-service-a          ← same service!
```

### Gateway Integration

```typescript
class Gateway {
  async complete(messages, modelId, options?: { privacyProxy?: boolean }) {
    // Privacy proxy is optional, disabled by default
    if (options?.privacyProxy && this.privacyProxyEnabled) {
      // Intercept → Pseudonymize → Send → Rehydrate
      const { anonymized, mapId } = this.anonymizer.anonymize(
        messages.map(m => m.content).join('\n')
      );
      const anonMessages = this.anonymizer.applyToMessages(messages, mapId);
      const result = await this.providers.get(modelId).complete(anonMessages);
      result.content = this.anonymizer.rehydrate(result.content, mapId);
      return result;
    }

    // Default: direct call (no anonymization)
    return this.providers.get(modelId).complete(messages);
  }
}
```

### ArgoCD Integration Example

```typescript
// BEFORE anonymization (real ArgoCD data):
{ name: "acme-checkout-v2",
  destination: { server: "https://k8s.acme-corp.internal:6443", namespace: "prod-payments" },
  source: { repoURL: "git@github.com:acme-corp/checkout-service.git" } }

// AFTER anonymization (sent to public LLM):
{ name: "alpha-app-a-v2",
  destination: { server: "https://k8s.alpha-org.example:6443", namespace: "prod-service-a" },
  source: { repoURL: "git@github.com:org-alpha/repo-a.git" } }
// LLM can still diagnose issues — but can't identify the client
```

### Anonymization Levels

| Level | What Gets Masked | Use Case |
|-------|-----------------|----------|
| **Off (default)** | Nothing — direct to LLM | Personal/OSS projects, no compliance needs |
| **Standard** | Domains, IPs, git URLs, docker images, cloud accounts | Enterprise with compliance requirements |
| **Strict** | All of Standard + k8s namespaces, service names, helm values | Regulated industries (fintech, healthcare) |
| **Paranoid** | All of Strict + project names, file paths, env var names | Government / classified workloads |

### DB Schema

```sql
CREATE TABLE anonymization_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES pipeline_runs(id),
  stage_id text NOT NULL,
  llm_request_id uuid REFERENCES llm_requests(id),
  route_decision text NOT NULL,
  sensitivity_score numeric(3,2),
  entities_detected integer DEFAULT 0,
  entities_anonymized integer DEFAULT 0,
  entity_types text[],
  compliance_profile text,
  model_id text NOT NULL,
  is_private_model boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE anonymization_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  entity_type text DEFAULT 'custom_pattern',
  regex_pattern text NOT NULL,
  severity text DEFAULT 'high',
  pseudonym_template text,
  allowlist text[],
  created_at timestamptz DEFAULT now()
);

CREATE TABLE compliance_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile text DEFAULT 'enterprise',
  custom_overrides jsonb DEFAULT '{}',
  private_model_fallback text,
  audit_all_requests boolean DEFAULT true,
  retention_days integer DEFAULT 90,
  updated_at timestamptz DEFAULT now()
);
```

### API Endpoints

| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/api/compliance/profiles` | List compliance profiles |
| PUT | `/api/compliance/settings` | Update compliance profile |
| GET | `/api/compliance/audit-log` | Query anonymization audit log |
| POST | `/api/compliance/test-anonymize` | Preview anonymization on sample text |
| GET | `/api/compliance/stats` | Anonymization + routing statistics |
| POST | `/api/anonymization/patterns` | Add custom detection pattern |
| GET | `/api/anonymization/patterns` | List custom patterns |

### Frontend: Compliance Dashboard

```
┌─ Compliance & Data Anonymization ───────────────────────┐
│  Active Profile: [Enterprise SOC 2 ▼]                    │
│  Private Models: vLLM ✅ Ollama ✅                        │
│                                                          │
│  ┌─ Routing Stats (7d) ─────────────────────────────┐    │
│  │  Private:           ████████████████░░░  78%      │    │
│  │  Anonymized Public: ████░░░░░░░░░░░░░░░  18%      │    │
│  │  Direct Public:     █░░░░░░░░░░░░░░░░░░   4%      │    │
│  │  Entities anonymized: 2,847                       │    │
│  └───────────────────────────────────────────────────┘    │
│                                                          │
│  ┌─ Test Anonymization ─────────────────────────────┐    │
│  │  Input:  "checkout-api in prod-payments at acme"  │    │
│  │  Result: "app-a-api in prod-service-a at alpha"   │    │
│  │  Detected: 3 entities (domain, k8s_ns, service)  │    │
│  └───────────────────────────────────────────────────┘    │
│                                                          │
│  ┌─ Custom Patterns ────────────────────────────────┐    │
│  │  acme-*          → alpha-*       [Edit] [Del]    │    │
│  │  *.internal.corp → *.internal.ex [Edit] [Del]    │    │
│  │  [+ Add Pattern]                                  │    │
│  └───────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

### Cross-Phase Synergies

| Uses | From Phase | How |
|------|-----------|-----|
| MCP (ArgoCD, K8s) | 3.1 | MCP tool responses anonymized before prompt inclusion |
| Request Logging | 3.2 | Stores both anonymized (sent) and original (encrypted audit) |
| Strategies | 3.6 | MoA/Debate sub-requests each routed through anonymizer |
| Docker Sandbox | 3.5 | Sandbox runs privately — no anonymization needed |

### Implementation Order

1. `DataClassifier` with built-in pattern library (regex-based)
2. `AnonymizerService` with pseudonym generation + session vault
3. Gateway integration — interceptor/rehydration wrapper (disabled by default)
4. Settings toggle: enable/disable privacy proxy per pipeline
5. Anonymization levels (Off / Standard / Strict / Paranoid)
6. `anonymization_log` table + audit logging
7. `anonymization_patterns` table + custom patterns API
8. Test anonymization endpoint (preview mode)
9. Frontend: Privacy settings page + test preview
10. MCP tool response anonymization (ArgoCD, K8s data)
11. `llm_requests` dual storage (anonymized sent + original encrypted)

### Open Design Questions (Phase 3.7)

| # | Question | Options |
|---|---------|---------|
| 27 | **Vault storage** | A) In-memory (lost on restart) B) Encrypted DB C) Redis with TTL |
| 28 | **Audit retention** | A) Forever B) Configurable TTL (90d) C) Compliance-dependent |
| 29 | **MCP tool responses** | A) Anonymize all B) Only sensitive tools C) Configurable per-tool |
| 30 | **Pseudonym consistency** | A) Per-session B) Per-pipeline C) Global |
| 31 | **Original data in logs** | A) Store encrypted B) Never store C) Per-profile config |

---

## Phase 4 — Code Workspace (Claude Code-like experience)

> Goal: дать пользователю возможность подключить локальный или удалённый репозиторий и работать с кодом через Chat и Code интерфейсы — как в Claude Code, но с мульти-модельным бэкендом.

### 4.1 — Workspace & Repository Management

- [ ] **Workspace model** — новая сущность `workspaces` в DB:
  ```
  id, name, type ("local" | "git_remote"), path, gitUrl, branch, lastSyncedAt, createdAt
  ```
- [ ] **Add local repo** — пользователь указывает путь на диске; бэкенд валидирует что это git-репо, читает `.gitignore`, строит file tree
- [ ] **Clone remote repo** — пользователь вводит git URL; бэкенд клонирует в `data/workspaces/{id}/`, отслеживает branch
- [ ] **File system service** (`server/services/filesystem.ts`):
  - `listDir(path)` → рекурсивный tree с иконками по расширению
  - `readFile(path)` → содержимое + язык + размер
  - `writeFile(path, content)` → запись с бэкапом
  - `searchFiles(query)` → glob/grep по содержимому и именам
  - Уважает `.gitignore` — никогда не показывает `node_modules`, `.env`, etc.
- [ ] **Git service** (`server/services/git.ts`):
  - `status()` → modified, staged, untracked files
  - `diff(file?)` → unified diff
  - `log(limit)` → история коммитов
  - `checkout(branch)`, `createBranch(name)`
  - `commit(message, files[])`, `push()`, `pull()`
  - Все git-операции через `simple-git` (npm package)

### 4.2 — API Endpoints

- [ ] **`/api/workspaces`** — CRUD для workspace'ов
  ```
  POST   /api/workspaces              — create (local path or git URL)
  GET    /api/workspaces              — list all
  GET    /api/workspaces/:id          — details + status
  DELETE /api/workspaces/:id          — remove (не удаляет файлы для local)
  ```
- [ ] **`/api/workspaces/:id/files`** — файловые операции
  ```
  GET    /files?path=/src             — directory listing (tree)
  GET    /files/content?path=src/index.ts  — file content
  PUT    /files/content               — write file { path, content }
  POST   /files/search                — search { query, type: "filename"|"content" }
  DELETE /files?path=...              — delete file (с подтверждением)
  ```
- [ ] **`/api/workspaces/:id/git`** — git операции
  ```
  GET    /git/status                  — status + branch + remotes
  GET    /git/diff?path=...           — diff (all or per-file)
  GET    /git/log?limit=20            — commit history
  POST   /git/commit                  — { message, files[] }
  POST   /git/checkout                — { branch }
  POST   /git/push, /git/pull
  ```
- [ ] **`/api/workspaces/:id/terminal`** — shell execution
  ```
  POST   /terminal/exec               — { command, cwd? } → { stdout, stderr, exitCode }
  WS     /terminal/stream             — interactive PTY через WebSocket (xterm.js)
  ```

### 4.3 — Frontend: Code Editor Page

- [ ] **Новая страница `/editor`** — основной IDE-подобный интерфейс, layout:
  ```
  ┌─────────────────────────────────────────────────────────────┐
  │ Toolbar: [Workspace selector ▾] [Branch ▾] [git status]    │
  ├────────────┬────────────────────────────────────────────────┤
  │            │                                                │
  │  File Tree │   Editor Tabs                                  │
  │  (sidebar) │   ┌──────────┬──────────┐                     │
  │            │   │ index.ts │ utils.ts │ ...                  │
  │  src/      │   ├──────────┴──────────┘                     │
  │   ├─ comp/ │   │                                            │
  │   ├─ pages/│   │  Monaco Editor                             │
  │   └─ utils/│   │  (syntax highlight, intellisense,          │
  │  package.  │   │   multi-cursor, diff view)                 │
  │  json      │   │                                            │
  │            │   │                                            │
  ├────────────┴───┴────────────────────────────────────────────┤
  │  Bottom Panel (toggleable):                                 │
  │  [Chat] [Terminal] [Git] [Problems]                         │
  │                                                             │
  │  Chat: talk to any model about the open file / workspace    │
  │  Terminal: integrated shell (xterm.js)                      │
  │  Git: status, diff, commit UI                               │
  └─────────────────────────────────────────────────────────────┘
  ```
- [ ] **File Tree Component** (`FileTree.tsx`):
  - Lazy-loaded directory expansion (не грузит всё дерево сразу)
  - Иконки по типу файла (vscode-icons или simple-icons)
  - Контекстное меню: New File, New Folder, Rename, Delete
  - Поиск по файлам (Cmd+P / Ctrl+P)
  - Drag-and-drop для перемещения
- [ ] **Monaco Editor Integration** (`MonacoEditor.tsx`):
  - `@monaco-editor/react` — обёртка над VS Code editor
  - Tabs с открытыми файлами, закрытие, переключение
  - Auto-detect language по расширению
  - Diff view для git changes
  - Auto-save с дебаунсом (PUT /files/content)
  - Cmd+S для явного сохранения
- [ ] **Terminal Panel** (`TerminalPanel.tsx`):
  - `xterm.js` + `xterm-addon-fit` + `xterm-addon-web-links`
  - WebSocket подключение к бэкенду PTY
  - Несколько вкладок терминала
  - Copy/paste, цвета ANSI

### 4.4 — AI-Assisted Code Interaction (Chat + Code integration)

- [ ] **Контекст-aware Chat** — когда пользователь пишет в Chat, автоматически прикрепляется:
  - Текущий открытый файл (или выделенный фрагмент)
  - Workspace tree structure (top-level)
  - Git diff (если есть несохранённые изменения)
- [ ] **Chat → Code actions** — модель может предложить изменения, пользователь применяет одним кликом:
  ```
  Model: "Вот исправленная функция:"
  ```
  ```typescript
  function calculateTotal(items: Item[]) { ... }
  ```
  ```
  [Apply to src/utils.ts] [Copy] [Diff preview]
  ```
- [ ] **Code → Chat** — правый клик на код → "Ask AI about this" / "Explain" / "Refactor" / "Find bugs"
- [ ] **Inline suggestions** — модель может предложить edit прямо в Monaco (как GitHub Copilot):
  - Ghost text для autocomplete (опционально, Phase 5)
  - Inline diff для предложенных изменений: зелёный/красный прямо в редакторе
- [ ] **Slash commands в Chat** привязанные к workspace:
  ```
  /file src/index.ts         — прикрепить файл к контексту
  /search "TODO"             — найти по кодовой базе
  /diff                      — показать git diff
  /run npm test              — выполнить команду
  /commit "fix: typo"        — коммит через чат
  /explain                   — объяснить текущий файл
  /refactor                  — предложить рефакторинг
  ```
- [ ] **Multi-model code review** — отправить файл/diff на ревью нескольким моделям параллельно:
  - Claude анализирует архитектуру и безопасность
  - Gemini проверяет edge cases и тесты
  - Grok проверяет актуальность библиотек и best practices через web search
  - Результаты отображаются side-by-side

### 4.5 — Security & Sandboxing

- [ ] **Path traversal protection** — все файловые операции нормализуют путь и проверяют что он внутри workspace root
- [ ] **`.gitignore` enforcement** — файлы из gitignore никогда не отдаются в API / AI контекст
- [ ] **Sensitive file detection** — предупреждение при попытке открыть `.env`, `*.key`, `*.pem`, `credentials.*`
- [ ] **Terminal sandboxing** — опциональный whitelist команд; запрет `rm -rf /`, `sudo`, etc.
- [ ] **AI context limits** — не отправлять моделям файлы > 100KB; бинарные файлы исключаются автоматически

---

## Phase 5 — Advanced Features (post-launch)

- [ ] **Model specialization presets** — recommended model assignments based on each provider's strengths:
  - **Claude** → Planning, Architecture, Code Review (strong reasoning, system design)
  - **Gemini** → Development, Testing (large context, code generation)
  - **Grok** → Fact-checking, Monitoring, web-grounded verification (real-time search, live data)
  - Allow users to define custom specialization profiles
- [ ] **Stage reordering** — drag-to-reorder in pipeline builder (`MultiAgentPipeline.tsx`); remove hardcoded `TEAM_ORDER` dependency
- [ ] **Custom stages** — let users add stages beyond the 7 SDLC defaults (e.g. a "Summarize" stage, a "Translate" stage, a "Fact-check" stage)
- [ ] **Run comparison** — side-by-side view of two runs to compare model outputs for the same pipeline
- [ ] **Cost tracking** — aggregate token usage per run, per model, per provider; display in dashboard and run detail view
- [ ] **Export run output** — download generated files as a ZIP from `StageOutput` / `CodePreview`
- [ ] **Messaging channels** — Telegram / Slack bot that can trigger pipeline runs, receive notifications, answer agent questions remotely (inspired by DeerFlow's multi-channel support)
- [ ] **Embedded SDK / API client** — `MultiqltiClient` class for programmatic access: `client.runPipeline({ task, models })` — enables CI/CD integration and scripting without UI
- [ ] **Bring-your-own-agent** — allow connecting external agents (Claude Code, Cursor, Codex) as pipeline stage executors via heartbeat/webhook protocol (inspired by Paperclip). Pipeline becomes the orchestrator, external tools become workers

---

## Open Design Questions

> Answers needed before Phase 1 design is finalized.

| # | Question | Options |
|---|----------|---------|
| 1 | **API key storage** | A) DB only (encrypted) B) Env vars only C) Env var as fallback, DB as override |
| 2 | **Persistence now?** | A) Activate PostgreSQL now (Phase 0) B) Keep in-memory for this iteration |
| 3 | **Multi-model routing strategy** | A) Per-stage assignment only B) Strategy presets only C) Presets + per-stage overrides |
| 4 | **Target models at launch** | Claude: which tiers? Gemini: Flash only or Pro too? Grok: 3 + mini? |
| 5 | **Streaming** | A) Full streaming token-by-token to UI B) Batch response per stage acceptable |
| 6 | **Scope** | A) Fix tech debt alongside providers B) Providers + key UI first, debt later |
| 7 | **Workspace storage** | A) Local path only (mount volume in Docker) B) Clone remote into `data/workspaces/` C) Both |
| 8 | **Editor component** | A) Monaco (VS Code engine, heavy ~2MB) B) CodeMirror 6 (lighter, extensible) C) Both with toggle |
| 9 | **Terminal execution** | A) Sandboxed commands only (whitelist) B) Full PTY (user responsibility) C) Docker-isolated shell |
| 10 | **AI file context strategy** | A) Send full file to model B) Smart chunking (only relevant sections) C) Embeddings + retrieval |
| 11 | **Web search provider** | A) Tavily (best quality, paid) B) DuckDuckGo (free) C) Grok native search (via xAI) D) All as options |
| 12 | **Memory scope** | ✅ **C) Both with hierarchy** — `global > workspace > pipeline > run`, narrower overrides broader |
| 12a | **Memory auto-extract** | ✅ **Hybrid** — hard rules per stage type + optional `"memories"` array in model output |
| 12b | **Memory injection** | ✅ **System message append** — max 15% of context limit, ranked by relevance |
| 12c | **Memory conflicts** | ✅ **Latest-wins + confidence decay** — 0.1/run decay, user preferences never decay |
| 13 | **Skills format** | A) Markdown (DeerFlow-style) B) JSON schema C) YAML with frontmatter |
| 14 | **Parallel execution** | A) Fan-out within stages only B) Parallel stages (DAG) C) Both |
| 15a | **Maintenance: Scout LLM** | ✅ **A) Pure code** — Scout is a data collector, no LLM. SDLC pipeline does the heavy analysis |
| 15b | **Maintenance: finding dedup** | ✅ **B) Re-evaluate** — every scan re-evaluates (CVE severity can change). User selects actions |
| 15c | **Maintenance: PR strategy** | ✅ **A) One PR per finding** — clean rollback, independent review |
| 15d | **Maintenance: notifications** | ✅ **Scout shows results in UI** — user selects findings → SDLC or backlog. Auto-notify TBD after testing |
| 15e | **Maintenance: history** | ✅ **C) Trends + recommendations** — health score trends, mean-time-to-remediate, platform suggests policy changes |
| 16 | **Pipeline mode default** | A) Sequential only (DAG opt-in) B) DAG always C) Auto-detect (linear input = sequential, multi-dep = DAG) |
| 17 | **Guardrail LLM** | A) Same model as stage B) Always use cheap model (Haiku/Flash) for validation C) Configurable per stage |
| 18 | **Condition expressions** | A) Simple field checks only B) JS-like safe expressions (no eval) C) Full sandboxed JS eval |
| 19 | **Trigger auth** | A) Webhook secret only B) API key per trigger C) OAuth for GitHub events |
| 20 | **Delegation depth** | A) Max 1 (no recursive delegation) B) Max 2 C) Configurable |
| 21 | **Manager mode scope** | A) Full pipeline only B) Can manage sub-pipelines C) Both |
| 22 | **Swarm merge** | A) Simple concatenation B) LLM merge (extra cost) C) Both as options |
| 23 | **Sandbox runtime** | A) Docker socket mount (dev only) B) gVisor for prod C) Firecracker for SaaS D) Configurable per environment |
| 24 | **Token budget default** | A) 100K tokens per stage B) Proportional to model context (e.g. 50% of context limit) C) User-configurable per stage |
| 25 | **Semantic cache scope** | A) Per-pipeline cache B) Global cache across pipelines C) Both with toggle |
