/**
 * Unit tests for the pipeline.consiliumLoop config block (Phase A2.3, §8).
 *
 * Tests ConfigSchema directly (no process.exit side-effects). Proves defaults,
 * bounds, fail-closed allowlist default, and Security M-5: a NaN coerced from a
 * bad numeric value is REJECTED by `z.coerce.number().int()` rather than
 * silently defaulting.
 */
import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../../../server/config/schema.js";

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

  it("M-5: rejects NaN coerced from a non-numeric value rather than defaulting", () => {
    // A bad env/yaml value that coerces to NaN must FAIL `.int()`, not default.
    expect(parseLoop({ maxRounds: "not-a-number" }).success).toBe(false);
    expect(parseLoop({ pollIntervalMs: "abc" }).success).toBe(false);
    expect(parseLoop({ maxDiffBytes: NaN }).success).toBe(false);
    // A non-integer numeric is also rejected (.int()).
    expect(parseLoop({ maxRounds: 2.5 }).success).toBe(false);
  });
});
