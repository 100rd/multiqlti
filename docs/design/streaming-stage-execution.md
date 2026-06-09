# Design: Streaming Stage Execution + Long-Call Timeout Policy

- **Status**: Proposed (DESIGN phase — no implementation in this doc)
- **Branch**: `feature/streaming-stage-execution`
- **Author**: solution-architect
- **Date**: 2026-06-09
- **Related**: provider allowlist work (subscription CLIs only — `feature/limit-providers-to-cli`), which put real `claude`/`agy` models on the SDLC stage hot path and surfaced this bug.

## 1. Context & Problem (proven-live)

SDLC pipeline stages execute LLM calls through the gateway using **blocking** `complete()` / `completeWithTools()`. CLI-backed providers shell out via `spawnCli()` with `DEFAULT_TIMEOUT_MS = 120_000` (`server/gateway/providers/cli-spawn.ts:17`). A real subscription-CLI model (`claude -p`, `agy --print`) on a substantial planning prompt routinely exceeds 120s of wall-clock for a SINGLE blocking call, so the stage fails with:

```
CLI timed out after 120000ms
```

Observed: run `6078ba0b` failed at stage 0 (planning). Because the planning team has tools enabled by default (`DEFAULT_TEAM_TOOLS.planning = ['web_search','knowledge_search','memory_search']`, `server/teams/base.ts:11`), stage 0 goes through `completeWithTools()` → `provider.complete()` → blocking `spawnCli` → 120s cap → failure. **multiqlti currently cannot complete ANY real-model SDLC task.**

The 120s wall-clock cap is the wrong model for a long, legitimately-running streamed LLM call: a planning turn can stream tokens for minutes while making continuous progress. We need to (a) stream the stage call so output arrives incrementally, and (b) replace the single wall-clock cap **on the stage path only** with an **idle (inactivity) timeout + a generous overall cap**.

### Why this is safe to scope narrowly

The 120s blocking `spawnCli` default is correct for *short* callers (e.g. `Gateway.testProvider()`, `server/gateway/index.ts:423` — a `"ping"` health check; and `agy models` / `claude` model discovery). Those MUST keep the existing blocking path and short default. Only the **pipeline stage** call path changes.

## 2. Call-Site Map (where stages drive the gateway)

### 2.1 The single chokepoint — `BaseTeam.execute()`

Every pipeline stage converges on `BaseTeam.execute()` (`server/teams/base.ts:41`). Both orchestration paths call it:

| Orchestration path | File:line | Calls |
| --- | --- | --- |
| DAG executor stage fn | `server/controller/pipeline-controller.ts:280` | `team.execute(stageInput, context, dagStage.executionStrategy)` |
| Linear `executeStages` (swarm-off branch) | `server/controller/pipeline-controller.ts:756` | `team.execute(...)` |
| Linear `executeStages` (parallel-null branch) | `server/controller/pipeline-controller.ts:774` | `team.execute(...)` |
| Parallel sub-task | `server/pipeline/parallel-executor.ts:300` | `team.execute(subtaskInput, subtaskContext)` |
| Swarm agent | `server/pipeline/swarm-executor.ts:299` | `team.execute(...)` |
| Delegation | `server/pipeline/delegation-service.ts:115` | `team.execute(...)` |

`BaseTeam.execute()` → `executeSingleModel()` (`server/teams/base.ts:57`) makes the actual gateway call, choosing between two blocking entry points:

- **Tool path** (`base.ts:78`): `gateway.completeWithTools({...})` — used when the team/stage has tools (planning, architecture, development, code_review, deployment, monitoring all have defaults). **This is the path stage 0 takes and where the failure occurs.**
- **Plain path** (`base.ts:113`): `gateway.complete({...})` — used when no tools are enabled (e.g. a stage that disabled tools).
- **Strategy path** (`base.ts:146`): `executeWithStrategy()` → `StrategyExecutor` → many `gateway.complete()` calls (`server/services/strategy-executor.ts:84,118,155,215,256,290,340`). Each of those is a stage-originated LLM call too.

### 2.2 Gateway entry points (blocking today)

- `Gateway.complete()` — `server/gateway/index.ts:260`; calls `provider.complete(modelId, messages, {...})` at `index.ts:314`.
- `Gateway.completeWithTools()` — `server/gateway/index.ts:500`; tool loop calling `provider.complete(...)` at `index.ts:538` (NO streaming today).
- `Gateway.stream()` — `server/gateway/index.ts:374`; already streams, already consumed by chat/code-chat. **Reuse target.**

### 2.3 Provider streaming primitives (reuse)

