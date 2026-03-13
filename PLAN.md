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

> Goal: give pipeline stages access to tools — web search, knowledge bases, code, infrastructure — via the MCP protocol and built-in tools. The model decides when and which tool to call (agentic loop).

#### 3.1.0 — Architecture: Agentic Tool Loop

```
┌──────────────┐
│  BaseTeam     │
│  .execute()   │
└──────┬───────┘
       │ messages + tools[]
       ▼
┌──────────────────────────┐
│  Gateway.completeWithTools()  │  ← NEW method
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

**Key principle**: the model decides whether to call a tool. We provide it with the list of available tools, it returns `tool_use` blocks. The Gateway executes them and passes the result back. The loop continues until a final text response (max 10 iterations).

#### 3.1.1 — Extending ILLMProvider for Tool Calling

- [ ] **New type `ToolDefinition`**:
  ```typescript
  // shared/types.ts
  export interface ToolDefinition {
    name: string;                              // unique call ID
    description: string;                       // for the model: when to call
    inputSchema: Record<string, unknown>;      // JSON Schema of parameters
    source: "builtin" | "mcp";                 // where the tool comes from
    mcpServer?: string;                        // MCP server name (if source=mcp)
  }

  export interface ToolCall {
    id: string;                                // unique call ID
    name: string;                              // tool name
    arguments: Record<string, unknown>;        // arguments from the model
  }

  export interface ToolResult {
    toolCallId: string;
    content: string;                           // execution result
    isError?: boolean;
  }

  // Extended ProviderMessage for tool calling
  export type ProviderMessage =
    | { role: "system" | "user" | "assistant"; content: string }
    | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
    | { role: "tool"; toolCallId: string; content: string };
  ```

- [ ] **Extend `ILLMProviderOptions`**:
  ```typescript
  export interface ILLMProviderOptions {
    maxTokens?: number;
    temperature?: number;
    tools?: ToolDefinition[];                  // ← NEW: available tools
    toolChoice?: "auto" | "none" | "required"; // ← NEW: calling strategy
  }
  ```

- [ ] **Extend return type of `complete()`**:
  ```typescript
  complete(...): Promise<{
    content: string;
    tokensUsed: number;
    inputTokens?: number;
    outputTokens?: number;
    toolCalls?: ToolCall[];                    // ← NEW: if the model wants to call a tool
    finishReason: "stop" | "tool_use";         // ← NEW
  }>
  ```

- [ ] **Implementation in each provider**:
  - **ClaudeProvider**: Anthropic API natively supports tools — `tools` param + `tool_use` content blocks
  - **GeminiProvider**: Google API supports `functionDeclarations` + `functionCall` response parts
  - **GrokProvider**: xAI OpenAI-compatible — `tools` param + `tool_calls` in response (like OpenAI)
  - **VllmProvider/OllamaProvider**: depends on the model, but OpenAI-compatible format is supported by vLLM

#### 3.1.2 — Tool Registry (`server/tools/registry.ts`)

- [ ] **Unified registry of all available tools**:
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

- [ ] **Tool categories**:
  ```
  ToolRegistry
  ├── builtin/          — built-in tools (web search, RAG, code)
  │   ├── web_search        — internet search
  │   ├── url_reader        — extract content from a URL
  │   ├── knowledge_search  — RAG over llm_requests + docs
  │   ├── code_search       — search the codebase (grep/ast)
  │   ├── file_read         — read a file from the workspace
  │   └── calculator        — calculations
  │
  └── mcp/              — tools from connected MCP servers
      ├── github__*         — GitHub operations
      ├── terraform__*      — Terraform docs/commands
      ├── kubernetes__*     — K8s cluster operations
      ├── notion__*         — Notion pages/databases
      └── {custom}__*       — any user-provided MCP server
  ```

#### 3.1.3 — MCP Client Manager (`server/tools/mcp-client.ts`)

- [ ] **Connect to external MCP servers** via `@modelcontextprotocol/sdk`:
  ```typescript
  class McpClientManager {
    private connections: Map<string, McpConnection> = new Map();

    // Connect an MCP server
    async connect(config: McpServerConfig): Promise<void>;
    // Disconnect
    async disconnect(serverName: string): Promise<void>;
    // Get all tools from all connected servers
    getTools(): ToolDefinition[];
    // Call a tool on a specific server
    async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string>;
    // Connection status
    getStatus(): Record<string, { connected: boolean; tools: number; error?: string }>;
  }

  interface McpServerConfig {
    name: string;                             // unique name: "github", "terraform", "my-notion"
    transport: "stdio" | "sse" | "streamable-http";
    command?: string;                         // for stdio: path to binary
    args?: string[];                          // command arguments
    url?: string;                             // for sse/http: server URL
    env?: Record<string, string>;             // environment variables (API keys, etc.)
    enabled: boolean;
    autoConnect: boolean;                     // connect on application start
  }
  ```

- [ ] **DB: `mcp_servers` table** — storing configurations:
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

#### 3.1.4 — Built-in Tools

##### Web Search

- [ ] **`web_search`** — internet search:
  ```typescript
  // server/tools/builtin/web-search.ts
  // Multiple providers supported via abstraction:

  interface SearchProvider {
    search(query: string, options?: { limit?: number; domain?: string }): Promise<SearchResult[]>;
  }

  // Implementations:
  class TavilySearch implements SearchProvider { }   // TAVILY_API_KEY — best quality, paid
  class BraveSearch implements SearchProvider { }    // BRAVE_API_KEY — free tier
  class ExaSearch implements SearchProvider { }      // EXA_API_KEY — semantic search
  class DuckDuckGoSearch implements SearchProvider { } // free, no API key required

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

- [ ] **`url_reader`** — extract content from a URL:
  ```typescript
  // Jina AI Reader (https://r.jina.ai/{url}) or Firecrawl
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

- [ ] **`knowledge_search`** — search the internal knowledge base (RAG from the `llm_requests` table from Phase 3.2):
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
  **Implementation**:
  - Phase 1: PostgreSQL full-text search over `llm_requests.responseContent` (pg_trgm)
  - Phase 2: pgvector embeddings — `CREATE EXTENSION vector` + embedding column + cosine similarity
  - Phase 3: External vector store (Qdrant/Pinecone) for scaling

- [ ] **`memory_search`** — search the system memory (from Phase 3.3):
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

- [ ] **`code_search`** — search the workspace codebase (Phase 4 dependency):
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

- [ ] **`file_read`** — read a file from the workspace:
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

#### 3.1.5 — Recommended MCP Servers

| MCP server | What it provides | Which stages use it | Env vars |
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

- [ ] **Extend `PipelineStageConfig`**:
  ```typescript
  export interface PipelineStageConfig {
    teamId: TeamId;
    modelSlug: string;
    systemPromptOverride?: string;
    enabled: boolean;
    sandbox?: SandboxConfig;
    tools?: StageToolConfig;              // ← NEW
  }

  export interface StageToolConfig {
    enabled: boolean;                     // enable/disable tools for stage
    allowedTools?: string[];              // whitelist tool names (null = all available)
    blockedTools?: string[];              // blacklist (useful for security)
    maxToolCalls?: number;                // call limit per stage (default: 10)
    toolChoice?: "auto" | "none" | "required";
  }
  ```

- [ ] **Default tool assignments by team type**:
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

- [ ] **New method in Gateway** — agentic tool loop:
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

      // Model returned a final response
      if (result.finishReason === "stop" || !result.toolCalls?.length) {
        return { content: result.content, tokensUsed: totalTokens, toolCallLog, ... };
      }

      // Model wants to call tools
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

- [ ] **BaseTeam update** — use `completeWithTools` when tools are enabled:
  ```typescript
  // base.ts — execute()
  const tools = this.getAvailableTools(context);  // from StageToolConfig + defaults

  const response = tools.length > 0
    ? await this.gateway.completeWithTools({ modelSlug, messages, tools })
    : await this.gateway.complete({ modelSlug, messages });
  ```

#### 3.1.8 — API Endpoints

- [ ] **MCP Server management**:
  ```
  GET    /api/mcp/servers              — list connected MCP servers
  POST   /api/mcp/servers              — add an MCP server
  PUT    /api/mcp/servers/:id          — update configuration
  DELETE /api/mcp/servers/:id          — delete
  POST   /api/mcp/servers/:id/connect  — connect
  POST   /api/mcp/servers/:id/disconnect — disconnect
  GET    /api/mcp/servers/:id/tools    — list tools from server
  POST   /api/mcp/servers/:id/test     — test call
  ```

- [ ] **Tools**:
  ```
  GET    /api/tools                    — all available tools (builtin + mcp)
  GET    /api/tools/builtin            — built-in tools only
  GET    /api/tools/status             — provider status (which API keys are configured)
  POST   /api/tools/:name/test         — test tool call
  ```

#### 3.1.9 — Frontend

- [ ] **Settings → Tools & MCP** — new section:
  - Built-in tools: status (configured/not), env var hints
  - MCP servers: list, add/remove, connect/disconnect, test
  - Each server: icon, name, transport, tool count, status badge

- [ ] **Pipeline Builder → Stage config → Tools tab**:
  - Toggle "Enable tool calling" per stage
  - Checklist of available tools (pre-selected per DEFAULT_TEAM_TOOLS)
  - Max iterations slider
  - Tool choice selector (auto/none/required)

- [ ] **Stage output → Tool calls section**:
  - Collapsible tool call log: tool name, args, result, duration
  - Icons by tool type (search, code, file, mcp)

#### 3.1.10 — Packages

```bash
npm install @modelcontextprotocol/sdk                # MCP client
npm install @anthropic-ai/sdk                         # already present — supports tools
npm install @tavily/core                              # Tavily search (optional)
```

#### 3.1.11 — Implementation Order

1. Types: `ToolDefinition`, `ToolCall`, `ToolResult`, extend `ProviderMessage`
2. `ToolRegistry` — basic registry + execute
3. Extend `ILLMProvider.complete()` for tool calling
4. Tool calling implementation in ClaudeProvider (Anthropic API natively)
5. `Gateway.completeWithTools()` — agentic loop
6. Built-in tools: `web_search` (Tavily/DuckDuckGo), `url_reader`
7. Built-in tools: `knowledge_search` (PostgreSQL full-text)
8. `McpClientManager` — connect external MCP servers
9. Per-stage tool config in `PipelineStageConfig`
10. `BaseTeam` update — auto-select completeWithTools
11. DB: `mcp_servers` table
12. API endpoints
13. Frontend: Settings → Tools & MCP
14. Frontend: Pipeline Builder → tool config per stage
15. Frontend: Stage output → tool call log

#### Dependencies on other phases

| Depends on | What it provides |
|------------|----------|
| Phase 3.2 (llm_requests) | `knowledge_search` searches over stored responses |
| Phase 3.3 (memory) | `memory_search` searches project memory |
| Phase 3.5 (sandbox) | Sandbox can be called as a tool (`code_execute`) |
| Phase 4 (workspace) | `code_search` and `file_read` work with workspace files |

### 3.1b — Other DeerFlow-Inspired Features

- [ ] **Parallel sub-agent execution** — allow pipeline stages to spawn parallel sub-tasks. Example: Development stage can fan out into frontend + backend + database sub-agents, each on a different model, then merge results
- [ ] **Persistent memory across runs** — see **Memory System Design** (3.3) below for full architecture
- [ ] **Skills system (markdown-based)** — extensible skill definitions as markdown files. Each skill = system prompt + tools + output schema. Users can create custom skills and assign them to pipeline stages

### 3.2 — Statistics, Request Log & Cost Tracking

> Goal: detailed model usage statistics, storing all requests/responses for subsequent RAG and fine-tuning inference.

#### 3.2.1 — DB: `llm_requests` table (log of all LLM calls)

- [ ] **New `llm_requests` table** — every provider call is recorded:
  ```typescript
  // shared/schema.ts
  export const llmRequests = pgTable("llm_requests", {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    // Call context
    runId: varchar("run_id").references(() => pipelineRuns.id),       // nullable — standalone chat is also logged
    stageExecutionId: varchar("stage_execution_id").references(() => stageExecutions.id),
    // Model and provider
    modelSlug: text("model_slug").notNull(),
    modelId: text("model_id").notNull(),                              // provider-side ID (claude-sonnet-4-6, grok-3, etc.)
    provider: text("provider").notNull(),                              // anthropic, google, xai, vllm, ollama
    // Request
    messages: jsonb("messages").notNull(),                             // full messages array (for RAG/replay)
    systemPrompt: text("system_prompt"),                               // system prompt separately for easy search
    temperature: real("temperature"),
    maxTokens: integer("max_tokens"),
    // Response
    responseContent: text("response_content").notNull(),               // full response text
    responseRaw: jsonb("response_raw"),                                // raw provider response (for debug)
    // Metrics
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),             // time from request to full response
    estimatedCostUsd: real("estimated_cost_usd"),                      // calculated per model pricing
    // Meta
    status: text("status").notNull().default("success"),               // success | error | timeout
    errorMessage: text("error_message"),
    teamId: text("team_id"),                                           // planning, development, testing, etc.
    tags: jsonb("tags").default(sql`'[]'::jsonb`),                     // arbitrary tags for filtering
    createdAt: timestamp("created_at").defaultNow(),
  });
  ```

- [ ] **Indexes** for fast analytics:
  ```sql
  CREATE INDEX idx_llm_requests_model ON llm_requests(model_slug, created_at);
  CREATE INDEX idx_llm_requests_provider ON llm_requests(provider, created_at);
  CREATE INDEX idx_llm_requests_run ON llm_requests(run_id);
  CREATE INDEX idx_llm_requests_created ON llm_requests(created_at);
  ```

#### 3.2.2 — Gateway: Request Logging

- [ ] **Wrap `Gateway.complete()` and `Gateway.stream()`** — record every call to `llm_requests`:
  ```typescript
  // Gateway.complete() — after receiving the result
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

