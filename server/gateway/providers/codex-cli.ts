/**
 * Subscription-backed OpenAI Codex provider.
 *
 * Invokes the locally installed `codex` CLI non-interactively
 * (`codex exec --json`) so requests run against the user's logged-in Codex/
 * ChatGPT subscription instead of a paid OpenAI API key. No OpenAI SDK is
 * imported here and no API key is ever read.
 *
 * The prompt is fed to the CLI via stdin (never as a shell-expanded argv
 * element — `codex exec` reads the prompt from stdin when no PROMPT argument
 * is given), and all flags are passed as an argument array, so message
 * content cannot inject shell commands.
 *
 * `codex exec` is itself an agentic CLI (it can shell out on the model's
 * behalf), unlike the plain-text `claude -p`. Since multiqlti only wants a
 * text completion here (no multiqlti tool defs are forwarded to CLI
 * providers — see claude-cli.ts), every invocation is pinned to
 * `-s read-only` so the child process can read the workspace but never
 * write to it or execute unsandboxed commands.
 *
 * Output contract: `codex exec --json` prints one JSON object per line
 * (JSONL) — there is no single-shot `--output-format json` mode like the
 * `claude` CLI. The final assistant reply arrives as an
 * `item.completed` event whose `item.type` is `"agent_message"`; token usage
 * arrives on the terminal `turn.completed` event; a failed turn is reported
 * as `turn.failed` with a non-zero-looking `error.message` even though the
 * process itself frequently exits 0.
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

const DEFAULT_BINARY = "codex";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CONCURRENCY = 4;
const ERROR_PREVIEW_CHARS = 200;

/**
 * Sentinel modelId for the default seeded model: omit `-m` entirely so the
 * CLI uses whatever model is configured in the user's `~/.codex/config.toml`
 * (subscription default). A future `codex-gpt-5`-style slug can pass a real
 * `-m <model>` value through unchanged.
 */
const DEFAULT_MODEL_SLUG = "codex";

/**
 * Curated Codex model(s) surfaced through the subscription CLI. `modelId`
 * "codex" is a multiqlti-local sentinel (see DEFAULT_MODEL_SLUG), not a
 * value passed to `-m` — it tells the CLI to use its own configured default.
 */
const CODEX_MODELS: ReadonlyArray<{
  modelId: string;
  slug: string;
  name: string;
  contextLimit: number;
}> = [
  { modelId: "codex", slug: "codex", name: "Codex (CLI default)", contextLimit: 400_000 },
];

interface CodexAgentMessageItem {
  id: string;
  type: "agent_message";
  text?: string;
}

interface CodexOtherItem {
  id: string;
  type: string;
  message?: string;
}

type CodexItem = CodexAgentMessageItem | CodexOtherItem;

interface CodexItemCompletedEvent {
  type: "item.completed";
  item?: CodexItem;
}

interface CodexTurnCompletedEvent {
  type: "turn.completed";
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

interface CodexTurnFailedEvent {
  type: "turn.failed";
  error?: { message?: string };
}

export interface CodexCliOptions {
  /** Binary name or absolute path. Defaults to "codex". */
  binary?: string;
  /** Max concurrent CLI processes. */
  maxConcurrency?: number;
}

/**
 * Render ProviderMessage[] into a single plain-text prompt for the CLI.
 * `codex exec` has no separate `--system-prompt` flag (unlike `claude -p`),
 * so any system message(s) are embedded at the top of the stdin prompt.
 */
function renderPrompt(messages: ProviderMessage[]): string {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const conversation = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "tool") return `[tool:${m.toolCallId}]\n${m.content}`;
      return `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`;
    })
    .join("\n\n");
  return systemParts.length > 0 ? `System: ${systemParts.join("\n")}\n\n${conversation}` : conversation;
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

/** Type guard narrowing an item to the `agent_message` shape with text. */
function isAgentMessage(item: CodexItem | undefined): item is CodexAgentMessageItem {
  return !!item && item.type === "agent_message" && typeof (item as CodexAgentMessageItem).text === "string";
}

/**
 * Parse the full JSONL stream emitted by `codex exec --json` into a single
 * completion result: the LAST `agent_message` item's text (a turn may emit
 * more than one, e.g. after a retried tool call), summed token usage from the
 * terminal `turn.completed` event, and a thrown error if `turn.failed`
 * appeared anywhere in the stream (the process often still exits 0 on API
 * errors — see module docstring).
 */
export function parseCompleteOutput(stdout: string): {
  content: string;
  tokensUsed: number;
  finishReason: "stop";
} {
  let content = "";
  let tokensUsed = 0;
  let turnFailure: string | null = null;

  for (const line of stdout.split("\n")) {
    const parsed = parseLine(line);
    if (!parsed) continue;

    if (parsed.type === "item.completed") {
      const item = (parsed as unknown as CodexItemCompletedEvent).item;
      if (isAgentMessage(item)) content = item.text ?? "";
      continue;
    }
    if (parsed.type === "turn.completed") {
      const usage = (parsed as unknown as CodexTurnCompletedEvent).usage ?? {};
      tokensUsed = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      continue;
    }
    if (parsed.type === "turn.failed") {
      const err = (parsed as unknown as CodexTurnFailedEvent).error;
      turnFailure = err?.message ?? "unknown turn failure";
    }
  }

  if (turnFailure) {
    throw new Error(`[codex-cli] CLI reported a turn failure: ${turnFailure}`);
  }
  if (content.length === 0) {
    throw new Error(
      `[codex-cli] No agent_message found in CLI output: ${stdout.slice(0, ERROR_PREVIEW_CHARS)}`,
    );
  }
  return { content, tokensUsed, finishReason: "stop" };
}

