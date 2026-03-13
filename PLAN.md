# multiqlti — Implementation Plan

**Created**: 2026-03-13
**Status**: Planning — awaiting answers to design questions (see bottom)

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

### 3.1 — Inspired by DeerFlow: Web Search & Tools

- [ ] **Web search tools integration** — add Tavily / Jina AI / Firecrawl as tool providers for stages that need web access (especially Grok fact-checker and Monitoring team). Config via env vars (`TAVILY_API_KEY`, etc.)
- [ ] **Parallel sub-agent execution** — allow pipeline stages to spawn parallel sub-tasks (like DeerFlow's sub-agent system). Example: Development stage can fan out into frontend + backend + database sub-agents, each on a different model, then merge results
- [ ] **Persistent memory across runs** — store user preferences, project context, and learned patterns in a `memory` table. Agents read memory at start, write findings at end. Survives sessions (inspired by DeerFlow's cross-session memory)
- [ ] **Skills system (markdown-based)** — extensible skill definitions as markdown files (like DeerFlow's `/mnt/skills/`). Each skill = system prompt + tools + output schema. Users can create custom skills and assign them to pipeline stages
- [ ] **MCP server integration** — allow connecting external MCP servers (HTTP/SSE) as tool providers for any pipeline stage. Gateway routes tool calls to registered MCP servers. Enables ecosystem extensibility without code changes

### 3.2 — Inspired by Paperclip: Governance & Cost

- [ ] **Per-model cost tracking** — track token usage and estimated cost per model, per run, per stage. Dashboard widget: "This run cost $0.12 across 3 models". Budget alerts when approaching limits
- [ ] **Approval gates per stage** — configurable human-in-the-loop checkpoints. Before a stage executes, optionally require user approval of the previous stage's output. More granular than current pause-on-question
- [ ] **Audit trail** — immutable log of every LLM call: model, tokens, input hash, output hash, latency, cost. Queryable via API. Export as CSV/JSON
- [ ] **Run export & reports** — generate downloadable report from pipeline run: executive summary, per-stage outputs, code files as ZIP, cost breakdown, timeline. PDF or Markdown

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
| 12 | **Memory scope** | ✅ **C) Both with hierarchy** — `global > workspace > pipeline > run`, narrower scope overrides broader on conflict |
| 13 | **Skills format** | A) Markdown (DeerFlow-style) B) JSON schema C) YAML with frontmatter |
| 14 | **Parallel execution** | A) Fan-out within stages only B) Parallel stages (DAG) C) Both |
