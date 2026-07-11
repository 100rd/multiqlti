/**
 * rate-limit.test.ts — unit coverage for the CONSERVATIVE `isRateLimitError`
 * classifier (agent-limit throttling MVP). Every positive case is a CLEAR
 * usage/rate-limit signature; every negative case is an AMBIGUOUS/unrelated
 * failure that MUST keep the existing degrade/fail path (false positive is
 * worse than false negative — see rate-limit.ts's header).
 */
import { describe, it, expect } from "vitest";
import { isRateLimitError, parseRetryAfterSeconds } from "../../../server/gateway/rate-limit.js";

describe("isRateLimitError — positive (CLEAR signatures)", () => {
  const positives = [
    "Error: rate limit exceeded, please try again later",
    "rate_limit_error: you have hit the rate limit",
    "Request failed with status code 429",
    "429 Too Many Requests",
    "too many requests — slow down",
    "You have exceeded your usage limit for this billing period",
    "quota exceeded for this project",
    "daily quota exhausted, resets at midnight UTC",
    "exceeded quota for requests per day",
    "google.api_core.exceptions.ResourceExhausted: 429 Resource has been exhausted",
    "insufficient_quota: You exceeded your current quota",
    '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    "Retry-After: 30",
    "RATE LIMIT REACHED",
  ];
  for (const text of positives) {
    it(`classifies: ${JSON.stringify(text.slice(0, 60))}`, () => {
      expect(isRateLimitError(text)).toBe(true);
    });
  }
});

describe("isRateLimitError — negative (ambiguous / unrelated — keeps existing path)", () => {
  const negatives = [
    "",
    "CLI exited with code 1: syntax error in file foo.ts",
    "CLI timed out after 1429ms", // must NOT match on "429" substring inside a number
    "ENOENT: no such file or directory, open 'claude'",
    "connection reset by peer",
    "500 Internal Server Error",
    "TypeError: Cannot read properties of undefined",
    "spawn claude ENOENT",
    "the model returned an unparseable response",
    "network timeout while contacting the gateway",
    "permission denied: worktree not writable",
    "fatal: not a git repository",
  ];
  for (const text of negatives) {
    it(`does NOT classify: ${JSON.stringify(text.slice(0, 60))}`, () => {
      expect(isRateLimitError(text)).toBe(false);
    });
  }
});

describe("parseRetryAfterSeconds — best-effort cooldown parse (throttled v2 auto-resume)", () => {
  const positives: Array<[string, number]> = [
    ["retry after 42s", 42],
    ["Retry-After: 120", 120],
    ["retry-after 90 seconds", 90],
    ["try again in 5m", 300],
    ["try again in 2 minutes", 120],
    ["retry after 1h", 3600],
    ["please retry-after 3 hours", 10800],
    ["Retry-After:120", 120], // no space after colon
    ["RATE LIMITED. Retry-After: 30", 30],
  ];
  for (const [text, seconds] of positives) {
    it(`parses ${JSON.stringify(text)} -> ${seconds}s`, () => {
      expect(parseRetryAfterSeconds(text)).toBe(seconds);
    });
  }

  const negatives = [
    "",
    "429 Too Many Requests",
    "rate limit exceeded, please slow down",
    "CLI timed out after 1429ms",
    "connection reset by peer",
    "quota exceeded for this project",
  ];
  for (const text of negatives) {
    it(`returns null for ${JSON.stringify(text.slice(0, 60))}`, () => {
      expect(parseRetryAfterSeconds(text)).toBeNull();
    });
  }

  it("never throws on garbage input", () => {
    expect(() => parseRetryAfterSeconds("retry after " + "9".repeat(400) + "s")).not.toThrow();
  });
});
