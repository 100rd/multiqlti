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
 *
 * ── Model id resolution (fix/antigravity-model-label-resolution) ─────────────
 * Callers pass either the catalog SLUG (e.g. "gemini-3-1-pro-low") OR the human
 * LABEL (e.g. "Gemini 3.1 Pro (Low)"). The `agy` CLI only recognizes the LABEL;
 * passing a slug makes `agy --print` drop into its default agentic mode and
 * return empty stdout, which surfaces as `AntigravityCliError: empty output` and
 * silently degrades every antigravity caller (consensus voters, the debate
 * gemini critic, chat). `resolveModelLabel()` therefore maps an incoming id to a
 * valid `agy` LABEL — using the live `agy models` label list — before invoking
 * the CLI. The label list is loaded at most once (lazily, then cached); if it
 * cannot be loaded the provider falls back gracefully without throwing.
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

/**
 * Loads the live `agy models` LABELS. Injectable so tests can supply a fake
 * roster (and assert it is called at most once). Defaults to the real CLI.
 */
export type ModelLabelLoader = () => Promise<string[]>;

export interface AntigravityProviderConfig {
  /** Binary path or PATH-resolvable name. Defaults to "agy". */
  readonly binPath?: string;
  /** Subscription model label used when a request does not pin one. */
  readonly defaultModel?: string;
  /** Default per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
  /**
   * Override for the `agy models` label loader (testing/injection). Defaults to
   * `listAntigravityModels(binPath, timeoutMs)`.
   */
  readonly loadModelLabels?: ModelLabelLoader;
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
  private readonly loadModelLabels: ModelLabelLoader;

  /**
   * Cached `agy models` LABELS. `undefined` until the first successful load;
   * a failed load leaves it `undefined` so the next resolve retries (we do not
   * permanently cache a failure — the CLI may simply have been mid-login).
   */
  private labelCache?: readonly string[];
  /** In-flight load, so concurrent resolves share a single CLI call. */
  private labelLoad?: Promise<readonly string[]>;

  constructor(config: AntigravityProviderConfig = {}) {
    this.binPath = config.binPath ?? DEFAULT_ANTIGRAVITY_BIN;
    this.defaultModel = config.defaultModel ?? DEFAULT_ANTIGRAVITY_MODEL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_ANTIGRAVITY_TIMEOUT_MS;
    this.loadModelLabels =
      config.loadModelLabels ??
      (() => listAntigravityModels(this.binPath, this.timeoutMs));
  }

  /**
   * Return the cached `agy models` LABELS, loading them once on first use.
   * Concurrent callers share the same in-flight load. On failure this returns
   * `undefined` (the caller falls back gracefully) and clears the in-flight
   * promise so a later resolve can retry — it never throws.
   */
  private async getModelLabels(): Promise<readonly string[] | undefined> {
    if (this.labelCache) return this.labelCache;
    if (!this.labelLoad) {
      this.labelLoad = this.loadModelLabels()
        .then((labels) => {
          this.labelCache = labels;
          return this.labelCache;
        })
        .finally(() => {
          // Clear the in-flight handle so a failed load can be retried; on
          // success the cache short-circuits before we ever reach here again.
          this.labelLoad = undefined;
        });
    }
    try {
      return await this.labelLoad;
    } catch {
      // Graceful degradation: the label list is unavailable (CLI missing,
      // not logged in, etc.). The caller falls back to the id/default.
      return undefined;
    }
  }

  /**
   * Resolve an incoming model id (SLUG or LABEL) to a valid `agy` LABEL.
   *
   * Resolution order:
   *   1. exact match against a known label  -> use it
   *   2. some known label slugifies to the id -> use THAT label (slug -> label)
   *   3. id is empty/whitespace               -> defaultModel
   *   4. otherwise                            -> id as-is (last resort)
   *
   * Robust to the label cache being unavailable: with no labels it degrades to
   * (3) for an empty id and (4) otherwise, and never throws.
   */
  async resolveModelLabel(modelId: string): Promise<string> {
    const trimmed = modelId.trim();
    const labels = await this.getModelLabels();

    if (labels && trimmed.length > 0) {
      if (labels.includes(trimmed)) return trimmed;
      const bySlug = labels.find((label) => slugifyModelLabel(label) === trimmed);
      if (bySlug) return bySlug;
    }

    if (trimmed.length === 0) return this.defaultModel;
    return trimmed;
  }

  async complete(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): Promise<{ content: string; tokensUsed: number; toolCalls?: ToolCall[]; finishReason?: "stop" | "tool_use" }> {
    if (messages.length === 0) {
      throw new AntigravityCliError("AntigravityProvider: no messages to send");
    }

    const model = await this.resolveModelLabel(modelId);
    const result = await invokeAntigravityCli({
      prompt: renderPrompt(messages),
      model,
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
