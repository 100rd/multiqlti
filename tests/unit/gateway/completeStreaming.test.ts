/**
 * Unit tests for Gateway.completeStreaming (streaming-stage-execution, T11a).
 *
 * Asserts: assembled text == concatenated deltas; onDelta receives coalesced
 * cumulative-char counts; a mid-stream provider error rejects (no partial
 * success); abort via signal rejects; usage is recorded (not zeroed).
 */
import { describe, it, expect } from "vitest";
import {
  buildTestGateway,
  SlowMockStreamingProvider,
  MidStreamErrorProvider,
  NeverEndingStreamingProvider,
  TEST_MODEL_SLUG,
} from "../helpers/streaming-test-utils.js";

function request() {
  return { modelSlug: TEST_MODEL_SLUG, messages: [{ role: "user", content: "hi" }] };
}

describe("Gateway.completeStreaming", () => {
  it("assembles the full content from concatenated deltas", async () => {
    const gateway = buildTestGateway(new SlowMockStreamingProvider(["Hel", "lo ", "world"], 0));
    const seen: string[] = [];
    const res = await gateway.completeStreaming(request(), undefined, undefined, {
      onDelta: (delta) => seen.push(delta),
    });
    expect(res.content).toBe("Hello world");
    expect(seen.join("")).toBe("Hello world");
  });

  it("reports a monotonically increasing cumulativeChars via onDelta", async () => {
    const gateway = buildTestGateway(new SlowMockStreamingProvider(["ab", "cd", "ef"], 0));
    const cumulative: number[] = [];
    await gateway.completeStreaming(request(), undefined, undefined, {
      onDelta: (_d, chars) => cumulative.push(chars),
    });
    expect(cumulative).toEqual([2, 4, 6]);
  });

  it("surfaces a non-zero token estimate from streamed text (does not silently zero)", async () => {
    // The plain stream() channel yields only text deltas (no usage), so the
    // gateway must fall back to a length-based estimate, never a silent zero.
    const gateway = buildTestGateway(new SlowMockStreamingProvider(["x".repeat(40)], 0, 123));
    const res = await gateway.completeStreaming(request());
    expect(res.tokensUsed).toBeGreaterThan(0);
    expect(res.tokensUsed).toBe(Math.ceil(40 / 4));
  });

  it("rejects on a mid-stream error and does NOT return a partial success", async () => {
    const gateway = buildTestGateway(new MidStreamErrorProvider("boom-xyz"));
    await expect(gateway.completeStreaming(request())).rejects.toThrow(/boom-xyz/);
  });

  it("fails when assembled output exceeds the byte cap", async () => {
    const gateway = buildTestGateway(new SlowMockStreamingProvider(["x".repeat(200)], 0));
    await expect(
      gateway.completeStreaming(request(), undefined, undefined, { maxOutputBytes: 64 }),
    ).rejects.toThrow(/exceeded/i);
  });

  it("aborts mid-stream when the signal fires", async () => {
    const gateway = buildTestGateway(new NeverEndingStreamingProvider());
    const controller = new AbortController();
    const promise = gateway.completeStreaming(request(), undefined, undefined, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toThrow(/aborted/i);
  });

  it("does not throw from onDelta callbacks back into the stream", async () => {
    const gateway = buildTestGateway(new SlowMockStreamingProvider(["a", "b"], 0));
    const res = await gateway.completeStreaming(request(), undefined, undefined, {
      onDelta: () => {
        throw new Error("callback should be isolated");
      },
    });
    expect(res.content).toBe("ab");
  });
});