- [ ] **Extend `GatewayRequest`** — add optional `runId`, `stageExecutionId`, `teamId` for linking to pipeline context

- [ ] **`ILLMProvider` returns separate token counts** — extend return type:
  ```typescript
  complete(...): Promise<{ content: string; tokensUsed: number; inputTokens?: number; outputTokens?: number }>
  ```

- [ ] **`MODEL_PRICING` table** in `shared/constants.ts`:
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

#### 3.2.3 — API: Statistics Endpoints

- [ ] **`GET /api/stats/overview`** — overall summary:
  ```json
  { "totalRequests": 1234, "totalTokens": { "input": 890000, "output": 340000 }, "totalCostUsd": 4.56, "totalRuns": 42 }
  ```

- [ ] **`GET /api/stats/by-model`** — statistics per model:
  ```json
  [{ "modelSlug": "claude-sonnet-4-6", "provider": "anthropic", "requests": 456, "tokens": { "input": 320000, "output": 120000 }, "costUsd": 2.76, "avgLatencyMs": 2340, "errorRate": 0.02 }]
  ```

- [ ] **`GET /api/stats/by-provider`** — aggregation by provider

- [ ] **`GET /api/stats/by-team`** — aggregation by SDLC team (planning, development, testing, ...)

- [ ] **`GET /api/stats/by-run/:runId`** — cost and tokens for a specific run

- [ ] **`GET /api/stats/timeline`** — time series for charts:
  ```
  ?granularity=hour|day|week  &from=...  &to=...  &groupBy=model|provider|team
  ```

- [ ] **`GET /api/stats/requests`** — paginated request log:
  ```
  ?page=1  &limit=50  &model=...  &provider=...  &runId=...  &from=...  &to=...
  ```

- [ ] **`GET /api/stats/requests/:id`** — full request with messages and response (for replay/debug)

- [ ] **`POST /api/stats/export`** — export to CSV/JSON/JSONL

#### 3.2.4 — Frontend: `/stats` page

- [ ] **New Statistics page** (`client/src/pages/Statistics.tsx`):
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

- [ ] **Router** — add `/stats` to `App.tsx`, navigation in sidebar

- [ ] **Hooks** — `useStatsOverview()`, `useStatsTimeline()`, `useStatsRequests()` in `use-pipeline.ts`

- [ ] **Dashboard update** — replace mock traffic chart with real data from `/api/stats/timeline`

#### 3.2.5 — Storage for Future RAG and Inference

- [ ] **Full messages in `llm_requests.messages`** (JSONB) — training data:
  - system prompt + user messages + assistant response
  - Full context of every call for replay
  - Fine-tuning: prompt → response pairs
  - RAG: search over past responses, similar questions

- [ ] **`responseContent` as text** — for full-text search:
  - Trigram index: `CREATE INDEX ... USING gin(response_content gin_trgm_ops)`
  - Or pg_tsvector for full-text search

- [ ] **Tags** — `llm_requests.tags` (JSONB array):
  - Auto-tags: `["pipeline:web-app", "stage:testing", "lang:typescript"]`
  - User tags via UI
  - Filtering in `/api/stats/requests`

- [ ] **Export for training** — `POST /api/stats/export-training`:
  - Format: JSONL (for fine-tuning)
  - Filters: model, status=success, date range
  - Output: prompt/completion pairs

- [ ] **Embeddings-ready** — structure prepared for Phase 5 RAG:
  - `messages` + `responseContent` → embed → vector store
  - Semantic cache: search for similar past requests → reuse response
  - Reduces repeated LLM calls

#### 3.2.6 — Implementation Order

1. `llm_requests` table + migration + indexes
2. Storage methods (`createLlmRequest`, `getLlmRequests`, `getLlmRequestStats`)
3. Gateway logging wrapper
4. `MODEL_PRICING` + `estimateCost()`
5. API endpoints `/api/stats/*`
6. Frontend: `/stats` page
7. Dashboard: replace mock data
8. Export (CSV/JSON/JSONL)
9. Full-text search + trigram index


#### 3.2.7 — Thought Tree (Reasoning Tree Visualization)

> Users need to see HOW the agent reached a decision, not just WHAT it produced. Thought Tree shows the chain of reasoning, tool calls, delegation and branching decisions as an interactive tree.

- [ ] **Thought Tree model**:
  ```typescript
  export interface ThoughtNode {
    id: string;
    parentId: string | null;
    type: "reasoning" | "tool_call" | "tool_result" | "delegation" | "decision" | "guardrail" | "memory_recall";
    label: string;                       // "Analyzing security requirements"
    content: string;                     // full text
    timestamp: number;
    durationMs?: number;
    metadata?: {
      model?: string;
      tokensUsed?: number;
      toolName?: string;
      delegatedTo?: string;
      decision?: string;                 // "chose PostgreSQL over MongoDB"
      confidence?: number;
    };
    children: ThoughtNode[];
  }
  ```

- [ ] **ThoughtTreeCollector** (`server/pipeline/thought-tree-collector.ts`):
  - Parses reasoning from LLM response:
    - `<thinking>` blocks (Claude extended thinking)
    - Markdown headings (`## Step N:`)
    - Tool call → tool result pairs from agentic loop
    - Delegation chains
    - Guardrail results
    - Memory recall events
  - Methods: `addFromLlmResponse()`, `addToolCall()`, `addToolResult()`, `addDelegation()`, `addDecision()`
  - `getTree()` → full tree, `serialize()` → JSON for storage

- [ ] **Extraction heuristics**:

  | Source | What we extract | Node type |
  |----------|---------------|----------|
  | Claude `<thinking>` blocks | Internal reasoning | `reasoning` |
  | Markdown headings | Structured steps | `reasoning` |
  | Agentic tool loop | Tool name + args → result | `tool_call` → `tool_result` |
  | `delegate_to_team` tool | Team, task, response | `delegation` |
  | Guardrail validation | Pass/fail + issues | `guardrail` |
  | Memory injection | Which memories used | `memory_recall` |
  | Explicit `"decision"` in output | Approach + alternatives | `decision` |

- [ ] **DB storage** — `thought_tree` JSONB column in `stage_executions` (or a separate table)

- [ ] **Frontend: Thought Tree viewer** (`ThoughtTree.tsx`):
  ```
  ┌─────────────────────────────────────────────────────────────┐
  │  Planning Stage — Thought Tree                    [Collapse]│
  ├─────────────────────────────────────────────────────────────┤
  │  🧠 Analyzing project requirements              2.3s  340tk│
  │  ├── 🔍 web_search("React auth best practices") 1.1s      │
  │  │   └── 📄 Found 5 results, top: Auth0 docs              │
  │  ├── 💭 Evaluating auth approaches                0.8s     │
  │  │   ├── Option A: JWT + refresh tokens                    │
  │  │   ├── Option B: Session-based auth                      │
  │  │   └── ✅ Decision: JWT (stateless, better for SPA)      │
  │  ├── 🧠 Designing component architecture          1.2s     │
  │  │   ├── 🔍 memory_recall("preferred frameworks")          │
  │  │   │   └── 📝 User prefers TypeScript + Zustand          │
  │  │   └── 💭 Mapping components to pages                    │
  │  └── 📋 Generating task breakdown                  0.9s     │
  │      ├── Task 1: Auth provider setup (high)                │
  │      ├── Task 2: Login/Register pages (high)               │
  │      └── Task 3: Protected routes (medium)                 │
  │                                                             │
  │  Total: 6.3s │ 1,240 tokens │ 2 tool calls │ 1 decision   │
  └─────────────────────────────────────────────────────────────┘
  ```
  - Collapsible/expandable nodes
  - Color coding: 🧠 reasoning, 🔍 tool, ✅ decision, ⚠️ guardrail
  - Click node → full content in side panel
  - Token count and timing per node
  - Filter: all / reasoning only / decisions only / tools only

- [ ] **API**: `GET /api/runs/:runId/stages/:stageIndex/thought-tree`
- [ ] **WS events**: `stage:thought_node` — stream nodes in real-time for live rendering

#### 3.2.8 — Automatic Model Downgrade for Trivial Tasks

> Not every task requires a powerful model. If a stage task is trivial (formatting, boilerplate, simple refactoring), automatically switch to a cheaper model. Savings of 80-95%.

- [ ] **Task complexity classifier** (`server/pipeline/complexity-classifier.ts`):
  ```typescript
  export type TaskComplexity = "trivial" | "standard" | "complex";

  class ComplexityClassifier {
    classify(input: StageInput): TaskComplexity;  // pure heuristics, no LLM
  }
  ```

  **Heuristics** (rules, ~0ms):

  | Signal | Trivial | Standard | Complex |
  |--------|---------|----------|---------|
  | Input length (chars) | < 500 | 500–5000 | > 5000 |
  | Files mentioned | 0–1 | 2–5 | > 5 |
  | Keywords | "format", "rename", "boilerplate", "simple" | — | "architecture", "security", "migration", "distributed" |
  | Previous stage output | < 1KB | 1–10KB | > 10KB |
  | Stage type | monitoring | development, testing | architecture, code_review |
  | Acceptance criteria | 0–2 | 3–5 | > 5 |
  | Explicit user flag | `complexity: "trivial"` | — | `complexity: "complex"` |

- [ ] **Model tier mapping**:
  ```typescript
  export const MODEL_TIERS: Record<string, Record<TaskComplexity, string>> = {
    anthropic: {
      trivial:  "claude-haiku-4-5",      // /bin/zsh.80/.00 per 1M
      standard: "claude-sonnet-4-6",     // .00/.00
      complex:  "claude-sonnet-4-6",
    },
    google: {
      trivial:  "gemini-2.0-flash",      // /bin/zsh.075//bin/zsh.30
      standard: "gemini-2.0-flash",
      complex:  "gemini-2.5-pro",        // .25/.00
    },
    xai: {
      trivial:  "grok-3-mini",           // /bin/zsh.30//bin/zsh.50
      standard: "grok-3",               // .00/.00
      complex:  "grok-3",
    },
  };
  ```

- [ ] **Auto-downgrade logic** in Pipeline Controller:
  ```typescript
  if (stage.autoModelRouting?.enabled !== false) {  // on by default
    const complexity = this.complexityClassifier.classify(stageInput);
    if (complexity === "trivial") {
      const cheapModel = MODEL_TIERS[provider]?.trivial;
      if (cheapModel && cheapModel !== configuredModel) {
        stage.modelSlug = cheapModel;
        broadcast("stage:model_downgraded", { from: configuredModel, to: cheapModel });
      }
    }
  }
  ```

- [ ] **Per-stage override**:
  ```typescript
  autoModelRouting?: {
    enabled: boolean;                  // default: true
    minComplexity?: TaskComplexity;    // min complexity for configured model
    trivialModel?: string;            // explicit override for trivial tasks
  };
  ```

- [ ] **Frontend**:
  - Badge `⚡ Auto: claude-haiku (trivial)` in StageProgress on downgrade
  - Toggle "Auto model routing" per stage in pipeline builder
  - Stats: `"Saved $2.73 by routing 8 trivial tasks to cheaper models (87% saving)"`

- [ ] **Logging** — extend `llm_requests`: `autoRouted: boolean`, `originalModelSlug: text`, `routingReason: text`

### 3.4 — Governance & Gates

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

> Goal: give the pipeline the ability to not only generate code/tests via LLM, but to **actually execute** them inside an isolated Docker container. Each stage can optionally run a generated artifact (build, tests, linting, arbitrary commands) inside an ephemeral container — with no access to the host system.

### Architecture

```
Pipeline Stage (e.g. Development / Testing)
    │
    ▼
┌───────────────────────┐
│ 1. LLM generates code │  ← team.execute() — as before
└──────────┬────────────┘
           │ result.output contains code / files / commands
           ▼
┌───────────────────────┐
│ 2. SandboxExecutor    │  ← NEW component
│    (if sandbox is     │
│     enabled for       │
│     this stage)       │
│                       │
│  • Creates tmp dir    │
│  • Writes files       │
│  • docker run ...     │
│  • Collects stdout/   │
│    stderr/exitCode    │
│  • Removes container  │
└──────────┬────────────┘
           │ SandboxResult: { exitCode, stdout, stderr, artifacts[] }
           ▼
┌───────────────────────┐
│ 3. Result             │
│    merged with        │
│    stage output       │
│    → passed forward   │
│    through pipeline   │
└───────────────────────┘
```

### 3.5.1 — Types and Configuration

- [ ] **`SandboxConfig` in `PipelineStageConfig`** — extend stage type:
  ```typescript
  // shared/types.ts — PipelineStageConfig extension
  export interface SandboxConfig {
    enabled: boolean;
    image: string;                      // Docker image, e.g. "node:20-alpine", "python:3.12-slim", "golang:1.22"
    command: string;                    // Command to execute, e.g. "npm test", "pytest", "go build ./..."
    workdir?: string;                   // Working directory inside the container (default: /workspace)
    timeout?: number;                   // Timeout in seconds (default: 120, max: 600)
    memoryLimit?: string;               // Docker memory limit, e.g. "512m", "1g"
    cpuLimit?: number;                  // CPU limit, e.g. 1.0
    networkDisabled?: boolean;          // Disable network (default: true — security)
    env?: Record<string, string>;       // Environment variables for the container
    extractArtifacts?: string[];        // Glob patterns for files to extract from the container (e.g. ["dist/**", "coverage/**"])
    installCommand?: string;            // Dependency install command before the main one (e.g. "npm install", "pip install -r requirements.txt")
  }

  export interface PipelineStageConfig {
    teamId: TeamId;
    modelSlug: string;
    systemPromptOverride?: string;
    enabled: boolean;
    sandbox?: SandboxConfig;            // ← NEW optional field
  }
  ```

