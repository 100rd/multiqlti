/**
 * Security C1 + H1 — Gateway.complete must forward BOTH `signal` and
 * `timeoutMs` from the GatewayRequest into provider.complete(options).
 *
 * Before the orchestrator feature, complete() forwarded only
 * {maxTokens,temperature} (gateway/index.ts:324), so an aborted/hung debate
 * turn could never be cancelled or per-turn time-capped. These tests pin the
 * contract that the blocking path now threads abort + timeout through.
 */
import { describe, it, expect } from "vitest";
import type {
  ILLMProvider,
  ILLMProviderOptions,
  ProviderMessage,
} from "../../../shared/types.js";
import { buildTestGateway, TEST_MODEL_SLUG } from "../helpers/streaming-test-utils.js";

/** Captures the options object passed to provider.complete. */
class CapturingProvider implements ILLMProvider {
  public lastOptions?: ILLMProviderOptions;

  async complete(
    _modelId: string,
    _messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): Promise<{ content: string; tokensUsed: number; finishReason: "stop" }> {
    this.lastOptions = options;
    return { content: "ok", tokensUsed: 1, finishReason: "stop" };
  }

  // eslint-disable-next-line require-yield
  async *stream(): AsyncGenerator<string> {
    // unused
  }
}

function request(extra: Record<string, unknown> = {}) {
  return {
    modelSlug: TEST_MODEL_SLUG,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  };
}

describe("Gateway.complete signal + timeout forwarding (C1/H1)", () => {
  it("forwards the AbortSignal into provider.complete options", async () => {
    const provider = new CapturingProvider();
    const gateway = buildTestGateway(provider);
    const controller = new AbortController();

    await gateway.complete(request({ signal: controller.signal }));

    expect(provider.lastOptions?.signal).toBe(controller.signal);
  });

  it("forwards the per-call timeoutMs into provider.complete options", async () => {
    const provider = new CapturingProvider();
    const gateway = buildTestGateway(provider);

    await gateway.complete(request({ timeoutMs: 90_000 }));

    expect(provider.lastOptions?.timeoutMs).toBe(90_000);
  });

  it("leaves signal/timeout undefined when not supplied (no accidental cap)", async () => {
    const provider = new CapturingProvider();
    const gateway = buildTestGateway(provider);

    await gateway.complete(request());

    expect(provider.lastOptions?.signal).toBeUndefined();
    expect(provider.lastOptions?.timeoutMs).toBeUndefined();
  });
});
