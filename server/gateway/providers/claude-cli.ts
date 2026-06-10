/**
 * Subscription-backed Claude provider.
 *
 * Invokes the locally installed `claude` CLI non-interactively
 * (`claude -p --output-format json`) so requests run against the user's logged-in
 * Claude Code subscription instead of the paid Anthropic API. The `@anthropic-ai/sdk`
 * is never imported here, and `ANTHROPIC_API_KEY` is never read → 0 calls to
 * api.anthropic.com in this mode.
 *
 * The prompt is fed to the CLI via stdin (never as a shell-expanded argv element),
 * and all flags are passed as an argument array, so message content cannot inject
 * shell commands.
 */
import type {
  ILLMProvider,
  IStreamingToolProvider,
  ILLMProviderOptions,
  ProviderMessage,
  ProviderStreamEvent,
  ToolCall,
} from "@shared/types";
import {
  ConcurrencyLimiter,
  spawnCli,
  streamCliLines,
  type CliSpawnRequest,
} from "./cli-spawn";
import type { RemoteModel } from "./ollama";

const DEFAULT_BINARY = "claude";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CONCURRENCY = 4;
const ERROR_PREVIEW_CHARS = 200;

/**
 * Curated current Claude models surfaced through the subscription CLI. The CLI
 * accepts short aliases (`opus`/`sonnet`/`haiku`) that always resolve to the
 * latest build, so these `modelId`s stay valid across point releases.
 */
const CLAUDE_MODELS: ReadonlyArray<{
  modelId: string;
  slug: string;
  name: string;
  contextLimit: number;
}> = [
  { modelId: "opus", slug: "claude-opus", name: "Claude Opus", contextLimit: 200_000 },
  { modelId: "sonnet", slug: "claude-sonnet", name: "Claude Sonnet", contextLimit: 200_000 },
  { modelId: "haiku", slug: "claude-haiku", name: "Claude Haiku", contextLimit: 200_000 },
];

interface ClaudeCliResult {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface ClaudeCliContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ClaudeCliAssistantEvent {
  type: "assistant";
  message?: { content?: ClaudeCliContentBlock[] };
}

interface ClaudeCliResultEvent {
  type: "result";
  stop_reason?: string;
  subtype?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface ClaudeCliOptions {
  /** Binary name or absolute path. Defaults to "claude". */
  binary?: string;
  /** Max concurrent CLI processes. */
  maxConcurrency?: number;
}

/** Render ProviderMessage[] into a single plain-text prompt for the CLI. */
function renderPrompt(messages: ProviderMessage[]): string {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "tool") return `[tool:${m.toolCallId}]\n${m.content}`;
      return `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`;
    })
    .join("\n\n");
}