- [ ] **`SandboxResult` type** — execution result:
  ```typescript
  export interface SandboxResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    artifacts: SandboxArtifact[];       // Extracted files
    containerImage: string;
    command: string;
    timedOut: boolean;
  }

  export interface SandboxArtifact {
    path: string;                       // Relative path inside the container
    content: string;                    // Base64 for binary, plain text for text files
    sizeBytes: number;
    isBinary: boolean;
  }
  ```

### 3.5.2 — SandboxExecutor (Backend Service)

- [ ] **Create `server/sandbox/executor.ts`** — main service:
  ```
  class SandboxExecutor {
    async execute(config: SandboxConfig, files: SandboxFile[]): Promise<SandboxResult>
    async isDockerAvailable(): Promise<boolean>
    async pullImage(image: string): Promise<void>
    async cleanup(containerId: string): Promise<void>
  }
  ```

  `execute()` algorithm:
  1. Create a temporary directory (`os.tmpdir()` + random suffix)
  2. Write files from `files[]` into tmp dir (LLM-generated code)
  3. If `installCommand` — run `docker run` with install command first
  4. Run `docker run` with the main `command`:
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
  5. Wait for completion with timeout (kill container if exceeded)
  6. Collect stdout/stderr via `docker logs` or pipe
  7. Extract artifacts matching `extractArtifacts` glob patterns
  8. Delete tmp dir and container
  9. Return `SandboxResult`

- [ ] **Docker API via `dockerode`** — use the `dockerode` npm package instead of spawning CLI:
  - Direct access to Docker Engine API via Unix socket
  - Real-time log streaming
  - Programmatic container lifecycle management
  - Fallback to CLI (`child_process.exec("docker ...")`) if dockerode is unavailable

- [ ] **Preset images (image presets)**:
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

### 3.5.3 — Integration into Pipeline Controller

- [ ] **Post-LLM execution hook** — after `team.execute()` in `PipelineController.executeStages()`:
  ```typescript
  // pipeline-controller.ts — inside stage loop, after result = await team.execute(...)

  let sandboxResult: SandboxResult | null = null;

  if (stage.sandbox?.enabled) {
    // Extract files from LLM output
    const files = this.extractFilesFromOutput(result.output);

    this.broadcast(run.id, {
      type: "stage:sandbox_started",
      payload: { stageIndex: i, image: stage.sandbox.image, command: stage.sandbox.command },
    });

    sandboxResult = await this.sandboxExecutor.execute(stage.sandbox, files);

    // Augment stage output with sandbox result
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

    // Optional: fail stage if sandbox returned ≠ 0
    if (stage.sandbox.failOnNonZero !== false && sandboxResult.exitCode !== 0) {
      throw new Error(`Sandbox execution failed (exit code ${sandboxResult.exitCode}): ${sandboxResult.stderr.slice(0, 500)}`);
    }
  }
  ```

