/**
 * Unit tests for the pipeline.consensus + pipeline.deliberation config sections.
 * Pins: kill-switch default FALSE; documented defaults; bounds (.min/.max)
 * rejected at load; resolveConsensusCaps HARD re-clamp (voterCount→[5,7],
 * minRounds<=maxRounds). Parses ConfigSchema directly (no env/IO).
 *
 * Invoked by vitest unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../../../server/config/schema.js";
import { resolveConsensusCaps } from "../../../server/orchestrator/orchestrator-config.js";
import type { AppConfig } from "../../../server/config/schema.js";

describe("pipeline.consensus + deliberation — defaults", () => {
  it("kill-switch defaults to false with documented caps", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.pipeline.consensus).toEqual({
      enabled: false,
      maxRounds: 3,
      voterCount: 5,
      maxTotalTokens: 400_000,
      overallTimeoutMs: 1_800_000,
      voterTimeoutMs: 90_000,
    });
    expect(cfg.pipeline.deliberation).toEqual({ minRounds: 2 });
  });

  it("accepts in-range overrides", () => {
    const cfg = ConfigSchema.parse({
      pipeline: {
        consensus: { enabled: true, maxRounds: 5, voterCount: 7 },
        deliberation: { minRounds: 4 },
      },
    });
    expect(cfg.pipeline.consensus.enabled).toBe(true);
    expect(cfg.pipeline.consensus.maxRounds).toBe(5);
    expect(cfg.pipeline.consensus.voterCount).toBe(7);
    expect(cfg.pipeline.deliberation.minRounds).toBe(4);
  });
});

describe("pipeline.consensus + deliberation — bounds rejected at load", () => {
  it("rejects voterCount below 5", () => {
    expect(() => ConfigSchema.parse({ pipeline: { consensus: { voterCount: 4 } } })).toThrow();
  });
  it("rejects voterCount above 7", () => {
    expect(() => ConfigSchema.parse({ pipeline: { consensus: { voterCount: 8 } } })).toThrow();
  });
  it("rejects maxRounds above 5", () => {
    expect(() => ConfigSchema.parse({ pipeline: { consensus: { maxRounds: 6 } } })).toThrow();
  });
  it("rejects minRounds below 2", () => {
    expect(() => ConfigSchema.parse({ pipeline: { deliberation: { minRounds: 1 } } })).toThrow();
  });
  it("rejects minRounds above 5", () => {
    expect(() => ConfigSchema.parse({ pipeline: { deliberation: { minRounds: 6 } } })).toThrow();
  });
});

describe("resolveConsensusCaps — HARD re-clamp", () => {
  function cfg(consensus: Record<string, unknown>, minRounds = 2): AppConfig {
    return {
      pipeline: {
        consensus: {
          enabled: true,
          maxRounds: 3,
          voterCount: 5,
          maxTotalTokens: 400_000,
          overallTimeoutMs: 1_800_000,
          voterTimeoutMs: 90_000,
          ...consensus,
        },
        deliberation: { minRounds },
      },
    } as unknown as AppConfig;
  }

  it("passes through valid config", () => {
    const caps = resolveConsensusCaps(cfg({}));
    expect(caps.maxRounds).toBe(3);
    expect(caps.voterCount).toBe(5);
    expect(caps.minRounds).toBe(2);
  });

  it("an override can only tighten maxRounds", () => {
    expect(resolveConsensusCaps(cfg({ maxRounds: 5 }), { maxRounds: 2 }).maxRounds).toBe(2);
    expect(resolveConsensusCaps(cfg({ maxRounds: 3 }), { maxRounds: 5 }).maxRounds).toBe(3);
  });

  it("voterCount is HARD-clamped into [5,7] (never below 5)", () => {
    expect(resolveConsensusCaps(cfg({ voterCount: 1 })).voterCount).toBe(5);
    expect(resolveConsensusCaps(cfg({ voterCount: 99 })).voterCount).toBe(7);
  });

  it("minRounds never exceeds maxRounds (M-3 parity)", () => {
    expect(resolveConsensusCaps(cfg({ maxRounds: 3 }, 4)).minRounds).toBeLessThanOrEqual(3);
    expect(resolveConsensusCaps(cfg({ maxRounds: 2 }, 4)).minRounds).toBe(2);
  });
});
