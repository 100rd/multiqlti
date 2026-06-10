/**
 * Unit tests — StageProgressCoalescer (streaming-stage-execution, T15 / L2).
 *
 * Coalesced emission (≤ one frame per flush window), delta SLICE not the full
 * buffer, secret-scrub applied to frames, idempotent close with a final flush.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StageProgressCoalescer } from "../../../server/controller/stage-progress.js";

describe("StageProgressCoalescer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("coalesces many deltas into a single frame per flush window", () => {
    const frames: Array<{ delta: string; chars: number }> = [];
    const c = new StageProgressCoalescer(250, (delta, chars) => frames.push({ delta, chars }));

    c.push("a", 1);
    c.push("b", 2);
    c.push("c", 3);
    expect(frames).toHaveLength(0); // nothing yet — buffered

    vi.advanceTimersByTime(250);
    expect(frames).toHaveLength(1);
    expect(frames[0].delta).toBe("abc"); // coalesced slice
    expect(frames[0].chars).toBe(3); // cumulative count
  });

  it("emits at most one frame per flush window across multiple windows", () => {
    const frames: string[] = [];
    const c = new StageProgressCoalescer(100, (delta) => frames.push(delta));

    c.push("x", 1);
    vi.advanceTimersByTime(100);
    c.push("y", 2);
    vi.advanceTimersByTime(100);

    expect(frames).toEqual(["x", "y"]);
  });

  it("sends the delta slice, never the full cumulative buffer", () => {
    const frames: string[] = [];
    const c = new StageProgressCoalescer(100, (delta) => frames.push(delta));

    c.push("first", 5);
    vi.advanceTimersByTime(100);
    c.push("second", 11);
    vi.advanceTimersByTime(100);

    // Second frame is only "second" — NOT "firstsecond".
    expect(frames[1]).toBe("second");
  });

  it("scrubs secret env values from emitted frames", () => {
    vi.stubEnv("OMNISCIENCE_TOKEN", "tok-leak-1234");
    const frames: string[] = [];
    const c = new StageProgressCoalescer(50, (delta) => frames.push(delta));
    c.push("prefix tok-leak-1234 suffix", 27);
    vi.advanceTimersByTime(50);
    expect(frames[0]).not.toContain("tok-leak-1234");
    expect(frames[0]).toContain("[REDACTED]");
  });

  it("flushes any pending buffer on close exactly once", () => {
    const frames: string[] = [];
    const c = new StageProgressCoalescer(10_000, (delta) => frames.push(delta));
    c.push("pending", 7);
    c.close();
    c.close(); // idempotent
    expect(frames).toEqual(["pending"]);
  });

  it("ignores deltas pushed after close", () => {
    const frames: string[] = [];
    const c = new StageProgressCoalescer(50, (delta) => frames.push(delta));
    c.close();
    c.push("late", 4);
    vi.advanceTimersByTime(50);
    expect(frames).toEqual([]);
  });
});
