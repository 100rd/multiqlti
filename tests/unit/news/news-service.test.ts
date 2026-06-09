/**
 * Unit tests for the news-service core (pure, no IO):
 *   - computeContentHash: SERVER-computed sha256 over canonicalized
 *     (title + summary + sourceUri) with STABLE serialization, so logically
 *     identical items collide (idempotent dedup) and different items do not.
 *   - feedback state machine: none -> up/down/hidden/read transitions; `up`
 *     clears a prior down/hidden; `hidden` suppresses; `read` sets readState.
 *   - isDuplicate: content-hash dedup helper.
 */
import { describe, it, expect } from "vitest";
import {
  computeContentHash,
  isDuplicate,
  applyFeedback,
  type FeedbackAction,
} from "../../../server/news/news-service";

describe("computeContentHash — canonicalization & idempotency", () => {
  it("produces a stable 64-char hex sha256", () => {
    const h = computeContentHash({ title: "t", summary: "s", sourceUri: "https://x" });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is identical for logically equal items", () => {
    const a = computeContentHash({ title: "AWS GA", summary: "now GA", sourceUri: "https://aws/x" });
    const b = computeContentHash({ title: "AWS GA", summary: "now GA", sourceUri: "https://aws/x" });
    expect(a).toBe(b);
  });

  it("differs when any field differs", () => {
    const base = { title: "AWS GA", summary: "now GA", sourceUri: "https://aws/x" };
    const h0 = computeContentHash(base);
    expect(computeContentHash({ ...base, title: "AWS GA2" })).not.toBe(h0);
    expect(computeContentHash({ ...base, summary: "now GA!" })).not.toBe(h0);
    expect(computeContentHash({ ...base, sourceUri: "https://aws/y" })).not.toBe(h0);
  });

  it("treats a missing sourceUri deterministically (empty)", () => {
    const a = computeContentHash({ title: "t", summary: "s" });
    const b = computeContentHash({ title: "t", summary: "s", sourceUri: "" });
    expect(a).toBe(b);
  });

  it("does not collide on field-boundary shifting", () => {
    // "ab"+"c" must not equal "a"+"bc"
    const h1 = computeContentHash({ title: "ab", summary: "c", sourceUri: "" });
    const h2 = computeContentHash({ title: "a", summary: "bc", sourceUri: "" });
    expect(h1).not.toBe(h2);
  });
});

describe("isDuplicate", () => {
  it("returns false then true after first sighting", () => {
    const seen = new Set<string>();
    expect(isDuplicate("h1", seen)).toBe(false);
    seen.add("h1");
    expect(isDuplicate("h1", seen)).toBe(true);
    expect(isDuplicate("h2", seen)).toBe(false);
  });
});

describe("applyFeedback — pure state machine (immutable)", () => {
  const base = { readState: "unread" as const, feedback: "none" as const };

  it("read sets readState=read, leaves feedback", () => {
    const r = applyFeedback(base, "read");
    expect(r).toEqual({ readState: "read", feedback: "none" });
  });

  it("up sets feedback=up", () => {
    expect(applyFeedback(base, "up").feedback).toBe("up");
  });

  it("down sets feedback=down", () => {
    expect(applyFeedback(base, "down").feedback).toBe("down");
  });

  it("hidden sets feedback=hidden", () => {
    expect(applyFeedback(base, "hidden").feedback).toBe("hidden");
  });

  it("up clears a prior down", () => {
    const downed = applyFeedback(base, "down");
    expect(applyFeedback(downed, "up").feedback).toBe("up");
  });

  it("up clears a prior hidden", () => {
    const hidden = applyFeedback(base, "hidden");
    expect(applyFeedback(hidden, "up").feedback).toBe("up");
  });

  it("does not mutate the input", () => {
    const input = { ...base };
    applyFeedback(input, "up");
    expect(input).toEqual({ readState: "unread", feedback: "none" });
  });

  it("read is independent of feedback (read then up keeps read)", () => {
    const read = applyFeedback(base, "read");
    const readThenUp = applyFeedback(read, "up");
    expect(readThenUp).toEqual({ readState: "read", feedback: "up" });
  });

  it.each<FeedbackAction>(["read", "up", "down", "hidden"])(
    "accepts the %s action without throwing",
    (action) => {
      expect(() => applyFeedback(base, action)).not.toThrow();
    },
  );
});
