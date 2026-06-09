/**
 * Shared test doubles + builders for the streaming-stage-execution suites.
 *
 * Provides fake streaming providers (slow/oversized/never-ending/mid-stream
 * error/tool-emitting), a minimal in-memory storage stub, a Gateway builder
 * that registers a fake provider, and a StageContext factory. No real CLI,
 * DB, or network is touched.
 */
import { vi } from "vitest";
import { Gateway } from "../../../server/gateway/index.js";
import type {
  ILLMProvider,
  ILLMProviderOptions,
  ProviderMessage,
  ProviderStreamEvent,
  StageContext,
  ToolCall,
} from "../../../shared/types.js";

export const TEST_PROVIDER_KEY = "test-stream";
export const TEST_MODEL_SLUG = "test-model";

/** Minimal IStorage stub: only the methods the gateway streaming path touches. */
export function makeStorageStub(): Record<string, unknown> {
  return {
    getModelBySlug: vi.fn(async (slug: string) => ({
      slug,
      provider: TEST_PROVIDER_KEY,
      modelId: slug,
      name: slug,
    })),
    createLlmRequest: vi.fn(async () => ({ id: "req-1" })),
  };
}

/** Build a Gateway with `provider` registered under TEST_PROVIDER_KEY. */
export function buildTestGateway(provider: ILLMProvider): Gateway {
  const storage = makeStorageStub();
  const gateway = new Gateway(storage as never);
  gateway.registerProvider(TEST_PROVIDER_KEY, provider);
  return gateway;
}

export function makeContext(overrides: Partial<StageContext> = {}): StageContext {
  return {
    runId: "run-1",
    stageIndex: 0,
    stageExecutionId: "stage-1",
    modelSlug: TEST_MODEL_SLUG,
    previousOutputs: [],
    fullContext: [],
    ...overrides,
  };
}

/** Yields fixed text chunks, one per `chunkDelayMs` (real or fake timers). */
export class SlowMockStreamingProvider implements ILLMProvider {
  constructor(
    private readonly chunks: string[],
    private readonly chunkDelayMs: number,
    private readonly tokensUsed = 42,
  ) {}

  async complete(): Promise<{ content: string; tokensUsed: number; finishReason: "stop" }> {
    return { content: this.chunks.join(""), tokensUsed: this.tokensUsed, finishReason: "stop" };
  }

  async *stream(
    _modelId: string,
    _messages: ProviderMessage[],
    _options?: ILLMProviderOptions,
  ): AsyncGenerator<string> {
    for (const chunk of this.chunks) {
      await new Promise((r) => setTimeout(r, this.chunkDelayMs));
      yield chunk;
    }
  }
}

/** Emits one chunk well beyond a byte cap to exercise gateway-level bounding. */
export class OversizedStreamingProvider implements ILLMProvider {
  constructor(private readonly totalBytes: number) {}

  async complete(): Promise<{ content: string; tokensUsed: number; finishReason: "stop" }> {
    return { content: "x".repeat(this.totalBytes), tokensUsed: 1, finishReason: "stop" };
  }

  async *stream(): AsyncGenerator<string> {
    // 64 KiB chunks until the total is exceeded.
    const chunk = "x".repeat(65_536);
    let sent = 0;
    while (sent <= this.totalBytes) {
      yield chunk;
      sent += chunk.length;
    }
  }
}

/** Honors options.signal: rejects with an abort error when aborted mid-stream. */
export class NeverEndingStreamingProvider implements ILLMProvider {
  async complete(): Promise<{ content: string; tokensUsed: number; finishReason: "stop" }> {
    return { content: "", tokensUsed: 0, finishReason: "stop" };
  }

  async *stream(
    _modelId: string,
    _messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): AsyncGenerator<string> {
    while (true) {
      if (options?.signal?.aborted) {
        throw new Error("CLI request aborted");
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 10);
        options?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("CLI request aborted"));
          },
          { once: true },
        );
      });
      yield "tick";
    }
  }
}

/** Yields a couple of deltas, then throws mid-stream (no partial success). */
export class MidStreamErrorProvider implements ILLMProvider {
  constructor(private readonly errorMessage = "mid-stream boom") {}

  async complete(): Promise<{ content: string; tokensUsed: number; finishReason: "stop" }> {
    return { content: "partial", tokensUsed: 1, finishReason: "stop" };
  }

  async *stream(): AsyncGenerator<string> {
    yield "par";
    yield "tial";
    throw new Error(this.errorMessage);
  }
}

/**
 * Streaming-tool provider: replays a scripted set of streamEvents per gateway
 * iteration. Each call to streamEvents() shifts the next script entry.
 */
export class ScriptedToolStreamProvider implements ILLMProvider {
  private turn = 0;

  constructor(private readonly script: ProviderStreamEvent[][]) {}

  async complete(): Promise<{ content: string; tokensUsed: number; finishReason: "stop" }> {
    return { content: "", tokensUsed: 0, finishReason: "stop" };
  }

  // eslint-disable-next-line require-yield
  async *stream(): AsyncGenerator<string> {
    // Not used by the tool path.
  }

  async *streamEvents(): AsyncGenerator<ProviderStreamEvent> {
    const events = this.script[Math.min(this.turn, this.script.length - 1)];
    this.turn += 1;
    for (const ev of events) yield ev;
  }
}

/** Convenience builders for ProviderStreamEvent scripts. */
export const ev = {
  text: (text: string): ProviderStreamEvent => ({ kind: "text-delta", text }),
  tool: (call: ToolCall): ProviderStreamEvent => ({ kind: "tool-call", call }),
  done: (finishReason: "stop" | "tool_use", tokensUsed = 10): ProviderStreamEvent => ({
    kind: "done",
    finishReason,
    tokensUsed,
  }),
};
