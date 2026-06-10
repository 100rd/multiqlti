/**
 * Unit tests for the `pipeline.debateStreaming` config section + the new
 * `pipeline.orchestrator.debateNoveltyPatience` knob (debate-streaming-termination).
 *
 * Validates defaults and the zod .min()/.max() bounds so a misconfiguration can
 * never disable the per-turn overall cap (floor keeps >=90s), set an absurd
 * buffer, or push patience past the round hard cap (5). Parses against the
 * ConfigSchema directly (no env / no file IO) for determinism.
 */
import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../../../server/config/schema.js";

describe("pipeline.debateStreaming config schema — defaults", () => {
  it("applies the documented defaults when nothing is set", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.pipeline.debateStreaming).toEqual({
      enabled: true,
      idleTimeoutMs: 60_000,
      overallTimeoutMs: 300_000,
      maxOutputBytes: 8 * 1024 * 1024,
    });
  });

  it("the overallTimeoutMs default is >= 90s so a long Opus turn survives (R1)", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.pipeline.debateStreaming.overallTimeoutMs).toBeGreaterThanOrEqual(90_000);
  });

  it("accepts a fully-specified in-range override", () => {
    const cfg = ConfigSchema.parse({
      pipeline: {
        debateStreaming: {
          enabled: false,
          idleTimeoutMs: 30_000,
          overallTimeoutMs: 120_000,
          maxOutputBytes: 1_048_576,
        },
      },
    });
    expect(cfg.pipeline.debateStreaming.enabled).toBe(false);
    expect(cfg.pipeline.debateStreaming.idleTimeoutMs).toBe(30_000);
    expect(cfg.pipeline.debateStreaming.overallTimeoutMs).toBe(120_000);
    expect(cfg.pipeline.debateStreaming.maxOutputBytes).toBe(1_048_576);
  });

  it("coerces numeric strings (env-style) for the timeout knobs", () => {
    const cfg = ConfigSchema.parse({
      pipeline: { debateStreaming: { idleTimeoutMs: "45000", overallTimeoutMs: "200000" } },
    });
    expect(cfg.pipeline.debateStreaming.idleTimeoutMs).toBe(45_000);
    expect(cfg.pipeline.debateStreaming.overallTimeoutMs).toBe(200_000);
  });
});

describe("pipeline.debateStreaming config schema — bounds rejection (M1)", () => {
  const cases: Array<{ name: string; patch: Record<string, unknown> }> = [
    { name: "idle below min", patch: { idleTimeoutMs: 999 } },
    { name: "idle above max", patch: { idleTimeoutMs: 600_001 } },
    { name: "overall below min", patch: { overallTimeoutMs: 9_999 } },
    { name: "overall above max", patch: { overallTimeoutMs: 3_600_001 } },
    { name: "maxOutputBytes below min", patch: { maxOutputBytes: 65_535 } },
    { name: "maxOutputBytes above max", patch: { maxOutputBytes: 67_108_865 } },
  ];

  for (const { name, patch } of cases) {
    it(`rejects ${name}`, () => {
      const result = ConfigSchema.safeParse({ pipeline: { debateStreaming: patch } });
      expect(result.success).toBe(false);
    });
  }

  it("rejects a non-integer idle timeout", () => {
    const result = ConfigSchema.safeParse({
      pipeline: { debateStreaming: { idleTimeoutMs: 60_000.5 } },
    });
    expect(result.success).toBe(false);
  });
});

describe("pipeline.orchestrator.debateNoveltyPatience config schema", () => {
  it("defaults to 1", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.pipeline.orchestrator.debateNoveltyPatience).toBe(1);
  });

  it("accepts an in-range value (1..5)", () => {
    const cfg = ConfigSchema.parse({
      pipeline: { orchestrator: { debateNoveltyPatience: 3 } },
    });
    expect(cfg.pipeline.orchestrator.debateNoveltyPatience).toBe(3);
  });

  it("coerces a numeric string", () => {
    const cfg = ConfigSchema.parse({
      pipeline: { orchestrator: { debateNoveltyPatience: "2" } },
    });
    expect(cfg.pipeline.orchestrator.debateNoveltyPatience).toBe(2);
  });

  const bad: Array<{ name: string; value: unknown }> = [
    { name: "below min (0)", value: 0 },
    { name: "above max (6)", value: 6 },
    { name: "non-integer", value: 1.5 },
  ];
  for (const { name, value } of bad) {
    it(`rejects ${name}`, () => {
      const result = ConfigSchema.safeParse({
        pipeline: { orchestrator: { debateNoveltyPatience: value } },
      });
      expect(result.success).toBe(false);
    });
  }
});
