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
  ILLMProviderOptions,
  ProviderMessage,
  ToolCall,
} from "@shared/types";
import {
  ConcurrencyLimiter,
  spawnCli,
  streamCliLines,
  type CliSpawnRequest,
} from "./cli-spawn";

const DEFAULT_BINARY = "claude";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CONCURRENCY = 4;
const ERROR_PREVIEW_CHARS = 200;

interface ClaudeCliResult {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface ClaudeCliAssistantEvent {
  type: "assistant";
  message?: { content?: Array<{ type: string; text?: string }> };
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

export class ClaudeCliProvider implements ILLMProvider {
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
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
  }
}
