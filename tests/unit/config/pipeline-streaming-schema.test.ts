/**
 * Unit tests for the `pipeline.streaming` config section (streaming-stage-execution, M1).
 *
 * Validates defaults and the zod .min()/.max() bounds so a misconfiguration can
 * never disable the overall cap or set an absurd buffer. Tests parse against the
 * ConfigSchema directly (no env / no file IO) for determinism.
 */
import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../../../server/config/schema.js";

describe("pipeline.streaming config schema — defaults", () => {
  it("applies the documented defaults when nothing is set", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.pipeline.streaming).toEqual({
      enabled: true,
      idleTimeoutMs: 60_000,
      overallTimeoutMs: 600_000,
      maxOutputBytes: 8 * 1024 * 1024,
      wsProgressFlushMs: 250,
    });
  });

  it("accepts a fully-specified in-range override", () => {
    const cfg = ConfigSchema.parse({
      pipeline: {
        streaming: {
          enabled: false,
          idleTimeoutMs: 30_000,
          overallTimeoutMs: 1_200_000,
          maxOutputBytes: 1_048_576,
          wsProgressFlushMs: 500,
        },
      },
    });
    expect(cfg.pipeline.streaming.enabled).toBe(false);
    expect(cfg.pipeline.streaming.idleTimeoutMs).toBe(30_000);
    expect(cfg.pipeline.streaming.overallTimeoutMs).toBe(1_200_000);
  });

  it("coerces numeric strings (env-style) for the timeout knobs", () => {
    const cfg = ConfigSchema.parse({
      pipeline: { streaming: { idleTimeoutMs: "45000", overallTimeoutMs: "900000" } },
    });
    expect(cfg.pipeline.streaming.idleTimeoutMs).toBe(45_000);
    expect(cfg.pipeline.streaming.overallTimeoutMs).toBe(900_000);
  });
});

describe("pipeline.streaming config schema — bounds rejection (M1)", () => {
  const cases: Array<{ name: string; patch: Record<string, unknown> }> = [
    { name: "idle below min", patch: { idleTimeoutMs: 999 } },
    { name: "idle above max", patch: { idleTimeoutMs: 600_001 } },
    { name: "overall below min", patch: { overallTimeoutMs: 9_999 } },
    { name: "overall above max", patch: { overallTimeoutMs: 3_600_001 } },
    { name: "maxOutputBytes below min", patch: { maxOutputBytes: 65_535 } },
    { name: "maxOutputBytes above max", patch: { maxOutputBytes: 67_108_865 } },
    { name: "flush below min", patch: { wsProgressFlushMs: 49 } },
    { name: "flush above max", patch: { wsProgressFlushMs: 5_001 } },
  ];

  for (const { name, patch } of cases) {
    it(`rejects ${name}`, () => {
      const result = ConfigSchema.safeParse({ pipeline: { streaming: patch } });
      expect(result.success).toBe(false);
    });
  }

  it("rejects a non-integer idle timeout", () => {
    const result = ConfigSchema.safeParse({
      pipeline: { streaming: { idleTimeoutMs: 60_000.5 } },
    });
    expect(result.success).toBe(false);
  });
});