/** Join all system messages into one system prompt, or undefined if none. */
function extractSystem(messages: ProviderMessage[]): string | undefined {
  const parts = messages.filter((m) => m.role === "system").map((m) => m.content);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Parse a single line of JSONL, returning null when the line is not valid JSON. */
function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Extract concatenated text from an `assistant` stream event's content blocks. */
function assistantText(event: ClaudeCliAssistantEvent): string {
  const blocks = event.message?.content ?? [];
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/** Extract tool_use blocks from an `assistant` event as ToolCalls. */
function assistantToolCalls(event: ClaudeCliAssistantEvent): ToolCall[] {
  const blocks = event.message?.content ?? [];
  return blocks
    .filter((b) => b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string")
    .map((b) => ({
      id: b.id as string,
      name: b.name as string,
      arguments: (b.input ?? {}) as Record<string, unknown>,
    }));
}

/** Parse the single JSON object emitted by `--output-format json`. */
export function parseCompleteOutput(stdout: string): {
  content: string;
  tokensUsed: number;
  finishReason: "stop";
} {
  const parsed = parseLine(stdout);
  if (!parsed) {
    throw new Error(
      `[claude-cli] Could not parse CLI output as JSON: ${stdout.slice(0, ERROR_PREVIEW_CHARS)}`,
    );
  }
  const result = parsed as unknown as ClaudeCliResult;
  if (result.is_error === true) {
    throw new Error(`[claude-cli] CLI reported an error: ${result.result ?? "unknown error"}`);
  }
  const content = typeof result.result === "string" ? result.result : "";
  const usage = result.usage ?? {};
  const tokensUsed = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  return { content, tokensUsed, finishReason: "stop" };
}

export class ClaudeCliProvider implements ILLMProvider, IStreamingToolProvider {
  private readonly binary: string;
  private readonly limiter: ConcurrencyLimiter;

  constructor(options?: ClaudeCliOptions) {
    this.binary = options?.binary ?? DEFAULT_BINARY;
    this.limiter = new ConcurrencyLimiter(
      options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    );
  }

  private baseArgs(
    modelId: string,
    messages: ProviderMessage[],
    format: "json" | "stream-json",
  ): string[] {
    const args = ["-p", "--output-format", format, "--model", modelId];
    if (format === "stream-json") args.push("--verbose");
    const system = extractSystem(messages);
    if (system) args.push("--system-prompt", system);
    return args;
  }

  private buildRequest(
    args: string[],
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): CliSpawnRequest {
    return {
      binary: this.binary,
      args,
      stdin: renderPrompt(messages),
      // For the streaming stage path the gateway supplies the overall cap as
      // timeoutMs plus idleTimeoutMs/maxOutputBytes/signal. Short callers omit
      // them, keeping the 120s default and no idle/byte caps (H2).
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      idleTimeoutMs: options?.idleTimeoutMs,
      maxOutputBytes: options?.maxOutputBytes,
      signal: options?.signal,
    };
  }

  async complete(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): Promise<{
    content: string;
    tokensUsed: number;
    toolCalls?: ToolCall[];
    finishReason?: "stop" | "tool_use";
  }> {
    const args = this.baseArgs(modelId, messages, "json");
    const request = this.buildRequest(args, messages, options);
    const { stdout } = await this.limiter.run(() => spawnCli(request));
    return parseCompleteOutput(stdout);
  }

  async *stream(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): AsyncGenerator<string> {
    const args = this.baseArgs(modelId, messages, "stream-json");
    const request = this.buildRequest(args, messages, options);
    yield* this.iterateStream(request);
  }

  /** Convert JSONL `assistant` events into incremental text deltas. */
  private async *iterateStream(request: CliSpawnRequest): AsyncGenerator<string> {
    // B2: hold a ConcurrencyLimiter slot for the FULL generator lifetime so
    // long-running streaming stages cannot fork unbounded children. Acquired
    // before the first spawn; released in finally on complete/error/early-return.
    const release = await this.limiter.acquireSlot();
    try {
      let previous = "";
      for await (const line of streamCliLines(request)) {
        const parsed = parseLine(line);
        if (!parsed || parsed.type !== "assistant") continue;
        const full = assistantText(parsed as unknown as ClaudeCliAssistantEvent);
        if (full.length === 0 || full === previous) continue;
        if (full.startsWith(previous)) {
          yield full.slice(previous.length);
        } else {
          yield full;
        }
        previous = full;
      }
    } finally {
      release();
    }
  }

  /**
   * Streamed event channel for the gateway tool loop (streaming-stage-execution).
   * Reuses the JSONL line stream: `assistant` text blocks → incremental
   * text-delta events (same prefix-diff as iterateStream), `tool_use` blocks →
   * tool-call events, and the terminal `result` event → a single done event
   * carrying usage + the model's stop reason. Per the spike, the enabled CLI
   * providers do not receive multiqlti tool definitions, so in practice the
   * stream is text + a stop result; the tool-call branch is kept correct for
   * any provider that does emit tool_use blocks.
   */
  async *streamEvents(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): AsyncGenerator<ProviderStreamEvent> {
    const args = this.baseArgs(modelId, messages, "stream-json");
    const request = this.buildRequest(args, messages, options);

    // B2: hold a limiter slot for the FULL generator lifetime (see iterateStream).
    const release = await this.limiter.acquireSlot();
    try {
      let previousText = "";
      let tokensUsed = 0;
      let finishReason: "stop" | "tool_use" = "stop";
      let sawResult = false;

      for await (const line of streamCliLines(request)) {
        const parsed = parseLine(line);
        if (!parsed) continue;

        if (parsed.type === "assistant") {
          const event = parsed as unknown as ClaudeCliAssistantEvent;
          const full = assistantText(event);
          if (full.length > 0 && full !== previousText) {
            const delta = full.startsWith(previousText) ? full.slice(previousText.length) : full;
            previousText = full;
            yield { kind: "text-delta", text: delta };
          }
          for (const call of assistantToolCalls(event)) {
            yield { kind: "tool-call", call };
          }
          continue;
        }

        if (parsed.type === "result") {
          const result = parsed as unknown as ClaudeCliResultEvent;
          const usage = result.usage ?? {};
          tokensUsed = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
          finishReason = result.stop_reason === "tool_use" || result.subtype === "tool_use" ? "tool_use" : "stop";
          sawResult = true;
        }
      }

      // Always emit a terminal done so the gateway loop can finalize; if the CLI
      // closed without a result event, fall back to a stop with the tokens seen.
      void sawResult;
      yield { kind: "done", tokensUsed, finishReason };
    } finally {
      release();
    }
  }

  /**
   * The `claude` CLI has no model-listing command, so we expose a curated set
   * of current models. `modelId` is an alias the CLI resolves to the latest
   * build (so this list does not go stale as point releases ship).
   */
  async listModels(): Promise<RemoteModel[]> {
    return CLAUDE_MODELS.map((m) => ({
      id: m.modelId,
      name: m.name,
      provider: "anthropic",
      modelId: m.modelId,
      slug: m.slug,
      contextLimit: m.contextLimit,
    }));
  }
}
