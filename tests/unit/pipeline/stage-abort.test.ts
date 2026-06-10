/**
 * Unit tests — stage abort/cancel mapping (streaming-stage-execution, T15 / H3).
 *
 * - isAbortError classifies CLI abort / AbortError / "aborted" messages so the
 *   controller maps them to "cancelled" not "failed".
 * - A cancel mid-stream propagates an abort error out of the gateway streaming
 *   method (so the stage throws → cancelled), and the provider stops yielding.
 */
import { describe, it, expect } from "vitest";
import { isAbortError } from "../../../server/controller/stage-progress.js";
import { CliAbortError, CliIdleTimeoutError } from "../../../server/gateway/providers/cli-spawn.js";
import {
  buildTestGateway,
  NeverEndingStreamingProvider,
  TEST_MODEL_SLUG,
} from "../helpers/streaming-test-utils.js";

describe("isAbortError", () => {
  it("classifies a CliAbortError as an abort", () => {
    expect(isAbortError(new CliAbortError(""))).toBe(true);
  });

  it("classifies a DOMException-style AbortError as an abort", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
  });

  it("classifies a plain Error with the exact CLI abort message", () => {
    expect(isAbortError(new Error("CLI request aborted"))).toBe(true);
  });

  it("does NOT classify model text that merely contains 'aborted' (LOW)", () => {
    expect(isAbortError(new Error("the build was aborted by the linter step"))).toBe(false);
  });

  it("does NOT classify an idle timeout as an abort (it is a failure)", () => {
    expect(isAbortError(new CliIdleTimeoutError(60_000, ""))).toBe(false);
  });

  it("does NOT classify a generic error or non-error as an abort", () => {
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError("aborted-but-not-an-error")).toBe(false);
  });
});

describe("cancel mid-stream propagates an abort (stage → cancelled)", () => {
  it("rejects the streaming gateway call when the run signal aborts", async () => {
    const gateway = buildTestGateway(new NeverEndingStreamingProvider());
    const controller = new AbortController();
    const promise = gateway.completeStreaming(
      { modelSlug: TEST_MODEL_SLUG, messages: [{ role: "user", content: "go" }] },
      undefined,
      undefined,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isAbortError(err)).toBe(true);
  });
});
