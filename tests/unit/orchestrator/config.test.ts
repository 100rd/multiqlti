/**
 * Unit tests for the `pipeline.orchestrator` config section (Security C2 substrate).
 *
 * Pins: kill-switch default FALSE; documented defaults; every cap's .min/.max
 * bound rejected at load (defense-in-depth, never trust config alone). Parses
 * the ConfigSchema directly (no env / no IO) for determinism.
 *
 * Invoked by vitest unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../../../server/config/schema.js";

describe("pipeline.orchestrator config schema — defaults", () => {
  it("defaults the kill-switch to false (opt-in) with documented caps", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.pipeline.orchestrator).toEqual({
      enabled: false,
      maxSteps: 8,
      maxDebateRounds: 3,
      maxResearchSources: 12,
      maxResearchConcurrency: 4,
      maxResearchSourceBytes: 262_144,
      maxResearchTotalBytes: 1_048_576,
      maxTotalTokens: 400_000,
      overallTimeoutMs: 1_800_000,
      stepOutputMaxBytes: 100_000,
      geminiTurnTimeoutMs: 90_000,
      debateNoveltyPatience: 1,
    });
  });

  it("accepts a fully-specified in-range override", () => {
    const cfg = ConfigSchema.parse({
      pipeline: {
        orchestrator: {
          enabled: true,
          maxSteps: 20,
          maxDebateRounds: 5,
          maxResearchSources: 50,
          maxTotalTokens: 1_000_000,
          overallTimeoutMs: 3_600_000,
          stepOutputMaxBytes: 1_048_576,
        },
      },
    });
    expect(cfg.pipeline.orchestrator.enabled).toBe(true);
    expect(cfg.pipeline.orchestrator.maxSteps).toBe(20);
    expect(cfg.pipeline.orchestrator.maxDebateRounds).toBe(5);
  });

  it("coerces numeric strings (env-style) for numeric knobs", () => {
    const cfg = ConfigSchema.parse({
      pipeline: { orchestrator: { maxSteps: "10", maxTotalTokens: "500000" } },
    });
    expect(cfg.pipeline.orchestrator.maxSteps).toBe(10);
    expect(cfg.pipeline.orchestrator.maxTotalTokens).toBe(500_000);
  });
});

describe("pipeline.orchestrator config schema — bounds rejection (C2 substrate)", () => {
  const cases: Array<{ name: string; patch: Record<string, unknown> }> = [
    { name: "maxSteps below min", patch: { maxSteps: 0 } },
    { name: "maxSteps above max", patch: { maxSteps: 21 } },
    { name: "maxDebateRounds below min", patch: { maxDebateRounds: 0 } },
    { name: "maxDebateRounds above max", patch: { maxDebateRounds: 6 } },
    { name: "maxResearchSources below min", patch: { maxResearchSources: 0 } },
    { name: "maxResearchSources above max", patch: { maxResearchSources: 51 } },
    { name: "maxResearchConcurrency above max", patch: { maxResearchConcurrency: 11 } },
    { name: "maxResearchSourceBytes above 1MiB", patch: { maxResearchSourceBytes: 1_048_577 } },
    { name: "maxResearchTotalBytes above max", patch: { maxResearchTotalBytes: 67_108_865 } },
    { name: "maxTotalTokens below min", patch: { maxTotalTokens: 999 } },
    { name: "maxTotalTokens above max", patch: { maxTotalTokens: 2_000_001 } },
    { name: "overallTimeoutMs below min", patch: { overallTimeoutMs: 9_999 } },
    { name: "overallTimeoutMs above max", patch: { overallTimeoutMs: 3_600_001 } },
    { name: "stepOutputMaxBytes above 1MiB", patch: { stepOutputMaxBytes: 1_048_577 } },
    { name: "geminiTurnTimeoutMs above max", patch: { geminiTurnTimeoutMs: 600_001 } },
  ];

  for (const { name, patch } of cases) {
    it(`rejects ${name}`, () => {
      const result = ConfigSchema.safeParse({ pipeline: { orchestrator: patch } });
      expect(result.success).toBe(false);
    });
  }

  it("rejects a non-integer maxSteps", () => {
    const result = ConfigSchema.safeParse({
      pipeline: { orchestrator: { maxSteps: 8.5 } },
    });
    expect(result.success).toBe(false);
  });
});
