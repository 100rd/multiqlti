/**
 * Antigravity provider — local, subscription-backed replacement for the
 * cloud Gemini API provider (issue #348).
 *
 * Unlike GeminiProvider (which calls the billed @google/generative-ai API),
 * this provider shells out to the local Antigravity CLI via the isolated
 * `invokeAntigravityCli()` adapter. No Gemini API key is used and no Gemini
 * API tokens are spent — the CLI authenticates against the user's Antigravity
 * subscription.
 *
 * The CLI is one-shot/non-interactive, so:
 *   - tool calling is NOT supported (the print transport has no tool channel);
 *     `complete()` always returns finishReason "stop" and no toolCalls.
 *   - `stream()` emulates streaming by yielding the full completion once.
 */
import type {
  ILLMProvider,
  ILLMProviderOptions,
  ProviderMessage,
  ToolCall,
} from "@shared/types";
import {
  invokeAntigravityCli,
  listAntigravityModels,
  AntigravityCliError,
  DEFAULT_ANTIGRAVITY_BIN,
  DEFAULT_ANTIGRAVITY_MODEL,
  DEFAULT_ANTIGRAVITY_TIMEOUT_MS,
} from "./antigravity-cli";
import type { RemoteModel } from "./ollama";

/** Turn a CLI model label into a stable, URL-safe slug. */
function slugifyModelLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Rough characters-per-token ratio for estimating usage from byte counts. */
const CHARS_PER_TOKEN = 4;

export interface AntigravityProviderConfig {
  /** Binary path or PATH-resolvable name. Defaults to "agy". */
  readonly binPath?: string;
  /** Subscription model label used when a request does not pin one. */
  readonly defaultModel?: string;
  /** Default per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/** Prefix a message with its role so the CLI sees clear turn boundaries. */
function renderMessage(message: ProviderMessage): string {
  if (message.role === "system") return `System: ${message.content}`;
  if (message.role === "tool") return `Tool result: ${message.content}`;
  if (message.role === "assistant") return `Assistant: ${message.content}`;
  return `User: ${message.content}`;
}

/** Flatten the message array into a single prompt for the one-shot CLI. */
export function renderPrompt(messages: ProviderMessage[]): string {
  const rendered = messages.map(renderMessage).join("\n\n");
  return `${rendered}\n\nAssistant:`;
}

/** Estimate token usage from prompt + completion byte counts. */
function estimateTokens(promptBytes: number, completion: string): number {
  const completionBytes = Buffer.byteLength(completion, "utf8");
  return Math.ceil((promptBytes + completionBytes) / CHARS_PER_TOKEN);
}

export class AntigravityProvider implements ILLMProvider {
  private readonly binPath: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;

  constructor(config: AntigravityProviderConfig = {}) {
    this.binPath = config.binPath ?? DEFAULT_ANTIGRAVITY_BIN;
    this.defaultModel = config.defaultModel ?? DEFAULT_ANTIGRAVITY_MODEL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_ANTIGRAVITY_TIMEOUT_MS;
  }

  /** Resolve the subscription model label, preferring the caller's modelId. */
  private resolveModel(modelId: string): string {
    return modelId.trim().length > 0 ? modelId : this.defaultModel;
  }

  async complete(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): Promise<{ content: string; tokensUsed: number; toolCalls?: ToolCall[]; finishReason?: "stop" | "tool_use" }> {
    if (messages.length === 0) {
      throw new AntigravityCliError("AntigravityProvider: no messages to send");
    }

    const result = await invokeAntigravityCli({
      prompt: renderPrompt(messages),
      model: this.resolveModel(modelId),
      binPath: this.binPath,
      timeoutMs: options?.timeoutMs ?? this.timeoutMs,
      // Security H1: forward the caller abort signal so an aborted debate/
      // orchestrator turn kills the CLI child (the CLI adapter honors signal).
      signal: options?.signal,
    });

    return {
      content: result.text,
      tokensUsed: estimateTokens(result.promptBytes, result.text),
      finishReason: "stop",
    };
  }

  async *stream(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): AsyncGenerator<string> {
    const { content } = await this.complete(modelId, messages, options);
    if (content.length > 0) yield content;
  }

  /**
   * List the subscription models reported by `agy models`. The label is used
   * verbatim as the `modelId` (passed back via `--model=<label>`); a derived
   * slug gives the client a stable identifier without a DB row.
   */
  async listModels(): Promise<RemoteModel[]> {
    const labels = await listAntigravityModels(this.binPath, this.timeoutMs);
    return labels.map((label) => ({
      id: label,
      name: label,
      provider: "antigravity",
      modelId: label,
      slug: slugifyModelLabel(label),
    }));
  }
}