export class CodexCliProvider implements ILLMProvider, IStreamingToolProvider {
  private readonly binary: string;
  private readonly limiter: ConcurrencyLimiter;

  constructor(options?: CodexCliOptions) {
    this.binary = options?.binary ?? DEFAULT_BINARY;
    this.limiter = new ConcurrencyLimiter(
      options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    );
  }

  /**
   * `--skip-git-repo-check` tolerates a cwd outside a git worktree.
   * `-s read-only` confines the (agentic-by-default) CLI to read-only
   * filesystem access — it never receives multiqlti tool defs, so it has no
   * legitimate reason to write. `-m` is only appended for a real (non
   * sentinel) modelId so the seeded default model uses the CLI's own
   * configured subscription model.
   */
  private baseArgs(modelId: string): string[] {
    const args = ["exec", "--json", "--skip-git-repo-check", "-s", "read-only"];
    if (modelId && modelId !== DEFAULT_MODEL_SLUG) args.push("-m", modelId);
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
    const args = this.baseArgs(modelId);
    const request = this.buildRequest(args, messages, options);
    const { stdout } = await this.limiter.run(() => spawnCli(request));
    return parseCompleteOutput(stdout);
  }

  async *stream(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): AsyncGenerator<string> {
    const args = this.baseArgs(modelId);
    const request = this.buildRequest(args, messages, options);
    yield* this.iterateStream(request);
  }

  /**
   * `codex exec --json` has no incremental text-delta events (each
   * `agent_message` item arrives whole on `item.completed`), so this emits
   * the same prefix-diff shape as claude-cli's iterateStream purely for
   * interface parity: in practice it is a single "yield the whole message"
   * per completed agent_message item.
   */
  private async *iterateStream(request: CliSpawnRequest): AsyncGenerator<string> {
    const release = await this.limiter.acquireSlot();
    try {
      let previous = "";
      for await (const line of streamCliLines(request)) {
        const parsed = parseLine(line);
        if (!parsed) continue;
        if (parsed.type === "turn.failed") {
          const err = (parsed as unknown as CodexTurnFailedEvent).error;
          throw new Error(`[codex-cli] CLI reported a turn failure: ${err?.message ?? "unknown turn failure"}`);
        }
        if (parsed.type !== "item.completed") continue;
        const item = (parsed as unknown as CodexItemCompletedEvent).item;
        if (!isAgentMessage(item)) continue;
        const full = item.text ?? "";
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
   * Streamed event channel for the gateway tool loop. Codex's `--json` output
   * exposes no multiqlti-shaped tool_use blocks (its own shell tool calls are
   * internal and sandboxed read-only, see baseArgs), so this only ever emits
   * text-delta events followed by a terminal "stop" done event.
   */
  async *streamEvents(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): AsyncGenerator<ProviderStreamEvent> {
    const args = this.baseArgs(modelId);
    const request = this.buildRequest(args, messages, options);

    const release = await this.limiter.acquireSlot();
    try {
      let previousText = "";
      let tokensUsed = 0;

      for await (const line of streamCliLines(request)) {
        const parsed = parseLine(line);
        if (!parsed) continue;

        if (parsed.type === "turn.failed") {
          const err = (parsed as unknown as CodexTurnFailedEvent).error;
          throw new Error(`[codex-cli] CLI reported a turn failure: ${err?.message ?? "unknown turn failure"}`);
        }

        if (parsed.type === "item.completed") {
          const item = (parsed as unknown as CodexItemCompletedEvent).item;
          if (isAgentMessage(item)) {
            const full = item.text ?? "";
            if (full.length > 0 && full !== previousText) {
              const delta = full.startsWith(previousText) ? full.slice(previousText.length) : full;
              previousText = full;
              yield { kind: "text-delta", text: delta };
            }
          }
          continue;
        }

        if (parsed.type === "turn.completed") {
          const usage = (parsed as unknown as CodexTurnCompletedEvent).usage ?? {};
          tokensUsed = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
        }
      }

      yield { kind: "done", tokensUsed, finishReason: "stop" };
    } finally {
      release();
    }
  }

  /**
   * The `codex` CLI has no non-interactive model-listing command, so we
   * expose a single curated default model (see CODEX_MODELS/DEFAULT_MODEL_SLUG).
   */
  async listModels(): Promise<RemoteModel[]> {
    return CODEX_MODELS.map((m) => ({
      id: m.modelId,
      name: m.name,
      provider: "codex",
      modelId: m.modelId,
      slug: m.slug,
      contextLimit: m.contextLimit,
    }));
  }
}
