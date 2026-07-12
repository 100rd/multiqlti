/**
 * Unit tests for the secret-scrub utility (streaming-stage-execution, Security M2).
 *
 * Scrubs the VALUES of known secret env vars (OMNISCIENCE_TOKEN, JWT_SECRET,
 * anything matching *_API_KEY / *_SECRET / *_TOKEN that is present in
 * process.env) from any string that is about to enter an error message, a WS
 * progress/failure payload, a log line, the tracer, or promoted run output —
 * and applies the existing 256-char truncation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  scrubSecrets,
  scrubAndTruncate,
  MAX_PREVIEW_CHARS,
} from "../../../server/gateway/secret-scrub.js";

describe("scrubSecrets", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("replaces a known secret env value with a redaction marker", () => {
    vi.stubEnv("OMNISCIENCE_TOKEN", "tok-abc123-supersecret");
    const out = scrubSecrets("partial output leaked tok-abc123-supersecret here");
    expect(out).not.toContain("tok-abc123-supersecret");
    expect(out).toContain("[REDACTED]");
  });

  it("scrubs *_API_KEY values", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-proj-xyz-9988");
    const out = scrubSecrets("error: sk-proj-xyz-9988 was used");
    expect(out).not.toContain("sk-proj-xyz-9988");
  });

  it("scrubs JWT_SECRET values", () => {
    vi.stubEnv("JWT_SECRET", "jwt-signing-secret-value-1234567890");
    const out = scrubSecrets("token signed with jwt-signing-secret-value-1234567890");
    expect(out).not.toContain("jwt-signing-secret-value-1234567890");
  });

  it("scrubs multiple distinct secrets in one string", () => {
    vi.stubEnv("OMNISCIENCE_TOKEN", "AAA-secret");
    vi.stubEnv("GROK_API_KEY", "BBB-secret");
    const out = scrubSecrets("a=AAA-secret b=BBB-secret");
    expect(out).not.toContain("AAA-secret");
    expect(out).not.toContain("BBB-secret");
  });

  it("leaves text without secrets unchanged", () => {
    vi.stubEnv("OMNISCIENCE_TOKEN", "zzz-secret");
    expect(scrubSecrets("nothing to see here")).toBe("nothing to see here");
  });

  it("ignores empty / very-short env values to avoid mass false redaction", () => {
    vi.stubEnv("SOME_TOKEN", "ab");
    const out = scrubSecrets("the value ab appears in normal prose");
    expect(out).toBe("the value ab appears in normal prose");
  });

  it("handles non-string input by coercing safely", () => {
    expect(scrubSecrets(undefined as unknown as string)).toBe("");
  });
});

describe("scrubSecrets — per-run leased value set (ADR-003 §D dynamic scrubber)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("redacts a leased value that never sat in process.env", () => {
    const leased = "leased-aws-secret-value-abcdef";
    const out = scrubSecrets(`AWS_SECRET_ACCESS_KEY=${leased} in output`, [leased]);
    expect(out).not.toContain(leased);
    expect(out).toContain("[REDACTED]");
  });

  it("is byte-identical when no extra values are passed (leased value NOT redacted)", () => {
    const leased = "leased-only-value-xyz123";
    // Not in process.env and no extraValues ⇒ unchanged (proves opt-in default).
    expect(scrubSecrets(`echo ${leased}`)).toBe(`echo ${leased}`);
  });

  it("drops short extra values to avoid mass false-positive redaction", () => {
    const out = scrubSecrets("the id ab12 appears in prose", ["ab12"]);
    expect(out).toBe("the id ab12 appears in prose");
  });

  it("scrubAndTruncate threads the leased value set", () => {
    const leased = "leased-kubeconfig-token-998877";
    const out = scrubAndTruncate(`KUBECONFIG token ${leased}`, [leased]);
    expect(out).not.toContain(leased);
  });
});

describe("scrubAndTruncate", () => {
  beforeEach(() => vi.stubEnv("OMNISCIENCE_TOKEN", "tok-secret-9999"));
  afterEach(() => vi.unstubAllEnvs());

  it("scrubs then truncates to MAX_PREVIEW_CHARS", () => {
    const long = "x".repeat(MAX_PREVIEW_CHARS + 100);
    const out = scrubAndTruncate(long);
    expect(out.length).toBeLessThanOrEqual(MAX_PREVIEW_CHARS);
  });

  it("scrubs even when the secret sits past the truncation boundary head", () => {
    const out = scrubAndTruncate("tok-secret-9999 then a lot of text");
    expect(out).not.toContain("tok-secret-9999");
  });

  it("MAX_PREVIEW_CHARS keeps the existing 256-char contract", () => {
    expect(MAX_PREVIEW_CHARS).toBe(256);
  });
});