- `ClaudeCliProvider.stream()` — `server/gateway/providers/claude-cli.ts:180`; runs `claude -p --output-format stream-json --verbose` via `streamCliLines()` and yields incremental text deltas from `assistant` events (`iterateStream()`, `claude-cli.ts:191`).
- `streamCliLines()` — `cli-spawn.ts:185`; spawns, splits stdout into JSONL lines, honors `signal` + a single wall-clock `timeoutMs`. **The timeout here is what we extend to idle+overall.**
- `AntigravityProvider.stream()` — `antigravity.ts:111`; emulated one-shot (yields the full completion once). Kept; its timeout must be made adequate (see §4.4).

### 2.4 Existing streaming consumers (mirror this pattern)

- `server/routes/chat.ts:226` — SSE: `for await (const chunk of gateway.stream({...})) res.write(...)`.
- `server/workspace/code-chat.ts:100` — same accumulate-chunks pattern.
- `server/routes/gateway.ts:84` — SSE passthrough.
- `BaseTeam.executeStream()` (`server/teams/base.ts:168`) — **defined but currently consumed by NOBODY** in the pipeline. We will build the stage streaming path adjacent to it (see §3).

### 2.5 Callers that must NOT change (keep blocking 120s)

- `Gateway.testProvider()` — `server/gateway/index.ts:423` → `provider.complete(...)` (the `"ping"` health check).
- Model discovery: `ClaudeCliProvider.listModels()` (`claude-cli.ts:212`), `listAntigravityModels()` (`antigravity-cli.ts:187`).
- All non-stage `gateway.complete()` users that are inherently short.

## 3. Design: Streaming Stage Execution

### 3.1 New gateway methods (additive — do not change existing `complete`/`stream`)

Add two streaming-aware gateway methods so the stage path consumes deltas while the existing `complete`/`completeWithTools`/`stream` keep their exact current behavior (backward-compat, §6).

```
Gateway.completeStreaming(
  request: GatewayRequest,
  privacyOptions?,
  loggingOptions?,
  streamOptions?: StageStreamOptions,   // { onDelta, signal, idleTimeoutMs, overallTimeoutMs, maxOutputBytes }
): Promise<GatewayResponse>
```

- Resolves provider/model exactly like `complete()` (`index.ts:265-270`), runs the SAME budget pre-check (`index.ts:289`), anonymization (`index.ts:276`), and `logRequest()` (success+error) as `complete()`. DRY: extract the shared resolve/budget/anonymize/log scaffolding from `complete()` into private helpers and have both `complete()` and `completeStreaming()` use them.
- Instead of `await provider.complete(...)`, it does:
  ```
  for await (const delta of provider.stream(modelId, messages, providerOpts)) {
    accumulator.push(delta)      // bounded — see §5.2
    streamOptions?.onDelta?.(delta, accumulator.length)
  }
  ```
  then returns `{ content: accumulator.text(), tokensUsed, modelSlug, finishReason: "stop" }`. Token usage from streaming is not always available per-delta; record what the provider exposes (Claude CLI `result` event carries usage; Antigravity estimates from bytes) and fall back to a length-based estimate, mirroring `parseCompleteOutput` (`claude-cli.ts:106`). **Never silently zero it without a comment.**
- `providerOpts` carries the **new** `idleTimeoutMs`, `overallTimeoutMs`, `maxOutputBytes`, and `signal` (see §4.1, §7).

```
Gateway.completeWithToolsStreaming(params, streamOptions?): Promise<{ content; tokensUsed; toolCallLog }>
```

- Same tool loop as `completeWithTools()` (`index.ts:500`), but **each assistant turn is obtained via streaming** rather than `provider.complete(...)`. See §3.3 for the interleaved tool-event handling — this is the load-bearing part.

### 3.2 Stage path wiring

`BaseTeam.executeSingleModel()` (`server/teams/base.ts:57`) is the only place that needs re-pointing:

- **Tool path** (`base.ts:78`): `gateway.completeWithTools(...)` → `gateway.completeWithToolsStreaming(..., streamOptions)`.
- **Plain path** (`base.ts:113`): `gateway.complete(...)` → `gateway.completeStreaming(..., streamOptions)`.
- **Strategy path**: `StrategyExecutor` sub-calls re-point from `gateway.complete()` to `gateway.completeStreaming()` (same `streamOptions`), so long strategy stages also get the idle+overall policy. (Lower priority than the tool path; can be a follow-up task — see §8.)

`streamOptions.onDelta` emits incremental WS progress (§3.4). `streamOptions.signal` is the run abort signal threaded from the controller (§3.5). The idle/overall/maxOutput values come from config (§4.2).