- [ ] **`extractFilesFromOutput()` method** — parse generated files from LLM output:
  - Looks for markdown code blocks with file names (```typescript // filename: src/index.ts)
  - Looks for a JSON `files` array in output (if team formats output as `{ files: [{ path, content }], ... }`)
  - Looks for `code` / `sourceCode` / `testCode` fields in output

### 3.5.4 — WebSocket Events

- [ ] **New WS event types**:
  ```typescript
  // shared/types.ts — extend WsEventType
  | "stage:sandbox_started"       // Sandbox started
  | "stage:sandbox_progress"      // Streaming stdout/stderr in real time
  | "stage:sandbox_completed"     // Sandbox completed (exitCode, passed)
  ```

### 3.5.5 — DB Schema (optional)

- [ ] **`sandbox_executions` table** — for audit and debugging:
  ```
  id, stageExecutionId, image, command, exitCode, stdout (text), stderr (text),
  durationMs, timedOut, artifacts (jsonb), createdAt
  ```
  Relation: `sandbox_executions.stageExecutionId → stage_executions.id` (1:1)

### 3.5.6 — Frontend: Sandbox UI

- [ ] **Sandbox config in Pipeline Builder** (`AgentNode.tsx` or `StageConfig`):
  - Toggle "Enable sandbox execution" per stage
  - Image selector (dropdown from presets + custom input)
  - Command input (pre-filled from preset: build/test)
  - Timeout slider (30s — 600s)
  - Resource limits (memory, CPU)
  - Network toggle (on/off)
  - Artifact extraction patterns

- [ ] **Sandbox output in StageProgress/StageOutput**:
  - "Sandbox running..." indicator with timer
  - Built-in terminal-like block for stdout/stderr (streaming via WS)
  - Pass/Fail badge with exit code
  - Artifact download

### 3.5.7 — API Endpoints

- [ ] **`GET /api/sandbox/status`** — check Docker availability on host
- [ ] **`GET /api/sandbox/presets`** — list available image presets
- [ ] **`POST /api/sandbox/test`** — test run (`echo "hello"` in selected image)
- [ ] **`GET /api/sandbox/executions/:stageExecutionId`** — get sandbox result for stage
- [ ] **`GET /api/sandbox/executions/:id/artifacts/:path`** — download a specific artifact

### 3.5.8 — Security

- [ ] **Container runs without privileges** — `--security-opt=no-new-privileges`, `--cap-drop=ALL`
- [ ] **Read-only root filesystem** — `--read-only` + tmpfs for `/tmp`
- [ ] **Network disabled by default** — `--network=none`. Enabled explicitly if stage needs `npm install` from registry
- [ ] **Memory + CPU limits required** — fallback to `512m` / `1.0 CPU` if not specified
- [ ] **Timeout required** — kill container after `timeout` seconds (default 120, max 600)
- [ ] **No bind mounts to host system** — only tmpdir with generated files
- [ ] **Image whitelist** (optional) — admin can restrict allowed images in config
- [ ] **Logging** — all sandbox runs are written to `sandbox_executions` for audit
- [ ] **Container always `--rm`** — auto-removed after completion, no "stuck" containers

### 3.5.9 — Docker-in-Docker (DinD) for Production

- [ ] **docker-compose.yml** — add sandbox-ready configuration:
  ```yaml
  services:
    multiqlti:
      volumes:
        - /var/run/docker.sock:/var/run/docker.sock  # Access to host Docker Engine
        - sandbox-tmp:/tmp/multiqlti-sandbox          # Shared tmpdir for files
      environment:
        - SANDBOX_ENABLED=true
        - SANDBOX_MAX_CONCURRENT=3          # Max concurrent containers
        - SANDBOX_DEFAULT_TIMEOUT=120
        - SANDBOX_ALLOWED_IMAGES=node:20-alpine,python:3.12-slim,golang:1.22-alpine
  ```

- [ ] **Alternative: sysbox runtime** — for full isolation without docker.sock mount:
  - `docker run --runtime=sysbox-runc` — container with its own Docker daemon
  - Safer for multi-tenant, but more complex setup

### 3.5.10 — Use Cases

| Scenario | Stage | Image | Command | Network |
|----------|-------|-------|---------|------|
| Build Node.js project | Development | `node:20-alpine` | `npm install && npm run build` | on (npm registry) |
| Run unit tests | Testing | `node:20-alpine` | `npm test` | off |
| Lint Python code | Code Review | `python:3.12-slim` | `pip install ruff && ruff check .` | on (pip) |
| Compile Go service | Development | `golang:1.22-alpine` | `go build -o /workspace/dist/app ./cmd/server` | on (go modules) |
| Security scan | Code Review | `aquasec/trivy:latest` | `trivy fs --exit-code 1 /workspace` | on (vuln DB) |
| Terraform validate | Deployment | `hashicorp/terraform:latest` | `terraform init && terraform validate` | on (providers) |
| Isolated shell | Custom | any | user-defined | user-defined |

### 3.5.11 — Packages

```bash
npm install dockerode @types/dockerode
```

### 3.5.12 — Implementation Order

1. `SandboxConfig` + `SandboxResult` types in `shared/types.ts`
2. `SandboxExecutor` service (`server/sandbox/executor.ts`)
3. Integration into `PipelineController` (post-LLM hook)
4. WS events for sandbox lifecycle
5. API endpoints (`/api/sandbox/*`)
6. DB table `sandbox_executions`
7. Frontend: config UI in pipeline builder
8. Frontend: output display in StageProgress
9. Docker-compose update
10. Security hardening + tests

### Open Design Questions (Phase 3.5)

| # | Question | Options |
|---|--------|----------|
| 15 | **Docker access** | A) Docker socket mount (simple, less secure) B) Docker-in-Docker (sysbox) C) Remote Docker API (TCP) |
| 16 | **Files from LLM** | A) Parse markdown code blocks B) Require JSON `{ files: [...] }` from teams C) Both |
| 17 | **Fail policy** | A) Sandbox fail = stage fail (default) B) Sandbox fail = warning, stage continues C) Configurable per-stage |
| 18 | **Log streaming** | A) Full stdout/stderr via WS in real time B) Final result only C) Streaming + summary |
| 19 | **Workspace binding** | A) Sandbox works only with LLM-generated files B) Sandbox can mount workspace from Phase 4 C) Both |
| 20 | **Images** | A) Whitelist only B) Any public image C) Whitelist + admin can add more |

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

> Goal: give users the ability to connect a local or remote repository and work with code through Chat and Code interfaces — like Claude Code, but with a multi-model backend.

### 4.1 — Workspace & Repository Management

- [ ] **Workspace model** — new `workspaces` entity in DB:
  ```
  id, name, type ("local" | "git_remote"), path, gitUrl, branch, lastSyncedAt, createdAt
  ```
- [ ] **Add local repo** — user provides a path on disk; backend validates it is a git repo, reads `.gitignore`, builds file tree
- [ ] **Clone remote repo** — user enters git URL; backend clones into `data/workspaces/{id}/`, tracks branch
- [ ] **File system service** (`server/services/filesystem.ts`):
  - `listDir(path)` → recursive tree with icons by extension
  - `readFile(path)` → content + language + size
  - `writeFile(path, content)` → write with backup
  - `searchFiles(query)` → glob/grep by content and names
  - Respects `.gitignore` — never exposes `node_modules`, `.env`, etc.
- [ ] **Git service** (`server/services/git.ts`):
  - `status()` → modified, staged, untracked files
  - `diff(file?)` → unified diff
  - `log(limit)` → commit history
  - `checkout(branch)`, `createBranch(name)`
  - `commit(message, files[])`, `push()`, `pull()`
  - All git operations via `simple-git` (npm package)

### 4.2 — API Endpoints

- [ ] **`/api/workspaces`** — CRUD for workspaces
  ```
  POST   /api/workspaces              — create (local path or git URL)
  GET    /api/workspaces              — list all
  GET    /api/workspaces/:id          — details + status
  DELETE /api/workspaces/:id          — remove (does not delete files for local)
  ```
- [ ] **`/api/workspaces/:id/files`** — file operations
  ```
  GET    /files?path=/src             — directory listing (tree)
  GET    /files/content?path=src/index.ts  — file content
  PUT    /files/content               — write file { path, content }
  POST   /files/search                — search { query, type: "filename"|"content" }
  DELETE /files?path=...              — delete file (with confirmation)
  ```
- [ ] **`/api/workspaces/:id/git`** — git operations
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
  WS     /terminal/stream             — interactive PTY via WebSocket (xterm.js)
  ```

### 4.3 — Frontend: Code Editor Page

- [ ] **New `/editor` page** — main IDE-like interface, layout:
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
  - Lazy-loaded directory expansion (does not load entire tree at once)
  - Icons by file type (vscode-icons or simple-icons)
  - Context menu: New File, New Folder, Rename, Delete
  - File search (Cmd+P / Ctrl+P)
  - Drag-and-drop for moving
- [ ] **Monaco Editor Integration** (`MonacoEditor.tsx`):
  - `@monaco-editor/react` — wrapper over VS Code editor
  - Tabs with open files, close, switch
  - Auto-detect language by extension
  - Diff view for git changes
  - Auto-save with debounce (PUT /files/content)
  - Cmd+S for explicit save
- [ ] **Terminal Panel** (`TerminalPanel.tsx`):
  - `xterm.js` + `xterm-addon-fit` + `xterm-addon-web-links`
  - WebSocket connection to backend PTY
  - Multiple terminal tabs
  - Copy/paste, ANSI colors

### 4.4 — AI-Assisted Code Interaction (Chat + Code integration)

- [ ] **Context-aware Chat** — when user types in Chat, automatically attaches:
  - Currently open file (or selected fragment)
  - Workspace tree structure (top-level)
  - Git diff (if there are unsaved changes)
- [ ] **Chat → Code actions** — model can propose changes, user applies with one click:
  ```
  Model: "Here is the corrected function:"
  ```
  ```typescript
  function calculateTotal(items: Item[]) { ... }
  ```
  ```
  [Apply to src/utils.ts] [Copy] [Diff preview]
  ```
- [ ] **Code → Chat** — right-click on code → "Ask AI about this" / "Explain" / "Refactor" / "Find bugs"
- [ ] **Inline suggestions** — model can propose edit directly in Monaco (like GitHub Copilot):
  - Ghost text for autocomplete (optional, Phase 5)
  - Inline diff for proposed changes: green/red directly in editor
- [ ] **Slash commands in Chat** bound to workspace:
  ```
  /file src/index.ts         — attach file to context
  /search "TODO"             — search the codebase
  /diff                      — show git diff
  /run npm test              — execute command
  /commit "fix: typo"        — commit via chat
  /explain                   — explain current file
  /refactor                  — suggest refactoring
  ```
- [ ] **Multi-model code review** — send file/diff for review to multiple models in parallel:
  - Claude analyzes architecture and security
  - Gemini checks edge cases and tests
  - Grok checks library currency and best practices via web search
  - Results displayed side-by-side

### 4.5 — Security & Sandboxing

- [ ] **Path traversal protection** — all file operations normalize the path and verify it is inside workspace root
- [ ] **`.gitignore` enforcement** — gitignore files are never exposed to API / AI context
- [ ] **Sensitive file detection** — warning when trying to open `.env`, `*.key`, `*.pem`, `credentials.*`
- [ ] **Terminal sandboxing** — optional command whitelist; block `rm -rf /`, `sudo`, etc.
- [ ] **AI context limits** — do not send files > 100KB to models; binary files are excluded automatically

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
| Phase 3.6 priority | Moved up — core product differentiator (MoA/Debate/Voting) |
| Phase 3.7 priority | PRIORITIZED — data privacy before sending to cloud providers |
| Thought Tree | Core debugging feature — split into 3 sub-tasks: data model, API/WS, frontend |
| Auto Model Downgrade | Keep in plan, defer design — needs smarter classification approach |
| Memory workspace scope | Logical grouping for now — full workspace model in Phase 4 |
| Section 3.3 numbering | Old "Governance & Gates" 3.3 renamed to 3.4 |

---

## Phase 3.5 — Docker Sandbox Execution (Isolated Stage Runtime)

> Goal: give the pipeline the ability to not just generate code/tests via LLM, but to **actually execute** them inside an isolated Docker container. Each stage can optionally run a generated artifact (build, tests, linting, arbitrary commands) inside an ephemeral container — with no access to the host system.

### Architecture

```
Pipeline Stage
  │
  ├─ LLM generates output (code, tests, commands)
  │
  ├─ Output parsed into ExecutionPlan:
  │   ├─ files: [{ path, content }]     ← written into container
  │   ├─ commands: ["npm install", "npm test"]
  │   ├─ image: "node:20-slim"          ← base Docker image
  │   └─ timeout: 120_000               ← max execution time (ms)
  │
  ├─ SandboxExecutor:
  │   1. Pull/verify image
  │   2. Create ephemeral container (no network by default)
  │   3. Copy files into /workspace
  │   4. Run commands sequentially
  │   5. Stream stdout/stderr via WebSocket
  │   6. Collect exit codes
  │   7. Copy output artifacts back (optional)
  │   8. Destroy container
  │
  └─ Result:
      ├─ exitCode: 0 | 1 | ...
      ├─ stdout: string
      ├─ stderr: string
      ├─ artifacts: [{ path, content }]  ← files produced
      └─ duration: number
```

### 3.5.1 — Types and Configuration

```typescript
// shared/types.ts

export interface SandboxConfig {
  enabled: boolean;
  image: string;                    // Docker image: "node:20-slim", "python:3.12-slim"
  timeout: number;                  // ms, default 120_000 (2 min)
  memoryLimit: string;              // Docker memory limit: "512m", "1g"
  cpuLimit: number;                 // CPU cores: 1, 2
  networkEnabled: boolean;          // default false (no network in sandbox)
  workdir: string;                  // default "/workspace"
  env: Record<string, string>;     // environment variables
}

export interface ExecutionPlan {
  files: Array<{ path: string; content: string }>;
  commands: string[];
  image?: string;                   // override stage-level image
  timeout?: number;                 // override stage-level timeout
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  artifacts: Array<{ path: string; content: string }>;
  duration: number;                 // ms
  containerInfo: {
    id: string;
    image: string;
    memoryUsed: number;
  };
}

// Extended PipelineStageConfig
export interface PipelineStageConfig {
  teamId: TeamId;
  modelSlug: string;
  systemPromptOverride?: string;
  temperature?: number;
  maxTokens?: number;
  sandbox?: SandboxConfig;          // NEW: optional sandbox per stage
}
```

### 3.5.2 — SandboxExecutor (Backend Service)

```typescript
// server/sandbox/executor.ts

class SandboxExecutor {
  constructor(private dockerSocket: string = "/var/run/docker.sock") {}

  async execute(plan: ExecutionPlan, config: SandboxConfig): Promise<SandboxResult>;

  // Pull image if not cached
  private async ensureImage(image: string): Promise<void>;

  // Create ephemeral container with resource limits
  private async createContainer(image: string, config: SandboxConfig): Promise<Container>;

  // Copy files into container's /workspace
  private async copyFiles(container: Container, files: ExecutionPlan["files"]): Promise<void>;

  // Run commands sequentially, stream output via callback
  private async runCommands(
    container: Container,
    commands: string[],
    onOutput: (stream: "stdout" | "stderr", data: string) => void,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;

  // Copy output artifacts back from container
  private async collectArtifacts(container: Container, paths: string[]): Promise<ExecutionPlan["files"]>;

  // Cleanup: stop + remove container
  private async cleanup(container: Container): Promise<void>;
}
```

**Docker API usage**:
```typescript
// Uses dockerode (Node.js Docker client)
import Docker from "dockerode";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// Create container with security limits
const container = await docker.createContainer({
  Image: config.image,
  Cmd: ["/bin/sh", "-c", commands.join(" && ")],
  WorkingDir: config.workdir,
  Env: Object.entries(config.env).map(([k, v]) => `${k}=${v}`),
  HostConfig: {
    Memory: parseMemoryLimit(config.memoryLimit),   // bytes
    NanoCpus: config.cpuLimit * 1e9,                // nano CPUs
    NetworkMode: config.networkEnabled ? "bridge" : "none",
    AutoRemove: true,
    ReadonlyRootfs: false,         // /workspace needs to be writable
    SecurityOpt: ["no-new-privileges"],
  },
});
```

### 3.5.3 — Integration into Pipeline Controller

```typescript
// pipeline-controller.ts — inside stage execution loop

// After LLM generates output:
const result = await team.execute(stageInput, teamContext);

// If sandbox is enabled for this stage:
if (stage.sandbox?.enabled && result.output.executionPlan) {
  const sandboxResult = await this.sandboxExecutor.execute(
    result.output.executionPlan,
    stage.sandbox,
  );

  // Stream sandbox output via WebSocket
  this.wsManager.emit(runId, "sandbox:output", {
    stageId: stage.teamId,
    stdout: sandboxResult.stdout,
    stderr: sandboxResult.stderr,
  });

  // Decision: what to do with sandbox result
  if (sandboxResult.exitCode !== 0) {
    // Stage fails — include error details
    result.output.sandboxError = {
      exitCode: sandboxResult.exitCode,
      stderr: sandboxResult.stderr,
    };
    // Mark stage as failed
    await this.storage.updateStageExecution(stageExecId, {
      status: "failed",
      output: result.output,
    });
    // Stop pipeline (or continue based on policy)
    throw new SandboxExecutionError(sandboxResult);
  }

  // Attach sandbox output to stage result
  result.output.sandboxResult = {
    exitCode: sandboxResult.exitCode,
    stdout: sandboxResult.stdout,
    artifacts: sandboxResult.artifacts,
    duration: sandboxResult.duration,
  };
}
```

### 3.5.4 — WebSocket Events

```typescript
// New WS events for sandbox streaming:
"sandbox:starting"     → { stageId, image, commands }
"sandbox:output"       → { stageId, stream: "stdout"|"stderr", data: string }
"sandbox:completed"    → { stageId, exitCode, duration }
"sandbox:error"        → { stageId, error: string }
```

### 3.5.5 — DB Schema (optional)

```sql
-- Track sandbox executions for debugging/audit
ALTER TABLE stage_executions ADD COLUMN sandbox_result JSONB;
-- Contains: { exitCode, stdout (truncated), stderr (truncated), duration, image }
```

### 3.5.6 — Frontend: Sandbox UI

- [ ] **Sandbox config per stage** in pipeline builder:
  - Toggle: "Enable code execution"
  - Docker image selector (preset: node:20-slim, python:3.12-slim, go:1.22, custom)
  - Resource limits (memory, CPU, timeout)
  - Network toggle (disabled by default with warning)

- [ ] **Sandbox output viewer** in run detail:
  ```
  ┌── Stage: Testing ─── Sandbox Output ────────────────────┐
  │  ▶ Running in node:20-slim (timeout: 120s)               │
  │  $ npm install                                            │
  │  added 47 packages in 2.3s                               │
  │  $ npm test                                               │
  │  PASS src/auth.test.ts (3 tests)                         │
  │  PASS src/users.test.ts (5 tests)                        │
  │  ✅ All tests passed (exit code 0, 4.2s)                  │
  └──────────────────────────────────────────────────────────┘
  ```
  - Collapsible by default (like design decision)
  - Real-time streaming via WebSocket
  - Color-coded: green for success, red for errors

### 3.5.7 — API Endpoints

```
POST /api/sandbox/test              — test sandbox config (pull image, run echo)
GET  /api/sandbox/images            — list available Docker images
GET  /api/runs/:id/sandbox/:stageId — get sandbox result for a stage execution
```

### 3.5.8 — Security

1. **No network by default** — `NetworkMode: "none"` prevents data exfiltration
2. **Resource limits** — memory + CPU caps prevent resource exhaustion
3. **Timeout** — hard kill after configured timeout (default 2 min)
4. **No host access** — no volume mounts to host filesystem
5. **No privilege escalation** — `no-new-privileges` security option
6. **Ephemeral** — containers auto-removed after execution
7. **Image whitelist** (optional) — restrict which Docker images can be used

### 3.5.9 — Docker-in-Docker (DinD) for Production

For production deployment where multiqlti itself runs in Docker:

```yaml
# docker-compose.yml
services:
  multiqlti:
    build: .
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # Option A: socket mount
    # OR
    privileged: true  # Option B: DinD (less secure but fully isolated)
```

**Socket mount** (recommended for dev):
- multiqlti talks to host Docker daemon
- Containers are siblings (not nested)
- Simpler, faster, but shared Docker daemon

**DinD** (recommended for prod/SaaS):
```yaml
services:
  multiqlti:
    build: .
    environment:
      - DOCKER_HOST=tcp://dind:2376
    depends_on:
      - dind

  dind:
    image: docker:dind
    privileged: true
    volumes:
      - docker-data:/var/lib/docker
    environment:
      - DOCKER_TLS_CERTDIR=/certs
    expose:
      - "2376"

volumes:
  docker-data:
```

For maximum isolation (SaaS/multi-tenant):
- Use **gVisor** (`runsc`) or **Firecracker** as container runtime
- Each tenant gets isolated Docker daemon
- Network policies via Kubernetes NetworkPolicy

### 3.5.10 — Use Cases

| Stage | What gets executed | Why |
|-------|--------------------|-----|
| Development | Generated code → build + lint | Verify code compiles before passing to next stage |
| Testing | Generated tests → run in container | Actual test execution, not just LLM-generated test text |
| Code Review | Run static analysis tools (eslint, sonar) | Real findings, not hallucinated ones |
| Deployment | Terraform validate, Helm lint | Validate IaC before marking stage complete |
| Monitoring | Health check scripts | Verify monitoring endpoints after deployment |

### 3.5.11 — Packages

```bash
npm install dockerode          # Docker API client
npm install @types/dockerode   # TypeScript types
```

### 3.5.12 — Implementation Order

1. Types: `SandboxConfig`, `ExecutionPlan`, `SandboxResult`
2. `SandboxExecutor` service with Docker socket connection
3. LLM output parsing: extract `executionPlan` from team output
4. Pipeline Controller integration: execute sandbox after LLM stage
5. WebSocket events for live streaming
6. Frontend: sandbox config in pipeline builder
7. Frontend: sandbox output viewer in run detail
8. API endpoints for testing/management
9. DB schema extension for audit trail
10. Security hardening: image whitelist, resource limit validation

### Open Design Questions (Phase 3.5)

| # | Question | Options |
|---|----------|---------|
| 23 | **Sandbox runtime** | A) Docker socket mount (dev only) B) gVisor for prod C) Firecracker for SaaS D) Configurable per environment |
| 24 | **Token budget default** | A) 100K tokens per stage B) Proportional to model context (e.g. 50% of context limit) C) User-configurable per stage |

---

## Phase 3.6 — Multi-Model Execution Strategies (MoA, Debate, Voting)

> Goal: allow each pipeline stage to use **multiple models simultaneously** with different coordination strategies — not just "one model per stage" but sophisticated multi-model patterns that improve output quality.

### Core Concept

Current flow: `Stage → 1 model → 1 output`
New flow: `Stage → N models → Strategy → 1 merged output`

```
Stage Input
    │
    ├─► Model A (Claude)  ──► Output A ─┐
    ├─► Model B (Gemini)  ──► Output B ─┤─► Strategy ──► Final Output
    └─► Model C (Grok)    ──► Output C ─┘

Strategies:
  1. MoA (Mixture-of-Agents): models refine each other's outputs in rounds
  2. Debate: models argue, judge picks winner
  3. Voting: models vote independently, majority wins
```

### Recommended Strategy per SDLC Stage

| Stage | Best Strategy | Why |
|-------|--------------|-----|
| Planning | **MoA** | Multiple perspectives refined into comprehensive plan |
| Architecture | **Debate** | Models argue trade-offs (microservices vs monolith), judge picks |
| Development | **Voting** | Multiple implementations, pick most consistent/correct |
| Testing | **MoA** | One model writes tests, another reviews, third adds edge cases |
| Code Review | **Voting** | Multiple reviewers, aggregate findings (union of all issues found) |
| Deployment | **Single** | Usually one correct approach, multi-model adds risk |
| Monitoring | **Single** | Straightforward config generation |

### Type Definitions

```typescript
// shared/types.ts

export type ExecutionStrategy = "single" | "moa" | "debate" | "voting";

export interface StrategyConfig {
  strategy: ExecutionStrategy;
  models: string[];                  // model slugs to use (2-5)

  // MoA-specific
  moa?: {
    rounds: number;                  // refinement rounds (default 2)
    aggregatorModel: string;         // model that produces final synthesis
  };

  // Debate-specific
  debate?: {
    rounds: number;                  // debate rounds (default 3)
    judgeModel: string;              // model that judges the debate
    debateStyle: "adversarial" | "collaborative";
  };

  // Voting-specific
  voting?: {
    threshold: number;               // agreement threshold (default 0.5 = majority)
    mergeStrategy: "majority" | "union" | "intersection";
    tieBreaker: string;              // model slug to break ties
  };
}

// Extended PipelineStageConfig
export interface PipelineStageConfig {
  teamId: TeamId;
  modelSlug: string;                 // primary model (for single strategy)
  systemPromptOverride?: string;
  temperature?: number;
  maxTokens?: number;
  sandbox?: SandboxConfig;
  strategy?: StrategyConfig;         // NEW: multi-model execution strategy
}

// MoA types
export interface MoALayer {
  round: number;
  inputs: Array<{
    model: string;
    output: string;
    tokenCount: number;
  }>;
  aggregatedOutput?: string;
}

export interface MoARun {
  layers: MoALayer[];
  finalOutput: string;
  totalTokens: number;
  totalCost: number;
}

// Debate types
export interface DebateMessage {
  round: number;
  model: string;
  role: "proponent" | "opponent" | "judge";
  content: string;
  position: string;                  // what this model is arguing for
}

export interface DebateRun {
  topic: string;
  messages: DebateMessage[];
  judgment: {
    winner: string;                  // model slug
    reasoning: string;
    confidence: number;
  };
  finalOutput: string;
  totalTokens: number;
  totalCost: number;
}

// Voting types
export interface Vote {
  model: string;
  output: string;
  tokenCount: number;
}

export interface VotingRun {
  votes: Vote[];
  agreement: number;                 // 0-1, how much models agree
  mergedOutput: string;
  mergeStrategy: string;
  totalTokens: number;
  totalCost: number;
}

// Strategy execution result (attached to stage output)
export interface StrategyResult {
  strategy: ExecutionStrategy;
  models: string[];
  details: MoARun | DebateRun | VotingRun;
  finalOutput: string;
  metadata: {
    totalTokens: number;
    totalCost: number;
    duration: number;
    rounds: number;
  };
}
```

### Strategy Executor Service

```typescript
// server/strategies/executor.ts

class StrategyExecutor {
  constructor(
    private gateway: Gateway,
    private costTracker: CostTracker,
  ) {}

  async execute(
    input: string,
    systemPrompt: string,
    config: StrategyConfig,
    context: StageContext,
  ): Promise<StrategyResult>;

  private executeMoA(input: string, systemPrompt: string, config: StrategyConfig): Promise<MoARun>;
  private executeDebate(input: string, systemPrompt: string, config: StrategyConfig): Promise<DebateRun>;
  private executeVoting(input: string, systemPrompt: string, config: StrategyConfig): Promise<VotingRun>;
}
```

### Strategy 1: Mixture-of-Agents (MoA)

```
Round 1 (parallel):
  ├─ Claude: generates initial output
  ├─ Gemini: generates initial output
  └─ Grok: generates initial output

Round 2 (parallel, each sees all Round 1 outputs):
  ├─ Claude: refines with context from Gemini + Grok
  ├─ Gemini: refines with context from Claude + Grok
  └─ Grok: refines with context from Claude + Gemini

Aggregation:
  └─ Aggregator model synthesizes all Round 2 outputs into final
```

```typescript
// server/strategies/moa.ts
async function executeMoA(
  input: string,
  systemPrompt: string,
  config: StrategyConfig,
): Promise<MoARun> {
  const layers: MoALayer[] = [];

  // Round 1: parallel generation
  let previousOutputs: Array<{ model: string; output: string }> = [];
  const round1 = await Promise.all(
    config.models.map(model =>
      gateway.complete(model, [
        { role: "system", content: systemPrompt },
        { role: "user", content: input },
      ])
    )
  );
  previousOutputs = round1.map((out, i) => ({ model: config.models[i], output: out.content }));
  layers.push({ round: 1, inputs: previousOutputs.map(o => ({ ...o, tokenCount: 0 })) });

  // Round 2+: each model sees all previous outputs
  for (let round = 2; round <= (config.moa?.rounds ?? 2); round++) {
    const contextStr = previousOutputs
      .map(o => `[${o.model}]: ${o.output}`)
      .join("\n\n---\n\n");

    const roundOutputs = await Promise.all(
      config.models.map(model =>
        gateway.complete(model, [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Previous outputs from other models:\n\n${contextStr}\n\nOriginal input: ${input}\n\nRefine and improve upon the previous outputs.` },
        ])
      )
    );
    previousOutputs = roundOutputs.map((out, i) => ({ model: config.models[i], output: out.content }));
    layers.push({ round, inputs: previousOutputs.map(o => ({ ...o, tokenCount: 0 })) });
  }

  // Final aggregation
  const aggregatorModel = config.moa?.aggregatorModel ?? config.models[0];
  const finalOutput = await gateway.complete(aggregatorModel, [
    { role: "system", content: "You are a synthesis agent. Combine the following outputs into a single, high-quality result." },
    { role: "user", content: previousOutputs.map(o => `[${o.model}]: ${o.output}`).join("\n\n---\n\n") },
  ]);

  return { layers, finalOutput: finalOutput.content, totalTokens: 0, totalCost: 0 };
}
```

### Strategy 2: Multi-Agent Debate

```
Round 1:
  Proponent (Claude): "I propose microservices because..."
  Opponent (Gemini): "I counter with monolith-first because..."

Round 2:
  Proponent: "Addressing the monolith argument, microservices still win because..."
  Opponent: "However, the operational complexity means..."

Round 3:
  Proponent: final argument
  Opponent: final argument

Judgment:
  Judge (Grok): "Having evaluated both positions, the winner is...
                  because... The final recommendation is..."
```

```typescript
// server/strategies/debate.ts
async function executeDebate(
  input: string,
  systemPrompt: string,
  config: StrategyConfig,
): Promise<DebateRun> {
  const [proponentModel, opponentModel] = config.models;
  const judgeModel = config.debate?.judgeModel ?? config.models[2] ?? config.models[0];
  const messages: DebateMessage[] = [];

  let debateHistory = "";

  for (let round = 1; round <= (config.debate?.rounds ?? 3); round++) {
    // Proponent argues
    const proArg = await gateway.complete(proponentModel, [
      { role: "system", content: `${systemPrompt}\n\nYou are the PROPONENT in a technical debate. Argue FOR your position.` },
      { role: "user", content: `Topic: ${input}\n\nDebate history:\n${debateHistory}\n\nPresent your argument for Round ${round}.` },
    ]);
    messages.push({ round, model: proponentModel, role: "proponent", content: proArg.content, position: "for" });
    debateHistory += `\n[Round ${round} - Proponent (${proponentModel})]: ${proArg.content}\n`;

    // Opponent counters
    const oppArg = await gateway.complete(opponentModel, [
      { role: "system", content: `${systemPrompt}\n\nYou are the OPPONENT in a technical debate. Argue AGAINST the proponent's position.` },
      { role: "user", content: `Topic: ${input}\n\nDebate history:\n${debateHistory}\n\nPresent your counter-argument for Round ${round}.` },
    ]);
    messages.push({ round, model: opponentModel, role: "opponent", content: oppArg.content, position: "against" });
    debateHistory += `\n[Round ${round} - Opponent (${opponentModel})]: ${oppArg.content}\n`;
  }

  // Judge evaluates
  const judgment = await gateway.complete(judgeModel, [
    { role: "system", content: "You are an impartial technical judge. Evaluate the debate and declare a winner with detailed reasoning." },
    { role: "user", content: `Debate transcript:\n${debateHistory}\n\nJudge this debate. Who wins and why? Provide a final recommendation.` },
  ]);

  return {
    topic: input,
    messages,
    judgment: { winner: proponentModel, reasoning: judgment.content, confidence: 0.8 },
    finalOutput: judgment.content,
    totalTokens: 0,
    totalCost: 0,
  };
}
```

### Strategy 3: Majority Voting

```
All models generate independently (parallel):
  Claude: { recommendation: "PostgreSQL", reasons: [...] }
  Gemini: { recommendation: "PostgreSQL", reasons: [...] }
  Grok:   { recommendation: "MongoDB", reasons: [...] }

Merge (majority):
  PostgreSQL wins (2/3 votes)
  Final output = highest-rated PostgreSQL response
  Minority report: "Grok suggested MongoDB because..."
```

```typescript
// server/strategies/voting.ts
async function executeVoting(
  input: string,
  systemPrompt: string,
  config: StrategyConfig,
): Promise<VotingRun> {
  // All models generate in parallel
  const votes = await Promise.all(
    config.models.map(async (model) => {
      const result = await gateway.complete(model, [
        { role: "system", content: systemPrompt },
        { role: "user", content: input },
      ]);
      return { model, output: result.content, tokenCount: 0 };
    })
  );

  // Merge based on strategy
  const mergeStrategy = config.voting?.mergeStrategy ?? "majority";

  // For structured outputs (JSON), compare key decisions
  // For text outputs, use the tie-breaker model to select best
  const tieBreaker = config.voting?.tieBreaker ?? config.models[0];

  const mergeResult = await gateway.complete(tieBreaker, [
    { role: "system", content: "You are a merge agent. You have received outputs from multiple models. Select the best output or merge them according to the merge strategy." },
    { role: "user", content: `Merge strategy: ${mergeStrategy}\n\nOutputs:\n${votes.map(v => `[${v.model}]:\n${v.output}`).join("\n\n---\n\n")}\n\nProduce the final merged output.` },
  ]);

  return {
    votes,
    agreement: 0,     // calculated by comparing outputs
    mergedOutput: mergeResult.content,
    mergeStrategy,
    totalTokens: 0,
    totalCost: 0,
  };
}
```

### DB Schema Extension

```sql
-- Strategy execution results stored with stage execution
ALTER TABLE stage_executions ADD COLUMN strategy_result JSONB;
-- Contains: { strategy, models, details: MoARun|DebateRun|VotingRun, metadata }

-- Optional: individual model calls within a strategy
CREATE TABLE strategy_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_execution_id UUID REFERENCES stage_executions(id),
  model_slug TEXT NOT NULL,
  round INTEGER NOT NULL,
  role TEXT,                           -- "proponent", "opponent", "judge", "voter", "refiner"
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost REAL,
  duration INTEGER,                    -- ms
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Pipeline Stage Config Extension

```typescript
// In pipeline builder, each stage can optionally set:
{
  teamId: "architecture",
  modelSlug: "claude-sonnet",           // primary (used for "single" strategy)
  strategy: {
    strategy: "debate",
    models: ["claude-sonnet", "gemini-pro", "grok-3"],
    debate: {
      rounds: 3,
      judgeModel: "grok-3",
      debateStyle: "adversarial",
    },
  },
}
```

### API Endpoints

```
GET  /api/strategies/presets                 — list available strategy presets
GET  /api/runs/:id/stages/:stageId/strategy — get strategy execution details
POST /api/strategies/estimate                — estimate cost for a strategy config
                                              (models × rounds × avg tokens)
```

### Strategy Presets (UX)

```
┌── Strategy Presets ────────────────────────────────────────────┐
│                                                                 │
│  🎯 Single Model (default)                                      │
│  One model per stage. Fast, cheapest.                           │
│                                                                 │
│  🔄 Mixture-of-Agents (MoA)                                     │
│  Models refine each other's work. Best quality, 3-5x cost.     │
│  Recommended for: Planning, Testing                             │
│                                                                 │
│  ⚔️ Multi-Agent Debate                                          │
│  Models argue trade-offs, judge picks winner.                   │
│  Recommended for: Architecture, critical decisions              │
│                                                                 │
│  🗳️ Majority Voting                                             │
│  Models vote independently, consensus wins.                     │
│  Recommended for: Code Review, Development                      │
│                                                                 │
│  💰 Estimated cost multiplier:                                   │
│  Single: 1x │ MoA: 3-5x │ Debate: 3-4x │ Voting: 2-3x         │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### Frontend: Strategy Configuration UI

```
┌── Stage: Architecture ────────────────────────────────────────┐
│  Model: claude-sonnet ▾                                        │
│                                                                 │
│  ┌── Execution Strategy ──────────────────────────────────┐    │
│  │  ○ Single Model                                         │    │
│  │  ○ Mixture-of-Agents (MoA)                              │    │
│  │  ● Multi-Agent Debate                                   │    │
│  │  ○ Majority Voting                                      │    │
│  │                                                          │    │
│  │  ┌── Debate Config ─────────────────────────────────┐   │    │
│  │  │  Proponent: claude-sonnet ▾                       │   │    │
│  │  │  Opponent:  gemini-pro ▾                          │   │    │
│  │  │  Judge:     grok-3 ▾                              │   │    │
│  │  │  Rounds:    [3] ▾                                 │   │    │
│  │  │  Style:     ○ Adversarial  ● Collaborative        │   │    │
│  │  │  Est. cost: ~$0.45 per execution                  │   │    │
│  │  └──────────────────────────────────────────────────┘   │    │
│  └──────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────┘
```

### Frontend: Strategy Execution Viewer

```
┌── Stage: Architecture ── Strategy: Debate ────────────────────┐
│                                                                 │
│  ┌── Round 1 ──────────────────────────────────────────────┐   │
│  │  🟦 Proponent (Claude):                                  │   │
│  │  "I propose microservices architecture because the       │   │
│  │   system has 3 distinct bounded contexts..."             │   │
│  │                                                           │   │
│  │  🟥 Opponent (Gemini):                                   │   │
│  │  "While microservices offer scalability, for a team of   │   │
│  │   3 developers, a modular monolith would..."             │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌── Round 2 ──────────────────────────────────────────────┐   │
│  │  🟦 Proponent: "Addressing the team size concern..."     │   │
│  │  🟥 Opponent: "Even with containerization..."            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌── Judgment ─────────────────────────────────────────────┐   │
│  │  ⚖️ Judge (Grok):                                        │   │
│  │  "Winner: Modular Monolith (Gemini)                      │   │
│  │   Reasoning: Given the team size and initial scale..."   │   │
│  │  Confidence: 0.85                                        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  💰 Cost: $0.42 │ Tokens: 12,450 │ Duration: 34s               │
└────────────────────────────────────────────────────────────────┘
```

### WebSocket Events

```typescript
// Strategy-specific WS events:
"strategy:started"      → { stageId, strategy, models }
"strategy:round"        → { stageId, round, model, role, content }
"strategy:judgment"     → { stageId, winner, reasoning }
"strategy:vote"         → { stageId, model, output }
"strategy:completed"    → { stageId, finalOutput, metadata }
```

### Cross-Phase Synergies

| Phase | Synergy with Strategies |
|-------|------------------------|
| Phase 3.1 (Tools) | Each model in MoA/Debate can use different tools |
| Phase 3.2 (Stats) | Cost tracking per strategy call, strategy cost comparison |
| Phase 3.3 (Memory) | Memory helps models in later rounds (avoids re-debate settled topics) |
| Phase 3.5 (Sandbox) | Voting: run each model's code in sandbox, pick one that passes tests |
| Phase 4.5 (Maintenance) | Use debate to evaluate whether a dependency update is worth it |

### Implementation Order

1. Types: `StrategyConfig`, `StrategyResult`, `MoARun`, `DebateRun`, `VotingRun`
2. `StrategyExecutor` service with strategy dispatch
3. MoA implementation (most straightforward — parallel + refine)
4. Voting implementation (parallel + merge)
5. Debate implementation (sequential rounds + judgment)
6. Pipeline Controller integration: use `StrategyExecutor` when `stage.strategy` is set
7. DB schema: `strategy_result` column, `strategy_calls` table
8. API endpoints
9. Frontend: strategy config in pipeline builder
10. Frontend: strategy execution viewer in run detail
11. Cost estimation for strategies
12. Strategy presets

### Open Design Questions (Phase 3.6)

| # | Question | Options |
|---|----------|---------|
| 25 | **Semantic cache scope** | A) Per-pipeline cache B) Global cache across pipelines C) Both with toggle |

---

## Phase 4 — Code Workspace (Claude Code-like experience)

> Scoped to **multi-model parallel code review** — not a full IDE. Users can connect a workspace (local path or remote repo) and run multiple models to review code simultaneously with different perspectives.

### 4.1 — Workspace & Repository Management

```typescript
// shared/types.ts
export interface Workspace {
  id: string;
  name: string;
  type: "local" | "remote";
  path: string;                     // local path or git URL
  branch: string;
  status: "active" | "syncing" | "error";
  lastSyncAt: Date | null;
  createdAt: Date;
}

// server/workspace/manager.ts
class WorkspaceManager {
  // Connect local directory
  async connectLocal(path: string, name?: string): Promise<Workspace>;

  // Clone remote repository
  async cloneRemote(url: string, branch?: string): Promise<Workspace>;

  // Sync remote workspace (git pull)
  async sync(workspaceId: string): Promise<void>;

  // List files in workspace
  async listFiles(workspaceId: string, path?: string): Promise<FileEntry[]>;

  // Read file content
  async readFile(workspaceId: string, filePath: string): Promise<string>;

  // Write file (for AI-generated changes)
  async writeFile(workspaceId: string, filePath: string, content: string): Promise<void>;

  // Git operations
  async gitStatus(workspaceId: string): Promise<GitStatus>;
  async gitDiff(workspaceId: string): Promise<string>;
  async gitCommit(workspaceId: string, message: string): Promise<void>;
  async gitBranch(workspaceId: string, branchName: string): Promise<void>;
}
```

### 4.2 — API Endpoints

```
-- Workspace management
POST   /api/workspaces                          — connect workspace (local or remote)
GET    /api/workspaces                          — list workspaces
GET    /api/workspaces/:id                      — workspace details
DELETE /api/workspaces/:id                      — disconnect workspace
POST   /api/workspaces/:id/sync                 — sync remote workspace

-- File operations
GET    /api/workspaces/:id/files                — list files (tree)
GET    /api/workspaces/:id/files/*path          — read file content
PUT    /api/workspaces/:id/files/*path          — write file
DELETE /api/workspaces/:id/files/*path          — delete file

-- Git operations
GET    /api/workspaces/:id/git/status           — git status
GET    /api/workspaces/:id/git/diff             — git diff
POST   /api/workspaces/:id/git/commit           — commit changes
POST   /api/workspaces/:id/git/branch           — create branch
GET    /api/workspaces/:id/git/log              — commit history

-- AI operations
POST   /api/workspaces/:id/review               — multi-model code review
POST   /api/workspaces/:id/chat                 — chat about workspace code
```

### 4.3 — Frontend: Code Editor Page

```
┌── Workspace: my-project ── branch: main ──────────────────────┐
│                                                                 │
│  ┌── File Tree ──┐  ┌── Editor ────────────────────────────┐   │
│  │ 📁 src/        │  │  // auth.controller.ts                │   │
│  │  📄 app.ts     │  │  import { Router } from "express";    │   │
│  │  📄 auth.ts ◄──┤  │  import { validateToken } from...     │   │
│  │  📄 users.ts   │  │  ...                                  │   │
│  │ 📁 tests/      │  │                                       │   │
│  │ 📄 package.json│  │  ┌── Inline AI suggestion ──────┐     │   │
│  │                │  │  │ 💡 Add rate limiting here      │     │   │
│  │                │  │  │ [Apply] [Dismiss] [Explain]   │     │   │
│  │                │  │  └──────────────────────────────┘     │   │
│  └────────────────┘  └──────────────────────────────────────┘   │
│                                                                 │
│  ┌── AI Chat ──────────────────────────────────────────────┐   │
│  │  You: "Review this auth module for security issues"      │   │
│  │                                                           │   │
│  │  🟦 Claude: "Found 2 issues: 1) No rate limiting on      │   │
│  │  login endpoint. 2) JWT secret from env without..."       │   │
│  │                                                           │   │
│  │  🟩 Gemini: "The token validation looks correct but      │   │
│  │  I'd recommend adding refresh token rotation..."          │   │
│  │                                                           │   │
│  │  🟧 Grok: "Checked against OWASP: missing CSRF          │   │
│  │  protection on auth endpoints. Also, express-rate-limit   │   │
│  │  v7 just released with improved Redis support."           │   │
│  │                                                           │   │
│  │  [Send message...                              ] [Send]   │   │
│  └──────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

### 4.4 — AI-Assisted Code Interaction (Chat + Code integration)

```typescript
// server/workspace/code-chat.ts

class CodeChatService {
  // Multi-model code review: run N models in parallel on selected files
  async reviewCode(
    workspaceId: string,
    filePaths: string[],
    models: string[],
    prompt?: string,
  ): Promise<Map<string, ReviewResult>>;

  // Chat about code with workspace context
  async chat(
    workspaceId: string,
    message: string,
    modelSlug: string,
    context?: { filePaths?: string[]; selection?: CodeSelection },
  ): Promise<ChatResponse>;

  // Apply AI-suggested code change
  async applyChange(
    workspaceId: string,
    filePath: string,
    change: CodeChange,
  ): Promise<void>;
}

interface ReviewResult {
  model: string;
  issues: Array<{
    severity: "error" | "warning" | "info";
    file: string;
    line?: number;
    message: string;
    suggestion?: string;
  }>;
  summary: string;
}
```

### 4.5 — Security & Sandboxing

- Workspace file access is scoped to the workspace root (no path traversal)
- Git operations use `simple-git` library (no shell exec)
- Remote clones go to `data/workspaces/{id}/` with size limits
- AI-generated file writes require user confirmation in UI
- Terminal access (if added later) must be Docker-sandboxed

---

## Phase 4.5 — Continuous Maintenance Autopilot

> Goal: the platform proactively initiates work when it detects that a project is outdated, vulnerable, or non-compliant with standards. Two-tier system: **Cron Scout Agent** (lightweight — scans and scores) → **Full SDLC Pipeline** (heavyweight — when Scout finds something important).

### Design Decisions (Resolved)

| # | Question | Decision |
|---|--------|---------|
| M1 | **What to monitor** | Full list (see categories below) + compliance-driven categories from SOC 2, PCI DSS, ISO 27001 |
| M2 | **Autonomy level** | **B) Proposes PR** by default. Direct intervention (auto-merge) is possible but must be explicitly enabled via toggle in UI |
| M3 | **Scope binding** | Enabled **per-workspace/project** + globally. Global = platform monitors all connected projects |
| M4 | **Trigger** | **C) Both** — cron for scheduled checks + events for urgent cases (CVE) |
| M5 | **Who executes** | **Two-tier**: Cron Scout Agent (lightweight scan) → if it finds something important → Full SDLC Pipeline for assessment + implementation |
| M6 | **Unique value** | Multi-model analysis: Claude (breaking changes), Gemini (code), Grok (web verification) |
| M7 | **Scout intelligence** | **A) Pure code** — Scout is a data collector only (npm audit, license-checker, etc.). No LLM. Heavy analysis delegated to SDLC pipeline |
| M8 | **Finding dedup** | **B) Re-evaluate** — every scan re-evaluates all findings (CVE severity can change). User selects which findings to action |
| M9 | **PR strategy** | **A) One PR per finding** — each problem/task gets its own PR for clean rollback and independent review |
| M10 | **Notification** | **Scout shows results in UI** — user manually selects important findings → SDLC / backlog. No auto-notifications for now (TBD after testing) |
| M11 | **History & trends** | **C) Trends + recommendations** — scan history, health score trends, mean-time-to-remediate, platform recommends policy changes |

### 4.5.1 — Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    CRON SCHEDULER                            │
│  (configurable: hourly / daily / weekly per workspace)       │
└──────────────────────┬──────────────────────────────────────┘
                       │ trigger
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                 SCOUT AGENT (lightweight)                     │
│                                                               │
│  1. Read workspace config (what to monitor, severity filter)  │
│  2. Run check categories (parallel):                          │
│     ├─ dependency_updates    ← npm audit, pip-audit, etc.    │
│     ├─ security_advisories   ← GitHub Advisory DB, NVD       │
│     ├─ breaking_changes      ← major version releases        │
│     ├─ license_compliance    ← SPDX check                   │
│     ├─ api_deprecations      ← changelog parsing            │
│     ├─ config_drift          ← CIS benchmarks, hardening    │
│     ├─ best_practices        ← linter rules, framework recs │
│     ├─ documentation_currency← stale docs, outdated README  │
│     ├─ access_control        ← unused tokens, expired certs │
│     └─ data_retention        ← old logs, expired data       │
│  3. Score each finding: severity × relevance × effort        │
│  4. Filter by workspace threshold (e.g. only "high"+)        │
│  5. If nothing important → log scan result → DONE            │
│     If important findings → create MaintenanceTask           │
└──────────────────────┬──────────────────────────────────────┘
                       │ MaintenanceTask[]
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              MAINTENANCE PIPELINE (full SDLC)                │
│                                                               │
│  Planning: Claude analyzes breaking changes, writes          │
│            migration plan, estimates effort                   │
│                                                               │
│  Architecture: does the architecture need to change?          │
│                (e.g. new SDK requires async patterns)         │
│                                                               │
│  Development: Gemini generates updated code                  │
│               (bump versions, adapt to new APIs)              │
│                                                               │
│  Testing: runs existing tests + new ones                     │
│           in Docker sandbox                                    │
│                                                               │
│  Code Review: Claude verifies the update                     │
│               didn't break anything                           │
│                                                               │
│  Grok Fact-Check: verifies via web that the new              │
│                   version is stable, no known issues          │
│                                                               │
│  → Creates PR with description: what was updated, why,      │
│    which tests passed, risk assessment                        │
└─────────────────────────────────────────────────────────────┘
```

### 4.5.2 — Monitoring Categories (Compliance-Enriched)

Categories are derived from best practices in **SOC 2**, **PCI DSS**, **ISO 27001**, **HIPAA**, **NIST CSF**, **CIS Controls**, **GDPR**, and **FedRAMP**.

| Category | What Scout Checks | Compliance Source | Default Severity |
|----------|------------------|-------------------|-----------------|
| **Dependency Updates** | Outdated packages (minor/patch) | SOC 2 CC8.1, PCI DSS 6.2, CIS 7 | medium |
| **Breaking Changes** | Major version releases of key deps | SOC 2 CC8.1, ISO 27001 A.8.32 | high |
| **Security Advisories (CVE)** | Known vulns in deps (npm audit, Trivy) | PCI DSS 6.2/11.2, NIST SI-2, HIPAA §164.308 | critical |
| **License Compliance** | License changes, GPL contamination, SPDX violations | SOC 2 CC5, ISO 27001 A.5.22 | high |
| **API Deprecations** | Deprecated endpoints, SDK version sunset notices | ISO 27001 A.8.9, NIST CM-3 | medium |
| **Configuration Drift** | Divergence from CIS benchmarks, hardening baselines | FedRAMP CM-6, NIST CM-2, PCI DSS 2.2.4 | high |
| **Best Practices Drift** | Outdated patterns, new framework recommendations | ISO 27001 A.8.6 | low |
| **Documentation Currency** | Stale README, outdated API docs, missing CHANGELOG | SOC 2 CC2, ISO 27001 A.8.33 | low |
| **Access Control Review** | Expired tokens, unused API keys, stale credentials | PCI DSS 7.x/8.x, ISO 27001 A.8.2, SOC 2 CC6 | high |
| **Data Retention** | Old logs beyond retention policy, expired data | GDPR Art.5/17, HIPAA §164.306, SOC 2 | medium |
| **Certificate Expiry** | TLS/SSL certs approaching expiry | PCI DSS 4.1, NIST SC-12 | critical |
| **Infrastructure Drift** | Terraform state vs actual (if workspace has IaC) | FedRAMP CM-3, NIST CM-3 | high |
| **Vendor/Third-Party** | Upstream provider status, service deprecations | PCI DSS 12.8, ISO 27001 A.5.22, SOC 2 CC5 | medium |
| **System Hardening** | DISA STIG / CIS benchmark compliance checks | FedRAMP CM-6, CIS Controls 2, NIST CM-7 | medium |

### 4.5.3 — Types

```typescript
// shared/types.ts

export type MaintenanceCategory =
  | "dependency_update" | "breaking_change" | "security_advisory"
  | "license_compliance" | "api_deprecation" | "config_drift"
  | "best_practices" | "documentation" | "access_control"
  | "data_retention" | "cert_expiry" | "infra_drift"
  | "vendor_status" | "system_hardening";

export type MaintenanceSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface MaintenancePolicy {
  id: string;
  workspaceId: string | null;            // null = global policy
  enabled: boolean;
  schedule: string;                       // cron expression: "0 9 * * 1" = Mon 9am
  categories: MaintenanceCategoryConfig[];
  severityThreshold: MaintenanceSeverity; // only trigger SDLC for findings ≥ this
  autoMerge: boolean;                     // if true, auto-merge PRs for patch-level updates
  notifyChannels: string[];               // webhook URLs for notifications
  createdAt: Date;
  updatedAt: Date;
}

export interface MaintenanceCategoryConfig {
  category: MaintenanceCategory;
  enabled: boolean;
  severity: MaintenanceSeverity;          // override default severity
  customRules?: Record<string, unknown>;  // category-specific config
}

export interface ScoutFinding {
  id: string;
  scanId: string;
  category: MaintenanceCategory;
  severity: MaintenanceSeverity;
  title: string;                          // "express 4.18.2 → 5.0.0 (breaking)"
  description: string;                    // detailed description
  currentValue: string;                   // "express@4.18.2"
  recommendedValue: string;               // "express@5.0.0"
  effort: "trivial" | "small" | "medium" | "large"; // estimated effort
  references: string[];                   // URLs to changelogs, CVEs, docs
  autoFixable: boolean;                   // can be fixed without human review
  complianceRefs: string[];               // ["PCI DSS 6.2", "SOC 2 CC8.1"]
}

export interface MaintenanceScan {
  id: string;
  policyId: string;
  workspaceId: string;
  status: "running" | "completed" | "failed";
  findings: ScoutFinding[];
  importantCount: number;                 // findings ≥ severityThreshold
  triggeredPipelineId: string | null;     // if SDLC was triggered
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
}
```

### 4.5.4 — Scout Agent (`server/maintenance/scout.ts`)

```typescript
class ScoutAgent {
  // Run all enabled category checks for a workspace
  async scan(workspace: Workspace, policy: MaintenancePolicy): Promise<MaintenanceScan>;

  // Individual category scanners
  private scanDependencies(workspace: Workspace): Promise<ScoutFinding[]>;
  private scanSecurityAdvisories(workspace: Workspace): Promise<ScoutFinding[]>;
  private scanLicenses(workspace: Workspace): Promise<ScoutFinding[]>;
  private scanApiDeprecations(workspace: Workspace): Promise<ScoutFinding[]>;
  private scanConfigDrift(workspace: Workspace): Promise<ScoutFinding[]>;
  private scanCertificates(workspace: Workspace): Promise<ScoutFinding[]>;
  private scanAccessControl(workspace: Workspace): Promise<ScoutFinding[]>;
  private scanDocumentation(workspace: Workspace): Promise<ScoutFinding[]>;
  private scanDataRetention(workspace: Workspace): Promise<ScoutFinding[]>;
  private scanInfraDrift(workspace: Workspace): Promise<ScoutFinding[]>;
}
```

**Scanner implementations**:

| Scanner | Tool | How it works |
|---------|-----------|-------------|
| `scanDependencies` | `npm outdated`, `pip list --outdated`, package.json parse | Compares current vs latest, identifies breaking (semver major) |
| `scanSecurityAdvisories` | `npm audit --json`, GitHub Advisory API, NVD API | Finds CVEs for installed packages, CVSS scoring |
| `scanLicenses` | `license-checker`, SPDX database | Checks license compatibility, GPL contamination |
| `scanApiDeprecations` | Web search (Grok), changelog parsing | Finds deprecation notices in upstream APIs |
| `scanConfigDrift` | Docker sandbox + CIS benchmark tools | Runs `kube-bench`, `cfn-nag`, terraform validate |
| `scanCertificates` | OpenSSL check, API endpoints scan | Checks TLS certificate expiry dates |
| `scanAccessControl` | Git secrets scan, env file audit | Finds expired tokens, unused credentials |
| `scanDocumentation` | File age analysis, README parse | Identifies stale docs by git blame dates |
| `scanDataRetention` | Log size analysis, DB query | Finds data/logs older than retention policy |
| `scanInfraDrift` | `terraform plan` in sandbox | Compares state with actual infrastructure |

### 4.5.5 — Cron Scheduler (`server/maintenance/scheduler.ts`)

```typescript
class MaintenanceScheduler {
  private jobs: Map<string, CronJob> = new Map();

  // Start scheduler for all active policies
  async start(): Promise<void>;

  // Register/update a policy's cron job
  registerPolicy(policy: MaintenancePolicy): void;

  // Unregister when policy disabled/deleted
  unregisterPolicy(policyId: string): void;

  // Execute a scan (called by cron or manually)
  async executeScan(policyId: string): Promise<MaintenanceScan>;

  // Decision: should we trigger full SDLC?
  private shouldTriggerPipeline(scan: MaintenanceScan, policy: MaintenancePolicy): boolean;

  // Create and start maintenance SDLC pipeline
  private async triggerMaintenancePipeline(
    scan: MaintenanceScan,
    findings: ScoutFinding[],
  ): Promise<PipelineRun>;
}
```

**Cron → Scout → Pipeline flow:**

```
1. Cron fires → executeScan(policyId)
2. Load policy + workspace config
3. ScoutAgent.scan(workspace, policy) → findings[]
4. Filter findings by severity ≥ policy.severityThreshold
5. If importantCount === 0 → log "all clear" → DONE
6. If importantCount > 0:
   a. Group findings by category
   b. Create MaintenanceTask with grouped findings
   c. Create special "Maintenance Pipeline" run
   d. Pipeline input = { findings, workspace, policy }
   e. SDLC stages analyze, plan, implement, test, review
   f. Pipeline creates PR (or auto-merges if policy.autoMerge && finding.autoFixable)
7. Send notifications to policy.notifyChannels
```

### 4.5.6 — Auto-Merge Control

```
Auto-merge toggle (off by default):
  ┌─ Workspace Settings → Maintenance → Auto-merge ─┐
  │                                                    │
  │  [OFF] Automatic update application                │
  │                                                    │
  │  If enabled:                                       │
  │  ☑ Patch updates only (1.2.3 → 1.2.4)             │
  │  ☐ Minor updates (1.2.3 → 1.3.0)                  │
  │  ☐ Major updates (1.x → 2.x) — NEVER auto-merge   │
  │                                                    │
  │  Conditions for auto-merge:                        │
  │  ☑ All tests passed in sandbox                     │
  │  ☑ No security findings severity ≥ high            │
  │  ☑ Code review score ≥ 0.8                         │
  │                                                    │
  │  ⚠️ Major breaking changes always require           │
  │     manual confirmation                            │
  └────────────────────────────────────────────────────┘
```

### 4.5.7 — DB Schema

```sql
CREATE TABLE maintenance_policies (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID REFERENCES workspaces(id),    -- null = global
  enabled             BOOLEAN NOT NULL DEFAULT true,
  schedule            TEXT NOT NULL,                      -- cron expression
  categories          JSONB NOT NULL DEFAULT '[]',       -- MaintenanceCategoryConfig[]
  severity_threshold  TEXT NOT NULL DEFAULT 'high',
  auto_merge          BOOLEAN NOT NULL DEFAULT false,
  notify_channels     JSONB DEFAULT '[]',
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE maintenance_scans (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id             UUID REFERENCES maintenance_policies(id),
  workspace_id          UUID REFERENCES workspaces(id),
  status                TEXT NOT NULL DEFAULT 'running',
  findings              JSONB NOT NULL DEFAULT '[]',
  important_count       INTEGER NOT NULL DEFAULT 0,
  triggered_pipeline_id UUID REFERENCES pipeline_runs(id),
  started_at            TIMESTAMPTZ DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_scans_policy ON maintenance_scans(policy_id, created_at);
CREATE INDEX idx_scans_workspace ON maintenance_scans(workspace_id, created_at);
```

### 4.5.8 — API Endpoints

```
-- Policies
GET    /api/maintenance/policies                    — list all policies
POST   /api/maintenance/policies                    — create policy
PUT    /api/maintenance/policies/:id                — update policy
DELETE /api/maintenance/policies/:id                — delete policy

-- Scans
GET    /api/maintenance/scans                       — list scans (filterable by workspace, policy)
GET    /api/maintenance/scans/:id                   — scan details + findings
POST   /api/maintenance/scans/trigger               — trigger manual scan { policyId }
GET    /api/maintenance/scans/:id/findings          — findings with filters

-- Finding Actions
POST   /api/maintenance/findings/:id/action         — { action: "sdlc" | "backlog" | "dismiss" }

-- Dashboard
GET    /api/maintenance/dashboard                   — overview: active policies, recent scans, open findings
GET    /api/maintenance/health/:workspaceId         — health score per workspace
GET    /api/maintenance/trends/:workspaceId         — health score + findings trends over time
GET    /api/maintenance/recommendations/:workspaceId — smart recommendations
```

### 4.5.9 — Frontend

- [ ] **Maintenance Settings** (per-workspace + global):
  - Enable/disable maintenance autopilot
  - Cron schedule picker (visual: "Every Monday at 9am")
  - Category toggles with severity overrides
  - Severity threshold selector
  - Auto-merge toggle with conditions (patch only, tests pass, etc.)
  - Notification channels (webhook URLs)

- [ ] **Maintenance Dashboard** (`/maintenance`):
  ```
  ┌─────────────────────────────────────────────────────────────┐
  │  Maintenance Autopilot                                       │
  ├─────────────────────────────────────────────────────────────┤
  │  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐   │
  │  │ Projects  │ │ Open      │ │ Last Scan │ │ Health    │   │
  │  │ Monitored │ │ Findings  │ │ 2h ago    │ │ Score     │   │
  │  │ 5         │ │ 12        │ │ ✅ clean   │ │ 87/100    │   │
  │  └───────────┘ └───────────┘ └───────────┘ └───────────┘   │
  │                                                               │
  │  ┌── Recent Scans ──────────────────────────────────────────┐│
  │  │ Workspace │ Time │ Findings │ Critical │ SDLC triggered? ││
  │  │ frontend  │ 2h   │ 3        │ 0        │ No              ││
  │  │ backend   │ 2h   │ 8        │ 2 🔴     │ Yes → PR #47    ││
  │  └─────────────────────────────────────────────────────────┘│
  │                                                               │
  │  ┌── Findings by Category (stacked bar) ────────────────────┐│
  │  │  dependency | security | license | config | ...           ││
  │  └─────────────────────────────────────────────────────────┘│
  │                                                               │
  │  ┌── Compliance Coverage ───────────────────────────────────┐│
  │  │  SOC 2: 85% │ PCI DSS: 72% │ ISO 27001: 90%             ││
  │  │  (based on enabled categories vs framework requirements)  ││
  │  └─────────────────────────────────────────────────────────┘│
  └─────────────────────────────────────────────────────────────┘
  ```

- [ ] **Scan Detail View** — findings list with severity badges, references, action buttons per finding:
  ```
  ┌── Scan #42 — backend — 2026-03-14 09:00 ────────────────────┐
  │                                                                │
  │  8 findings (2 critical, 3 high, 2 medium, 1 low)            │
  │                                                                │
  │  ☐ 🔴 CRITICAL: CVE-2026-1234 in lodash@4.17.21              │
  │    CVSS 9.8 | PCI DSS 6.2 | Auto-fixable: yes                │
  │    [Send to SDLC] [Add to Backlog] [Dismiss]                  │
  │                                                                │
  │  ☐ 🔴 CRITICAL: TLS cert expires in 7 days                    │
  │    PCI DSS 4.1, NIST SC-12 | Effort: trivial                  │
  │    [Send to SDLC] [Add to Backlog] [Dismiss]                  │
  │                                                                │
  │  ☐ 🟠 HIGH: express 4.18 → 5.0 (breaking change)             │
  │    SOC 2 CC8.1 | Effort: large | 14 breaking changes          │
  │    [Send to SDLC] [Add to Backlog] [Dismiss]                  │
  │                                                                │
  │  ... more findings ...                                         │
  │                                                                │
  │  [Select All Critical] [Send Selected to SDLC] [Bulk Dismiss] │
  └────────────────────────────────────────────────────────────────┘
  ```

- [ ] **Workspace Health Badge** — show health score in workspace list

### 4.5.10 — Multi-Model Advantage

Why multiqlti is better than Dependabot/Renovate for maintenance:

| Aspect | Dependabot/Renovate | multiqlti Maintenance |
|--------|--------------------|-----------------------|
| **Scope** | Dependencies only | 14 categories including compliance |
| **Analysis** | Bump version + run tests | Claude analyzes breaking changes, writes migration plan |
| **Code generation** | Template-based bumps | Gemini generates adapted code for new APIs |
| **Verification** | CI tests only | Grok web-checks if new version is stable + has known issues |
| **Compliance** | None | Maps findings to SOC 2, PCI DSS, ISO 27001 controls |
| **Context** | Per-package | Full project memory — knows architecture, decisions, preferences |
| **Custom checks** | Limited | Any check category, custom rules, MCP tool integration |

### 4.5.11 — Trend Analysis & Recommendations (`server/maintenance/analytics.ts`)

```typescript
class MaintenanceAnalytics {
  // Health score: 0–100 based on open findings, compliance coverage, time-to-fix
  async calculateHealthScore(workspaceId: string): Promise<HealthScore>;

  // Trends over time: findings count, severity distribution, health score
  async getTrends(workspaceId: string, period: "7d" | "30d" | "90d"): Promise<TrendData>;

  // Mean time to remediate (from finding created → PR merged)
  async getMTTR(workspaceId: string): Promise<{ overall: number; byCategory: Record<string, number> }>;

  // Smart recommendations based on scan history
  async getRecommendations(workspaceId: string): Promise<Recommendation[]>;
}

interface HealthScore {
  score: number;               // 0–100
  breakdown: {
    openFindings: number;       // -points per open finding (weighted by severity)
    complianceCoverage: number; // % of enabled compliance categories
    meanTimeToFix: number;      // lower = better
    scanFrequency: number;      // regular scanning = bonus
  };
  trend: "improving" | "stable" | "declining";
}

interface TrendData {
  points: Array<{
    date: string;
    healthScore: number;
    findingsCount: number;
    criticalCount: number;
    resolvedCount: number;
  }>;
  period: string;
}

interface Recommendation {
  type: "increase_frequency" | "enable_category" | "review_stale" | "upgrade_threshold";
  message: string;             // "Security findings increased 40% — consider weekly scans instead of monthly"
  priority: "high" | "medium" | "low";
  actionable: boolean;         // can be applied with one click
  suggestedChange?: Partial<MaintenancePolicy>;
}
```

**Recommendation rules** (pure code, no LLM):

| Condition | Recommendation |
|-----------|---------------|
| Security findings trending up (>20% over 30d) | "Enable weekly scans" / "Lower severity threshold" |
| Category disabled but workspace has relevant files | "Enable `license_compliance` — workspace has 47 npm deps" |
| MTTR > 14 days for critical findings | "Critical findings take too long to fix — consider auto-merge for patch-level" |
| Health score declining 3+ consecutive scans | "Health declining — review open findings and consider enabling more categories" |
| Same finding open > 30 days with no action | "Stale finding: express@4.18 outdated — dismiss or action" |

**Frontend: Trends Dashboard** (addition to 4.5.9):

```
┌── Health Score Trend (line chart) ──────────────────────────┐
│  100 ┤                                                       │
│   90 ┤──────╮       ╭──────────────────────────              │
│   80 ┤      ╰───────╯                                       │
│   70 ┤                                                       │
│      └─── Jan ──── Feb ──── Mar ──── Apr ────                │
└──────────────────────────────────────────────────────────────┘

┌── Findings by Severity (stacked area) ─────────────────────┐
│  Critical 🔴  High 🟠  Medium 🟡  Low 🟢                    │
└──────────────────────────────────────────────────────────────┘

┌── MTTR by Category (bar chart) ────────────────────────────┐
│  security_advisory   ████ 3d                                │
│  dependency_update   ██████████ 8d                          │
│  license_compliance  ████████████████ 14d                   │
└──────────────────────────────────────────────────────────────┘

┌── Recommendations ─────────────────────────────────────────┐
│  🔴 HIGH: Security findings +40% — enable weekly scans      │
│     [Apply] [Dismiss]                                       │
│  🟡 MED: 3 stale findings > 30 days — review or dismiss     │
│     [View Findings] [Dismiss All]                           │
│  🟢 LOW: license_compliance not enabled — 47 npm deps found │
│     [Enable] [Dismiss]                                      │
└──────────────────────────────────────────────────────────────┘
```

### 4.5.12 — Implementation Order

1. Types: `MaintenancePolicy`, `ScoutFinding`, `MaintenanceScan`, `HealthScore`, `Recommendation`
2. DB schema: `maintenance_policies`, `maintenance_scans`
3. ScoutAgent — core scanner framework + 3 initial scanners:
   - `scanDependencies` (npm/pip)
   - `scanSecurityAdvisories` (npm audit + GitHub Advisory)
   - `scanLicenses` (license-checker)
4. Cron Scheduler — register policies, trigger scans
5. **Scan Results UI** — findings list with severity badges, "Send to SDLC" / "Add to Backlog" / "Dismiss" per finding
6. Maintenance Pipeline template — special SDLC pipeline with one-finding-per-PR strategy
7. API endpoints (policies, scans, finding actions)
8. Frontend: Maintenance settings per workspace
9. Frontend: Maintenance dashboard
10. Additional scanners: config drift, cert expiry, API deprecation
11. Auto-merge logic with conditions (UI toggle, off by default)
12. **MaintenanceAnalytics** — health score, MTTR, trends calculation
13. **Recommendations engine** — pure-code rules analyzing scan history
14. Frontend: Trends dashboard (health chart, MTTR bars, recommendations cards)
15. Compliance coverage calculation
16. Notifications (webhooks — deferred, TBD after testing)

### 4.5.13 — Dependencies

| Depends On | Why |
|-----------|-----|
| Phase 4 (Workspace) | Scout needs file access to scan deps, configs, etc. |
| Phase 3.1 (Tools) | Grok web search for stability verification |
| Phase 3.3 (Memory) | Memory stores what was previously scanned and decided |
| Phase 3.5 (Sandbox) | Run tests, CIS benchmarks in Docker |
| Phase 3.2 (Stats) | Cost tracking for maintenance pipeline runs |

### 4.5.14 — Packages

```bash
npm install node-cron                     # cron scheduler
npm install license-checker-webpack-plugin # or license-checker for SPDX
# npm audit is built-in
# GitHub Advisory API via @octokit/rest
```

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

---

## Phase 6 — Competitive Parity Features (from CrewAI / Lindy.ai / OpenClaw analysis)

> Features inspired by competitive analysis of DeerFlow, Paperclip, CrewAI, and Lindy.ai — adapted for multiqlti's multi-model architecture.

### 6.1 — Guardrails & Structured Output Validation

```typescript
// Validate LLM outputs before passing to next stage
export interface StageGuardrail {
  id: string;
  stageId: TeamId;
  type: "json_schema" | "regex" | "custom" | "llm_check";
  config: {
    schema?: object;              // JSON Schema for json_schema type
    pattern?: string;             // regex pattern
    validatorFn?: string;         // custom JS function (sandboxed)
    llmPrompt?: string;           // prompt for LLM-based validation
    llmModel?: string;            // which model validates (default: cheap/fast)
  };
  onFail: "retry" | "skip" | "fail" | "fallback";
  maxRetries: number;             // for "retry" action
  fallbackValue?: unknown;        // for "fallback" action
}

// Integration into pipeline controller:
// After team.execute() → validate output against guardrails
// If validation fails → apply onFail policy
```

**Use cases:**
- Architecture stage must return valid JSON with `techStack`, `components` fields
- Code Review must include `securityIssues` array (even if empty)
- Testing must include `coverage` percentage
- Custom regex: deployment output must contain "terraform plan" keyword

**Frontend:**
```
┌── Stage: Architecture ── Guardrails ─────────────────────────┐
│  ┌── Guardrail 1 ──────────────────────────────────────────┐ │
│  │  Type: JSON Schema                                        │ │
│  │  Schema: { required: ["techStack", "components"] }       │ │
│  │  On fail: Retry (max 2)                                   │ │
│  └──────────────────────────────────────────────────────────┘ │
│  [+ Add Guardrail]                                             │
└────────────────────────────────────────────────────────────────┘
```

### 6.2 — Conditional Branching & Pipeline DAG

```typescript
// Allow stages to branch based on conditions
export interface PipelineDAG {
  stages: DAGStage[];
  edges: DAGEdge[];
}

export interface DAGStage {
  id: string;
  teamId: TeamId;
  modelSlug: string;
  position: { x: number; y: number }; // for visual DAG editor
}

export interface DAGEdge {
  from: string;                        // stage id
  to: string;                          // stage id
  condition?: {
    field: string;                     // output field to check
    operator: "eq" | "neq" | "gt" | "lt" | "contains" | "exists";
    value: unknown;
  };
}
```

**Visual DAG editor:**
```
  [Planning] ─────► [Architecture] ───► [Development]
                          │                    │
                          │ if techStack       │
                          │ === "microservices" │
                          ▼                    ▼
                   [K8s Config]         [Testing]
                          │                    │
                          └────────┬───────────┘
                                   ▼
                            [Code Review]
                                   │
                                   ▼
                            [Deployment]
```

### 6.3 — Event-Driven Triggers

```typescript
// Trigger pipelines from external events
export interface PipelineTrigger {
  id: string;
  pipelineId: string;
  type: "webhook" | "schedule" | "github_event" | "file_change";
  config: {
    // webhook
    secret?: string;
    endpoint?: string;               // auto-generated: /api/triggers/{id}

    // schedule
    cron?: string;

    // github_event
    repository?: string;
    events?: string[];               // "push", "pull_request", "issue"

    // file_change
    watchPath?: string;
    patterns?: string[];             // glob patterns
  };
  enabled: boolean;
  lastTriggeredAt: Date | null;
}
```

### 6.4 — Agent Delegation (Inter-Stage Communication)

```typescript
// Allow one stage to delegate subtasks to other stages mid-execution
export interface DelegationRequest {
  fromStage: TeamId;
  toStage: TeamId;
  task: string;
  context: Record<string, unknown>;
  priority: "blocking" | "async";    // blocking = wait for result, async = fire-and-forget
  timeout: number;
}

// Example: Architecture stage delegates to Development stage:
// "Generate a proof-of-concept for this API design"
// Development generates code → returns to Architecture → Architecture continues
```

### 6.5 — Tracing & Observability

```typescript
// OpenTelemetry-compatible tracing for pipeline runs
export interface PipelineTrace {
  traceId: string;
  runId: string;
  spans: TraceSpan[];
}

export interface TraceSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;                      // "planning.execute", "gateway.complete"
  startTime: number;
  endTime: number;
  attributes: Record<string, string | number>;
  events: Array<{ name: string; timestamp: number; attributes?: Record<string, string> }>;
  status: "ok" | "error";
}

// Integrates with: Jaeger, Datadog, New Relic, Grafana Tempo
```

### 6.6 — Hierarchical Orchestration (Manager Agent)

```typescript
// A "manager" agent that can dynamically decide which stages to run
// and in what order — instead of static pipeline definition

export interface ManagerConfig {
  managerModel: string;              // model that orchestrates
  availableTeams: TeamId[];          // teams the manager can dispatch
  maxIterations: number;             // prevent infinite loops
  goal: string;                      // high-level objective
}

// Flow: Manager receives goal → decides which team to call next →
// evaluates result → decides next step → repeats until goal is met
```

### 6.7 — Agent Swarms (Parallel Stage Cloning)

```typescript
// Clone a stage N times with different inputs for parallel processing
export interface SwarmConfig {
  stageId: string;
  cloneCount: number;                // how many parallel instances
  inputSplitter: "chunks" | "perspectives" | "custom";
  outputMerger: "concatenate" | "llm_merge" | "vote";
}

// Use case: Code Review stage cloned 3x
// Clone 1: Review for security
// Clone 2: Review for performance
// Clone 3: Review for maintainability
// Merger: LLM combines all 3 reviews into unified report
```

### 6.8 — Skills System (Reusable Agent Configurations)

```typescript
// Saved, reusable agent configurations (like DeerFlow skills)
export interface Skill {
  id: string;
  name: string;
  description: string;
  teamId: TeamId;
  systemPromptOverride: string;
  tools: string[];                   // MCP tools this skill uses
  modelPreference: string;          // preferred model
  outputFormat: object;             // expected output JSON schema
  tags: string[];
  createdBy: string;
  isPublic: boolean;
}

// Built-in skills:
// - "Security Auditor": Code Review + OWASP prompts + security tools
// - "API Designer": Architecture + OpenAPI generation + validation
// - "Test Writer": Testing + coverage focus + edge case generation
// - "Docs Generator": custom stage + JSDoc/README generation
```

---

## Known Technical Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Context limit exceeded (large `previousOutputs`) | Stage fails or truncates history | Implement smart summarization between stages; compress earlier outputs |
| Provider rate limits (Claude/Gemini/Grok) | Pipeline stalls mid-run | Retry with exponential backoff; surface clear error to user; allow model fallback |
| Docker socket security | Host compromise if sandbox escapes | Default `NetworkMode: none`; resource limits; gVisor/Firecracker for prod |
| Memory table growth | Slow queries, storage bloat | Confidence decay auto-cleans stale memories; TTL; pagination |
| Strategy cost explosion (MoA/Debate) | Unexpected bills | Cost estimation before run; hard budget cap per stage; "confirm if > $X" gate |
| Multi-model output format inconsistency | Parsing failures | Guardrails + structured output validation; fallback to text if JSON fails |
| Maintenance Scout false positives | Alert fatigue | Re-evaluate every scan; user-controlled severity thresholds; dismiss/backlog actions |

### Implementation Sequence Validation

```
Step 1 — Phase 2: Pipeline Builder UX
  ↓ (pipeline UX must be solid — strategy presets feed into Phase 3.6)
Step 2 — Phase 3.6: Multi-Model Execution Strategies (MoA, Debate, Voting)
  ↓ (core product differentiator — parallel proposers, debate loops, voting)
Step 3 — Phase 3.7: Privacy Proxy Layer
  ↓ (PRIORITIZED — must anonymize data before sending to cloud providers)
Step 4 — Phase 3.5: Docker Sandbox Execution
  ↓ (isolated code execution — needs stable pipeline controller)
Step 5 — Phase 3: Quality & Reliability (fact-checker, context accumulation, WS cleanup, syntax highlighting)
  ↓ (stabilization before adding data layer)
Step 6 — Phase 3.2: Statistics, Cost Tracking, Thought Tree
  ↓ (llm_requests table feeds knowledge_search in Phase 3.1)
Step 7 — Phase 3.3: Memory System
  ↓ (needs stable run data + llm_requests from Phase 3.2)
Step 8 — Phase 3.1: Tools, MCP & Knowledge Bases
  ↓ (needs memory + knowledge_search from 3.2/3.3)
Step 9 — Phase 3.4: Governance & Gates
  ↓
Step 10 — Phase 4: Multi-model parallel code review (scoped — no full IDE)
  ↓
Step 11 — Phase 5: Advanced features
```
