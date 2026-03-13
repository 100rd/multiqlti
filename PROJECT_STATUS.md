# multiqlti — Project Status

**Last Updated**: 2026-03-13
**Phase**: MVP Built — Provider Integration
**Overall Health**: On Track

## What It Is

Multi-model AI pipeline tool. Each pipeline stage (7 SDLC teams) can be assigned a different LLM provider. Goal: combine Claude, Gemini, and Grok in one pipeline to solve complex tasks using a multi-agent, multi-team approach.

## Architecture Overview

```
User → Pipeline Config → PipelineController
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         Planning Team   Arch Team       Dev Team ...
              │               │               │
              └───────────────┼───────────────┘
                              ▼
                          Gateway
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
           Mock           vLLM/Ollama    [Claude/Gemini/Grok]
```

**Key files:**
- `server/gateway/index.ts` — Model routing gateway
- `server/gateway/providers/` — Provider implementations
- `server/teams/` — 7 SDLC team implementations
- `server/controller/pipeline-controller.ts` — Pipeline orchestration
- `shared/types.ts` — Core types (`ModelProvider`, `TeamConfig`, etc.)
- `shared/constants.ts` — Team configs + default models

## Completed

- [x] Core pipeline engine (PipelineController)
- [x] 7 SDLC teams: Planning, Architecture, Development, Testing, Code Review, Deployment, Monitoring
- [x] Gateway with provider routing (mock / vLLM / Ollama)
- [x] WebSocket manager for real-time events
- [x] React frontend: pipeline builder, stage progress, output viewer
- [x] REST API: models, pipelines, runs, chat, gateway routes
- [x] Drizzle ORM + PostgreSQL storage layer
- [x] Docker + docker-compose setup
- [x] Git repo + GitHub remote (https://github.com/100rd/multiqlti)

## In Progress

- [ ] Design provider interface pattern for Claude/Gemini/Grok

## Not Started

- [ ] Claude provider (`server/gateway/providers/claude.ts`)
- [ ] Gemini provider (`server/gateway/providers/gemini.ts`)
- [ ] Grok provider (`server/gateway/providers/grok.ts`)
- [ ] Update `ModelProvider` type in `shared/types.ts` to include `claude | gemini | grok`
- [ ] Update Gateway to route to new providers
- [ ] UI for API key configuration per provider
- [ ] Per-stage model assignment in pipeline builder
- [ ] Streaming support for Claude / Gemini / Grok
- [ ] Token counting / cost tracking per provider
- [ ] Integration tests with real API calls

## Key Decisions

| Decision | Status | Notes |
|----------|--------|-------|
| Provider interface pattern | Pending | Extend existing `complete()` + `stream()` pattern |
| API key storage | Pending | Env vars or DB-stored (encrypted)? |
| Streaming protocol | Pending | Each provider has different SSE/stream format |
| Model slug naming | Pending | `claude-sonnet-4-6`, `gemini-2.0-flash`, `grok-3`? |

## Full Plan

See `PLAN.md` for the complete phased implementation plan with all tasks.

## Next Actions

1. Answer design questions in `PLAN.md` (API key storage, persistence, routing strategy, target models, streaming, scope)
2. Add `claude | gemini | grok` to `ModelProvider` type
2. Implement `ClaudeProvider` using `@anthropic-ai/sdk`
3. Implement `GeminiProvider` using `@google/generative-ai`
4. Implement `GrokProvider` using OpenAI-compatible API
5. Update Gateway to initialize and route to new providers
6. Add default model entries for Claude/Gemini/Grok in constants
7. Update frontend to show provider badges + API key config UI