`BaseTeam` gets the values from a new optional `StageContext.streaming` block (carrying `signal`, `onDelta`, and the resolved timeout/limit numbers), populated by the pipeline-controller when it builds `context`. The existing `executeStream()` (`base.ts:168`) stays for chat-style single-model streaming; the stage path uses the new accumulate-to-result methods because stages need the FULL assembled text + tool loop + the `TeamResult` shape, not a raw chunk generator.

### 3.3 Tool loop while streaming (`claude -p stream-json` semantics)

`claude -p --output-format stream-json --verbose` emits a JSONL event stream. The relevant event types for a tool-using turn:

- `assistant` events whose `message.content` blocks may be `{type:"text"}` (assistant prose) and/or `{type:"tool_use", id, name, input}` (a tool call the model wants run).
- a terminal `result` event (`subtype`, `is_error`, `result`, `usage`) — already parsed by `parseCompleteOutput` (`claude-cli.ts:106`).

Current `ClaudeCliProvider.iterateStream()` (`claude-cli.ts:191`) extracts ONLY `text` blocks. For the streaming tool loop we need the provider to surface tool-use blocks AND text deltas AND the final usage. Design:

1. **New provider streaming-events API (additive):** add `ClaudeCliProvider.streamEvents(modelId, messages, opts): AsyncGenerator<ProviderStreamEvent>` where
   ```
   type ProviderStreamEvent =
     | { kind: "text-delta"; text: string }
     | { kind: "tool-call"; call: ToolCall }
     | { kind: "done"; tokensUsed: number; finishReason: "stop" | "tool_use" }
   ```
   This is built by extending the existing `iterateStream` JSONL parse: text blocks → `text-delta` (incremental, same prefix-diff logic as `claude-cli.ts:198`), `tool_use` blocks → `tool-call`, the `result` event → `done` with usage. Reuses `streamCliLines` + `parseLine` + `assistantText`; adds tool-block extraction.
2. **`Gateway.completeWithToolsStreaming` loop** (mirrors `completeWithTools` `index.ts:532`):
   - For each iteration, consume `provider.streamEvents(...)`:
     - on `text-delta` → append to the turn's assistant text buffer and call `onDelta` (WS progress).
     - on `tool-call` → collect into `pendingToolCalls`.
     - on `done` → finishReason decides:
       - if `finishReason !== "tool_use"` or no tool calls → return assembled content + accumulated `toolCallLog` (same exit as `index.ts:554`).
       - else → push the assistant message (text + `toolCalls`), execute each tool via `toolRegistry.execute(call)` exactly as `index.ts:566-595` (incl. `workspaceDefaults` merge at `index.ts:569-578` and `toolCallLog` push at `index.ts:583`), append `tool` result messages, loop.
   - `maxIterations` honored (`index.ts:519`, default 10) with the SAME terminal fallback (`index.ts:599-602`).
3. **Provider capability fallback.** Providers whose `stream()` is emulated and have no tool channel (AntigravityProvider — `antigravity.ts` documents "tool calling is NOT supported", one-shot print) **cannot** do a streamed tool loop. `completeWithToolsStreaming` MUST detect "no `streamEvents` / no tool support" and fall back to the existing blocking `completeWithTools()` path for that provider, BUT run it under the new idle/overall timeout budget (Antigravity already accepts `options.timeoutMs` → set it to the overall cap). This keeps Antigravity working without a fake tool stream. Capability is detected via an optional `supportsStreamingToolLoop` flag / presence of `streamEvents` on the provider instance (duck-typed like the existing `"listModels" in provider` check at `index.ts:473`).

> **Open question for the Lead (flagged in §9):** exact `tool_use` block shape and whether `claude -p stream-json` emits partial `input_json` deltas for tool args (streaming tool-argument assembly) vs a single complete `tool_use` block per `assistant` event. The design assumes **complete tool-use blocks per assistant event** (no partial-arg reassembly). If partial deltas occur, the provider layer must buffer tool-arg JSON until the block closes before emitting `tool-call`. This needs a quick empirical check against the installed CLI before implementation.

### 3.4 WS progress over the EXISTING channel

`stage:progress` already exists in the `WsEventType` union (`shared/types.ts:430`) and is currently **emitted by nobody** — a ready-made slot. No new channel.

- The pipeline-controller passes an `onDelta` callback into `StageContext.streaming.onDelta` that calls the existing private `broadcast(runId, event)` (`pipeline-controller.ts:1163` → `wsManager.broadcastToRun`).
- Event shape (conforms to `WsEvent`, `shared/types.ts`):
  ```
  { type: "stage:progress", runId, stageExecutionId,
    payload: { stageIndex, teamId, deltaText, cumulativeChars }, timestamp }
  ```
