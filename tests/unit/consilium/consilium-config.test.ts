/**
 * Unit tests for the pipeline.consiliumLoop config block (Phase A2.3, §8).
 *
 * Tests ConfigSchema directly (no process.exit side-effects). Proves defaults,
 * bounds, fail-closed allowlist default, and Security M-5: a NaN coerced from a
 * bad numeric value is REJECTED by `z.coerce.number().int()` rather than
 * silently defaulting.
 */
import { describe, it, expect } from "vitest";
import { ConfigSchema, effectiveVerificationEnabled } from "../../../server/config/schema.js";

function parseLoop(input: Record<string, unknown>) {
  return ConfigSchema.safeParse({ pipeline: { consiliumLoop: input } });
}

describe("pipeline.consiliumLoop schema", () => {
  it("applies the documented defaults when omitted", () => {
    const res = ConfigSchema.safeParse({});
    expect(res.success).toBe(true);
    if (!res.success) return;
    const c = res.data.pipeline.consiliumLoop;
    expect(c.enabled).toBe(false);
    expect(c.maxRounds).toBe(6);
    expect(c.pollIntervalMs).toBe(5_000);
    expect(c.maxDiffBytes).toBe(200_000);
    expect(c.allowedRepoPaths).toEqual([]); // fail-closed default
    expect(c.devPipelineId).toBeUndefined();
  });

  it("accepts valid overrides", () => {
    const res = parseLoop({ enabled: true, maxRounds: 3, pollIntervalMs: 2000, maxDiffBytes: 50_000, allowedRepoPaths: ["/srv/repo"], devPipelineId: "p1" });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.pipeline.consiliumLoop.maxRounds).toBe(3);
    expect(res.data.pipeline.consiliumLoop.allowedRepoPaths).toEqual(["/srv/repo"]);
  });

  it("enforces maxRounds bounds (min 1, max 6)", () => {
    expect(parseLoop({ maxRounds: 0 }).success).toBe(false);
    expect(parseLoop({ maxRounds: 7 }).success).toBe(false);
  });

  it("enforces maxDiffBytes / pollIntervalMs bounds", () => {
    expect(parseLoop({ maxDiffBytes: 1023 }).success).toBe(false);
    expect(parseLoop({ maxDiffBytes: 2_000_001 }).success).toBe(false);
    expect(parseLoop({ pollIntervalMs: 999 }).success).toBe(false);
    expect(parseLoop({ pollIntervalMs: 60_001 }).success).toBe(false);
  });

  it("Stage 2b: implement.verification defaults to INERT (off) with bounded knobs", () => {
    const res = ConfigSchema.safeParse({});
    expect(res.success).toBe(true);
    if (!res.success) return;
    const impl = res.data.pipeline.consiliumLoop.implement;
    // Both kill-switches default OFF: nothing executes a test until an operator opts in.
    expect(impl.enabled).toBe(false);
    expect(impl.verification.enabled).toBe(false);
    // Bounded defaults.
    expect(impl.maxFixIterations).toBe(3);
    expect(impl.testCommand).toBeNull();
    expect(impl.testRunTimeoutMs).toBe(300_000);
  });

  it("Stage 2b: accepts valid verification overrides", () => {
    const res = parseLoop({
      implement: {
        enabled: true,
        verification: { enabled: true },
        maxFixIterations: 5,
        testCommand: "npm test",
        testRunTimeoutMs: 60_000,
      },
    });
    expect(res.success).toBe(true);
    if (!res.success) return;
    const impl = res.data.pipeline.consiliumLoop.implement;
    expect(impl.verification.enabled).toBe(true);
    expect(impl.maxFixIterations).toBe(5);
    expect(impl.testCommand).toBe("npm test");
    expect(impl.testRunTimeoutMs).toBe(60_000);
  });

  it("Stage 2b: enforces maxFixIterations + testRunTimeoutMs bounds", () => {
    expect(parseLoop({ implement: { maxFixIterations: 0 } }).success).toBe(false);
    expect(parseLoop({ implement: { maxFixIterations: 11 } }).success).toBe(false);
    expect(parseLoop({ implement: { maxFixIterations: 2.5 } }).success).toBe(false);
    expect(parseLoop({ implement: { testRunTimeoutMs: 9_999 } }).success).toBe(false);
    expect(parseLoop({ implement: { testRunTimeoutMs: 1_800_001 } }).success).toBe(false);
    expect(parseLoop({ implement: { testRunTimeoutMs: "abc" } }).success).toBe(false);
  });

  it("Stage 2b: trustedRepoAck defaults to false (fail-closed enable-gate)", () => {
    const res = ConfigSchema.safeParse({});
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.pipeline.consiliumLoop.implement.trustedRepoAck).toBe(false);
  });

  it("Stage 3: implement.research defaults to INERT (off) with bounded knobs", () => {
    const res = ConfigSchema.safeParse({});
    expect(res.success).toBe(true);
    if (!res.success) return;
    const r = res.data.pipeline.consiliumLoop.implement.research;
    expect(r.enabled).toBe(false); // kill-switch default OFF ⇒ ships inert
    expect(r.maxResearchIterations).toBe(3);
    expect(r.model).toBe("claude-sonnet"); // DEFAULT_TASK_MODEL, never "mock"
  });

  it("Stage 3: accepts valid research overrides", () => {
    const res = parseLoop({
      implement: { enabled: true, research: { enabled: true, maxResearchIterations: 7, model: "claude-opus" } },
    });
    expect(res.success).toBe(true);
    if (!res.success) return;
    const r = res.data.pipeline.consiliumLoop.implement.research;
    expect(r.enabled).toBe(true);
    expect(r.maxResearchIterations).toBe(7);
    expect(r.model).toBe("claude-opus");
  });

  it("Stage 3: enforces maxResearchIterations bounds (int 1..10)", () => {
    expect(parseLoop({ implement: { research: { maxResearchIterations: 0 } } }).success).toBe(false);
    expect(parseLoop({ implement: { research: { maxResearchIterations: 11 } } }).success).toBe(false);
    expect(parseLoop({ implement: { research: { maxResearchIterations: 2.5 } } }).success).toBe(false);
    expect(parseLoop({ implement: { research: { model: "" } } }).success).toBe(false);
  });

  it("MED-2: effectiveVerificationEnabled is fail-closed (needs sandbox OR trustedRepoAck)", () => {
    const cfg = (over: { ven: boolean; sandbox?: boolean; ack?: boolean }) =>
      ConfigSchema.parse({
        features: { sandbox: { enabled: over.sandbox ?? false } },
        pipeline: {
          consiliumLoop: {
            implement: {
              enabled: true,
              verification: { enabled: over.ven },
              trustedRepoAck: over.ack ?? false,
            },
          },
        },
      });
    // verification off ⇒ effective off (short-circuit, never reads features).
    expect(effectiveVerificationEnabled(cfg({ ven: false }))).toBe(false);
    // verification on but NO sandbox + NO ack ⇒ FORCE-DISABLED (fail-closed).
    expect(effectiveVerificationEnabled(cfg({ ven: true }))).toBe(false);
    // verification on + operator ack ⇒ honored.
    expect(effectiveVerificationEnabled(cfg({ ven: true, ack: true }))).toBe(true);
    // verification on + container sandbox ⇒ honored.
    expect(effectiveVerificationEnabled(cfg({ ven: true, sandbox: true }))).toBe(true);
  });

  it("M-5: rejects NaN coerced from a non-numeric value rather than defaulting", () => {
    // A bad env/yaml value that coerces to NaN must FAIL `.int()`, not default.
    expect(parseLoop({ maxRounds: "not-a-number" }).success).toBe(false);
    expect(parseLoop({ pollIntervalMs: "abc" }).success).toBe(false);
    expect(parseLoop({ maxDiffBytes: NaN }).success).toBe(false);
    // A non-integer numeric is also rejected (.int()).
    expect(parseLoop({ maxRounds: 2.5 }).success).toBe(false);
  });
});