- **Throttling/coalescing (memory + WS-flood safety):** do NOT emit one WS frame per token. Coalesce deltas and flush on a small interval (e.g. ~250ms) OR every N chars, whichever first — a named constant, not a magic number. Send `deltaText` (the coalesced slice) not the full cumulative buffer, so frame size stays bounded. The client appends; `cumulativeChars` lets the client show progress without us shipping the whole buffer each frame.
- Backward-compat: `stage:started` / `stage:completed` / `stage:failed` remain exactly as today (`pipeline-controller.ts:297,331,908`); `stage:progress` is purely additive. Existing clients that don't handle `stage:progress` ignore it.

### 3.5 Abort on run-cancel / client-disconnect (the gap to close)

Today the per-run `AbortController` exists (`pipeline-controller.ts:35` `activeRuns`, created `:138`, `cancelRun()` calls `abort()` `:1096-1099`) and the signal is threaded into `executeStages(run, stages, signal)` and `executeDAG(...)`. BUT it is only checked **between** stages (`if (signal.aborted) return` at `:594`, `:962`); it is **NOT** passed into `team.execute()` → gateway → provider. So a cancel during a long stage call does nothing until the (now very long) call returns. **This design closes that gap.**

- Thread the run's `AbortSignal` through: `pipeline-controller` (it already holds it) → `StageContext.streaming.signal` → `BaseTeam.executeSingleModel` → `gateway.completeStreaming/completeWithToolsStreaming` → `provider.stream/streamEvents` → `streamCliLines`/`spawnCli` (both already honor `request.signal`: `cli-spawn.ts:166,225`).
- On abort: `streamCliLines` already kills the child (`SIGTERM` then `SIGKILL`, `cli-spawn.ts:221-223`) and throws `CliExecutionError("CLI request aborted")`. The gateway streaming method must let that error propagate → stage fails with a clear "run cancelled" message (NOT swallowed). When a run is cancelled deliberately, the controller already distinguishes cancel from failure; map the aborted error to the cancelled status rather than a hard failure where appropriate.
- **Client-disconnect:** the SSE/WS layer (chat path) is unaffected. For the stage path, run-cancel IS the disconnect signal (a pipeline run is server-driven, not tied to one socket); no new disconnect plumbing needed beyond the existing `cancelRun`.
- The `ILLMProvider.stream()` contract doc currently says *"callers do not cancel mid-stream"* (`shared/types.ts:769`). **This design changes that contract** — update the doc comment: callers MAY abort mid-stream via `options.signal`; providers MUST terminate the child and stop yielding. This is a deliberate, documented contract change.

## 4. Timeout Policy

### 4.1 Model: idle timeout + overall cap (replaces single wall-clock on the stage path)

Two independent timers, both configurable:

- **Idle / inactivity timeout** (`idleTimeoutMs`): reset on **every received chunk** (every stdout `data` in `streamCliLines`, every yielded delta). Fires only when NO output has arrived for this window → "CLI idle for {idleTimeoutMs}ms (no output)". Catches a genuinely hung/stuck CLI quickly without penalizing a slow-but-progressing stream. Default: **60s** (tunable; see risk #5 re first-token latency).
- **Overall cap** (`overallTimeoutMs`): absolute wall-clock ceiling for the whole streamed call, regardless of activity. Generous. Default: **600s (10 min)** (tunable). Prevents an infinite-but-trickling stream from running forever.

A call fails when EITHER timer fires. Both produce distinct, non-swallowed `CliExecutionError` messages.

### 4.2 Config keys (new `pipeline.streaming` section in `server/config/schema.ts`)

There is no `pipeline` config section today (verified). Add one, with env overrides via the existing config loader:

```
pipeline: z.object({
  streaming: z.object({
    enabled: z.boolean().default(true),               // kill-switch → blocking fallback
    idleTimeoutMs: z.coerce.number().int().positive().default(60_000),
    overallTimeoutMs: z.coerce.number().int().positive().default(600_000),
    maxOutputBytes: z.coerce.number().int().positive().default(8 * 1024 * 1024), // 8 MiB, matches Antigravity MAX_OUTPUT_BYTES
    wsProgressFlushMs: z.coerce.number().int().positive().default(250),
  }).default({}),
}).default({}),
```

Env (through the loader's existing mapping): `PIPELINE_STREAMING_ENABLED`, `PIPELINE_STREAMING_IDLE_TIMEOUT_MS`, `PIPELINE_STREAMING_OVERALL_TIMEOUT_MS`, `PIPELINE_STREAMING_MAX_OUTPUT_BYTES`, `PIPELINE_STREAMING_WS_PROGRESS_FLUSH_MS`. (Follow the existing schema's `z.coerce.number()` + env-mapping convention already used for `antigravity.timeoutMs` at `schema.ts:61` and `memory...timeoutMs` at `schema.ts:143`.)

### 4.3 `streamCliLines` / cli-spawn changes (additive, default-preserving)

Extend `CliSpawnRequest` (`cli-spawn.ts:40`) with optional `idleTimeoutMs` and `maxOutputBytes`. In `streamCliLines` (`cli-spawn.ts:185`):

- Keep the existing single `timeoutMs` timer meaning = **overall cap** (preserve the `timeoutMs` field so `spawnCli` and short callers are untouched).
- Add an **idle timer**: armed on start, **cleared+rearmed on each stdout `data` event** (`cli-spawn.ts:228`). On fire: same kill sequence as the existing timeout (`cli-spawn.ts:215-219`) → `fail(new CliExecutionError("CLI idle for {ms}ms", null, stderr))`.
- Add a **byte cap** (`maxOutputBytes`): track cumulative stdout bytes; if exceeded → kill child + `fail(new CliExecutionError("CLI output exceeded {n} bytes", null, stderr))`. (§5.2)
- `spawnCli` (`cli-spawn.ts:132`, the BLOCKING short-caller helper) is **unchanged** — keeps `DEFAULT_TIMEOUT_MS = 120_000` and no idle timer. **Only `streamCliLines` gains idle+byte-cap**, and only stage calls reach it with the new values.

### 4.4 Antigravity (emulated stream) timeout

`AntigravityProvider.stream()` is one-shot (`antigravity.ts:111-118`) → there are no chunks to reset an idle timer on, so "idle timeout" is N/A. For Antigravity stage calls, apply the **overall cap** as its `options.timeoutMs` (it already plumbs `options?.timeoutMs ?? this.timeoutMs` → `invokeAntigravityCli` → `execFile {timeout}` at `antigravity-cli.ts:143`). So a long Antigravity planning call also gets the generous overall budget instead of 120s. `MAX_OUTPUT_BYTES` (8 MiB, `antigravity-cli.ts:52`) already bounds its buffer — align our `maxOutputBytes` default to it.

## 5. Progress + Memory Safety (no swallowed errors)

### 5.1 No swallowed errors

- A mid-stream provider/CLI error (non-zero exit, idle fire, overall fire, byte-cap, abort) MUST reject the gateway streaming method, which MUST propagate to the stage → `updateStageExecution(status:"failed", error: <clear message>)` and a `stage:failed` WS event (the existing failure path at `pipeline-controller.ts:322-348` / `:946+`). NEVER `catch {}` to an empty/partial success.
- **Capture partial output if useful:** when a stream fails after producing some text, include a short, truncated preview of the partial assistant text in the stage error (e.g. last N chars) so the failure is diagnosable — but the stage still FAILS. Do not promote partial output to a successful stage result.
- Distinguish **idle**, **overall**, **byte-cap**, **abort/cancel**, and **CLI non-zero** in the error message text (separate constants), so operators can tell a hung model from a slow one from a cancel.

### 5.2 Bounded in-memory accumulation

- The streamed assistant text is accumulated to assemble the final `content`. Bound it: track cumulative bytes; if it exceeds `pipeline.streaming.maxOutputBytes` (default 8 MiB), **abort the stream and fail the stage** ("CLI output exceeded {n} bytes") — do NOT keep growing an unbounded string. Enforced at TWO layers: in `streamCliLines` (raw stdout bytes, §4.3) and in the gateway accumulator (assembled text), since the parsed text can differ from raw stdout.
- The WS progress path sends **coalesced delta slices**, never the full cumulative buffer per frame (§3.4) — so progress emission is O(1) memory per frame.
- Tool loop: `toolCallLog` and the `messages` array grow per iteration but are already bounded by `maxIterations` (default 10). Tool RESULT content fed back is already produced by `toolRegistry.execute` — no new unbounded source.

### 5.3 Concurrency unchanged

`ConcurrencyLimiter` (`cli-spawn.ts:62`, default 4) still gates spawns. Streaming calls hold a slot for their (now longer) duration — acceptable; the cap prevents fork bombs. Note for ops: with long streamed stages, 4 concurrent is the effective stage parallelism for CLI providers; surfaced as a known tuning knob (not changed here).

## 6. Backward Compatibility

- `Gateway.complete()`, `completeWithTools()`, `stream()` keep their EXACT current signatures and behavior. New methods are additive.
- Chat (`server/routes/chat.ts`), code-chat (`server/workspace/code-chat.ts`), gateway SSE (`server/routes/gateway.ts`) consume `gateway.stream()` — untouched.
- Non-CLI / non-streaming-tool providers: `completeWithToolsStreaming` falls back to blocking `completeWithTools` under the overall budget (§3.3). MockProvider already streams (`mock.ts:273-281`, 30ms/chunk) → works with the new path unchanged; great for tests (§9).
- Kill-switch: `pipeline.streaming.enabled=false` makes `BaseTeam.executeSingleModel` use the OLD blocking `complete`/`completeWithTools`. Instant revert with no code change if streaming regresses.
- `stage:progress` is additive; old clients ignore unknown event types.

## 7. Reuse vs. New

**Reused (no rewrite):**
- `gateway.stream()` semantics & provider resolution (`index.ts:374`).
- `ClaudeCliProvider.stream()` + `iterateStream()` JSONL parsing (`claude-cli.ts:180,191`) — extended for events, not replaced.
- `streamCliLines()` spawn/line-split/abort machinery (`cli-spawn.ts:185`) — extended with idle + byte-cap.
- `spawnCli()` + 120s default — UNCHANGED, kept for short callers.
- WS `broadcast()` (`pipeline-controller.ts:1163`) + `wsManager.broadcastToRun` + the existing `stage:progress` event slot (`shared/types.ts:430`).
- Per-run `AbortController` (`pipeline-controller.ts:35,138,1096`) — now threaded all the way down.
- `completeWithTools` tool-loop logic, `workspaceDefaults` merge, `toolCallLog` (`index.ts:500-602`) — mirrored in the streaming variant.
- SSE accumulate pattern from `chat.ts:226` — the consumption shape we mirror.
- Config conventions: `z.coerce.number()` + env mapping (`schema.ts:61,143`).
- MockProvider slow-chunk stream (`mock.ts:273-281`) for tests.

**New:**
- `Gateway.completeStreaming()` + `Gateway.completeWithToolsStreaming()` (+ extracted shared resolve/budget/anonymize/log helpers, DRY out of `complete()`).
- `ClaudeCliProvider.streamEvents()` emitting `ProviderStreamEvent` (text-delta / tool-call / done) + the `ProviderStreamEvent` type (in `shared/types.ts`).
- Optional provider capability marker `supportsStreamingToolLoop` (duck-typed).
- `idleTimeoutMs` + `maxOutputBytes` on `CliSpawnRequest`; idle timer + byte-cap inside `streamCliLines`.
- `StageContext.streaming` block (`signal`, `onDelta`, resolved timeout/limit numbers) in `shared/types.ts`; populated in `pipeline-controller` where `context` is built (`:260`, `:664`).
- `pipeline.streaming` config section + env keys (`schema.ts`).
- WS `stage:progress` emission + client handler.
- Extend `ILLMProviderOptions` (`shared/types.ts:740`) with `signal?: AbortSignal`, `idleTimeoutMs?: number`, `maxOutputBytes?: number`; update the `stream()` contract doc (`:769`).

## 8. Task Breakdown (ordered, file-owned, TDD ≥80% on changed modules)

Units kept small (<800-line files, <30-line funcs). Owner tags: **BE**=Backend, **QA**=Test, **SEC**=Security, **DO**=DevOps.

### Phase 0 — Types & config (no behavior change; unblocks everything)
- **T1 [BE]** `shared/types.ts`: add `signal?`, `idleTimeoutMs?`, `maxOutputBytes?` to `ILLMProviderOptions`; add `ProviderStreamEvent` union; add `StageContext.streaming` optional block; update `stream()` contract doc comment. *(no deps)*
- **T2 [BE]** `server/config/schema.ts` + loader: add `pipeline.streaming` section + env mapping; defaults per §4.2. **[QA]** schema unit tests (defaults, env coercion, bounds). *(no deps; parallel with T1)*

### Phase 1 — cli-spawn idle + byte-cap (the timeout primitive)
- **T3 [BE]** `cli-spawn.ts`: extend `CliSpawnRequest` with `idleTimeoutMs`/`maxOutputBytes`; add idle timer (reset on stdout `data`) + cumulative-byte cap in `streamCliLines`; keep `spawnCli` + 120s default unchanged. Distinct error messages (idle/overall/byte-cap). *(deps: T1)*
- **T4 [QA]** `tests/unit/providers/cli-spawn.test.ts`: extend existing mocked-spawn suite (EventEmitter fake child, fake timers — pattern already in this file). Cases: idle fires when no data within window; idle resets on data (slow-but-progressing stream survives past old-120s using fake-timer advance); overall cap fires; byte-cap fires + kills child; abort still works; `spawnCli` defaults UNCHANGED. *(deps: T3; co-developed TDD)*
- **T5 [SEC]** Review T3: ensure child is always killed on every failure branch (no orphan/zombie), no `maxBuffer`-style unbounded growth, signal listener removed in `finally`, no error swallowed. *(deps: T3)*

### Phase 2 — provider streaming events
- **T6 [BE]** `claude-cli.ts`: add `streamEvents()` (text-delta / tool-call / done) reusing `streamCliLines`+`parseLine`+`assistantText`, adding `tool_use` block extraction and `result`-event usage; thread `idleTimeoutMs`/`maxOutputBytes`/`signal` into the `CliSpawnRequest`. Keep existing `stream()`/`complete()`. *(deps: T1, T3)*
- **T7 [QA]** `tests/unit/providers/claude-cli.test.ts`: extend with JSONL fixtures — text-only stream → deltas+done; interleaved tool_use → tool-call events then done(`tool_use`); malformed line skipped; usage parsed from `result`. *(deps: T6)*
- **T8 [BE]** `antigravity.ts`: mark no streaming-tool support; ensure `stream()`/`complete()` accept the overall-cap `timeoutMs`. (Mostly verification + a capability flag.) **[QA]** test that Antigravity stage calls get the overall cap, not 120s. *(deps: T1)*

### Phase 3 — gateway streaming methods
- **T9 [BE]** `server/gateway/index.ts`: extract shared resolve/budget/anonymize/log helpers from `complete()` (DRY, behavior-preserving); add `completeStreaming()` consuming `provider.stream()` with bounded accumulator + `onDelta` + idle/overall/byte budget + abort; same logging (success+error) as `complete()`. *(deps: T1, T3)*
- **T10 [BE]** `server/gateway/index.ts`: add `completeWithToolsStreaming()` — streamed tool loop per §3.3 (consume `streamEvents`, execute tools via `toolRegistry`, `workspaceDefaults` merge, `toolCallLog`, `maxIterations`); capability fallback to blocking `completeWithTools` under overall cap for non-streaming-tool providers. *(deps: T6, T9)*
- **T11 [QA]** `tests/unit/...gateway streaming`: (a) `completeStreaming` assembles full text from deltas, emits onDelta, enforces byte cap (fails), propagates mid-stream error (no swallow), aborts on signal; (b) `completeWithToolsStreaming` runs a streamed tool turn end-to-end against a fake `streamEvents` provider (tool-call → toolRegistry → tool result → final text), respects maxIterations, falls back for a no-stream-tool provider. *(deps: T9, T10)*
- **T12 [SEC]** Review gateway streaming: budget pre-check still runs before any spawn; anonymize/rehydrate parity with `complete()`; abort = clear error not silent partial; partial-output preview is truncated (no unbounded/raw leak); logRequest records error status. *(deps: T9, T10)*

### Phase 4 — stage wiring + WS progress
- **T13 [BE]** `server/teams/base.ts`: re-point `executeSingleModel` tool path → `completeWithToolsStreaming`, plain path → `completeStreaming`; pass `StageContext.streaming` (signal/onDelta/limits); honor `pipeline.streaming.enabled` kill-switch (old blocking path when false). Keep `executeStream` as-is. *(deps: T9, T10)*
- **T14 [BE]** `server/controller/pipeline-controller.ts`: when building `context` (linear `:664` + DAG `:260`), populate `streaming` with the run `AbortSignal` (already held), an `onDelta` that emits coalesced `stage:progress` via `broadcast()` (flush per `wsProgressFlushMs`), and resolved config limits. No change to `stage:started/completed/failed`. *(deps: T13)*
- **T15 [QA]** `tests/unit/teams` + controller test: stage path now calls the streaming gateway methods; `stage:progress` emitted (coalesced) and `stage:completed` still emitted; kill-switch routes to blocking; **abort during a stage stops the call and fails/cancels the stage** (closes the §3.5 gap). *(deps: T13, T14)*
- **T16 [BE]** Client: handle `stage:progress` (append `deltaText`, show progress) in the run view. **[QA]** light component/unit test. *(deps: T14; can parallel with T15)*

### Phase 5 — the headline deterministic test + ops
- **T17 [QA]** **">120s succeeds" deterministic test** (§9): a mock streaming provider that yields slow chunks; with **fake timers** (`vi.useFakeTimers` + `vi.advanceTimersByTimeAsync`, already used in `tests/unit/delegation-cross-instance.test.ts`), advance virtual time well past 120s while emitting a chunk inside each idle window → stage COMPLETES (proves idle-reset beats the old 120s cap). Companion: no chunk for > idleTimeoutMs → fails with idle error. *(deps: T13)*
- **T18 [DO]** Document the new env knobs in deployment docs (`docs/DEPLOYMENT_HOST.md` etc.) + `.env` example; note `make infra-up`/`make dev` host-run (never Docker), and the concurrency tuning note (§5.3). *(deps: T2)*
- **T19 [DO/QA]** Optional E2E smoke (manual/gated): a real planning stage with `claude` that previously timed out at 120s now completes via streaming. Gated behind a real-CLI env flag so CI without the CLI is unaffected. *(deps: T13, T14)*

**Parallelization:** T1 ∥ T2 (Phase 0). After T1: T3 (Phase 1) and T8 (Antigravity) parallel. T6 needs T3. T9 needs T3; T10 needs T6+T9. Phase 4 (T13/T14) needs T9+T10. QA tasks co-developed with their BE task (TDD red→green). SEC reviews (T5, T12) gate before merge. Client T16 parallel with T15.

## 9. Risks & Open Questions (for the Lead)

1. **[HIGH] `claude -p stream-json` tool-use event shape (load-bearing for §3.3).** Need an empirical capture of a tool-using `claude -p --output-format stream-json --verbose` run to confirm: (a) tool calls arrive as complete `{type:"tool_use", id, name, input}` blocks in `assistant` events (design assumes this) vs. streamed partial `input_json` deltas needing reassembly; (b) whether feeding tool RESULTS back across a fresh `claude -p` invocation preserves tool-call context, since each `claude -p` is a NEW non-interactive process — our tool loop re-invokes the CLI per iteration with the growing `messages` transcript (same as today's blocking `completeWithTools`, which already re-invokes per iteration). **Mitigation:** the streamed tool loop mirrors the existing blocking loop's per-iteration re-invocation; if partial tool-arg deltas exist, buffer them in `streamEvents` until the block closes. Recommend a 1-hour spike before Phase 2.
2. **[HIGH] Deterministic ">120s succeeds" test.** Real CLIs are non-deterministic and slow. **Approach (T17):** a `SlowMockStreamingProvider` registered in the test gateway that yields a chunk every virtual `idleTimeoutMs - epsilon`, driven by `vi.useFakeTimers()`/`advanceTimersByTimeAsync` (pattern proven in `tests/unit/delegation-cross-instance.test.ts:113,429`). Advance virtual time to e.g. 5 minutes; assert stage completes. This tests OUR idle/overall logic deterministically without a real CLI. The real-CLI case is the gated E2E smoke (T19).
3. **[MED] Token usage accuracy under streaming.** Streamed deltas may not carry per-chunk token counts; Claude CLI's `result` event has `usage` (parse it via the `done` event); Antigravity estimates from bytes. Cost ledger (`index.ts:353`) currently records `completionTokens: result.tokensUsed`. Ensure the streaming methods still surface a real/estimated `tokensUsed` and keep the ledger working — flagged so cost reporting doesn't silently zero out.
4. **[MED] Strategy-executor path.** `StrategyExecutor` makes many `gateway.complete()` calls for multi-model stages (debate/voting). Re-pointing those to `completeStreaming` is in scope but lower priority than the tool path (the proven failure). Decide: do it in this PR (T9 makes it cheap) or fast-follow. Recommend: include the re-point but keep strategy intermediate steps as WS strategy events (as today), only adding idle/overall budget.
5. **[MED] Idle/overall defaults.** 60s idle / 600s overall are starting points. A very large planning prompt's FIRST token can itself take >60s (model "thinking" before any stdout). **Mitigation:** consider a longer **first-chunk** grace (separate from steady-state idle) OR set idle default high enough (e.g. 120s) to cover first-token latency. Lead to confirm defaults; they're config so tunable in prod without a deploy.
6. **[LOW] WS frame volume.** Coalescing (§3.4, `wsProgressFlushMs=250`) bounds frames; confirm the client handles partial-append correctly and there's no per-frame full-buffer send.
7. **[LOW] Concurrency under long streams.** 4 concurrent CLI procs (§5.3) becomes the stage parallelism ceiling for long streamed stages. Acceptable for now; documented (T18). Revisit if SDLC runs need more parallel CLI stages.
