/**
 * Unit tests for resolveCaps (orchestrator-config) — defense-in-depth runtime
 * re-clamp. A per-run override can only TIGHTEN a cap, never loosen it past the
 * config hard-max; every value is clamped to its absolute ceiling even if config
 * was somehow bypassed (Security: never trust config alone).
 *
 * Invoked by vitest unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect } from "vitest";
import { resolveCaps } from "../../../server/orchestrator/orchestrator-config.js";
import type { AppConfig } from "../../../server/config/schema.js";

function cfg(orch: Partial<AppConfig["pipeline"]["orchestrator"]>): AppConfig {
  return {
    pipeline: {
      orchestrator: {
        enabled: true,
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
        ...orch,
      },
    },
  } as unknown as AppConfig;
}

describe("resolveCaps — defaults pass through", () => {
  it("returns the config values when no overrides given", () => {
    const caps = resolveCaps(cfg({}));
    expect(caps.maxSteps).toBe(8);
    expect(caps.maxTotalTokens).toBe(400_000);
    expect(caps.overallTimeoutMs).toBe(1_800_000);
  });

  it("passes through the configured debateNoveltyPatience (default 1)", () => {
    expect(resolveCaps(cfg({})).debateNoveltyPatience).toBe(1);
    expect(resolveCaps(cfg({ debateNoveltyPatience: 3 })).debateNoveltyPatience).toBe(3);
  });
});

describe("resolveCaps — overrides can only tighten", () => {
  it("applies a tighter override", () => {
    const caps = resolveCaps(cfg({}), { maxSteps: 3, maxTotalTokens: 1000 });
    expect(caps.maxSteps).toBe(3);
    expect(caps.maxTotalTokens).toBe(1000);
  });

  it("a looser override is clamped to the config value (cannot loosen)", () => {
    const caps = resolveCaps(cfg({ maxSteps: 5 }), { maxSteps: 20 });
    expect(caps.maxSteps).toBe(5);
  });
});

describe("resolveCaps — hard-max re-clamp (config bypass guard)", () => {
  it("clamps an out-of-range config value down to the hard maximum", () => {
    const caps = resolveCaps(
      cfg({ maxSteps: 9999, maxTotalTokens: 9_999_999, overallTimeoutMs: 99_999_999 }),
    );
    expect(caps.maxSteps).toBe(20);
    expect(caps.maxTotalTokens).toBe(2_000_000);
    expect(caps.overallTimeoutMs).toBe(3_600_000);
  });

  it("floors a non-finite / negative config value to a safe minimum", () => {
    const caps = resolveCaps(cfg({ maxResearchSources: -1, maxResearchConcurrency: 0 }));
    expect(caps.maxResearchSources).toBeGreaterThanOrEqual(1);
    expect(caps.maxResearchConcurrency).toBeGreaterThanOrEqual(1);
  });
});

describe("resolveCaps — debateNoveltyPatience HARD re-clamp (M-1, never trust config)", () => {
  it("clamps an oversized patience down to the hard maximum (5)", () => {
    // A bypassed/oversized config value must NEVER push the dry-streak past the
    // round hard-cap; resolveCaps re-clamps to [1, 5] independently of zod.
    expect(resolveCaps(cfg({ debateNoveltyPatience: 9999 })).debateNoveltyPatience).toBe(5);
  });

  it("floors a non-positive / non-finite patience to the minimum (1)", () => {
    expect(resolveCaps(cfg({ debateNoveltyPatience: 0 })).debateNoveltyPatience).toBe(1);
    expect(resolveCaps(cfg({ debateNoveltyPatience: -3 })).debateNoveltyPatience).toBe(1);
    expect(
      resolveCaps(cfg({ debateNoveltyPatience: Number.NaN })).debateNoveltyPatience,
    ).toBe(1);
  });
});

describe("resolveCaps — M-3 deliberationMinRounds floor (anti-premature, min <= cap)", () => {
  function cfgMin(
    minRounds: number | undefined,
    orch: Partial<AppConfig["pipeline"]["orchestrator"]> = {},
  ): AppConfig {
    const base = cfg(orch) as unknown as { pipeline: Record<string, unknown> };
    return {
      pipeline: {
        ...base.pipeline,
        deliberation: minRounds === undefined ? {} : { minRounds },
      },
    } as unknown as AppConfig;
  }

  it("defaults to 2 when no deliberation block is present", () => {
    expect(resolveCaps(cfg({})).deliberationMinRounds).toBe(2);
  });

  it("clamps a sub-floor minRounds (1) up to 2", () => {
    expect(resolveCaps(cfgMin(1)).deliberationMinRounds).toBe(2);
  });

  it("clamps an oversized minRounds (9999) down to the hard ceiling, then to the round cap", () => {
    // maxDebateRounds default 3 → floor can never exceed 3.
    expect(resolveCaps(cfgMin(9999, { maxDebateRounds: 3 })).deliberationMinRounds).toBe(3);
  });

  it("NaN floors to 2", () => {
    expect(resolveCaps(cfgMin(Number.NaN)).deliberationMinRounds).toBe(2);
  });

  it("minRounds NEVER exceeds maxDebateRounds (maxRounds=1 + minRounds=2 → floor 1)", () => {
    // The dangerous misconfig the security review called out: a 1-round cap with a
    // 2-round floor would make a stable stop unreachable. min(floor, cap) = 1.
    expect(resolveCaps(cfgMin(2, { maxDebateRounds: 1 })).deliberationMinRounds).toBe(1);
  });

  it("respects a valid in-range minRounds", () => {
    expect(resolveCaps(cfgMin(3, { maxDebateRounds: 5 })).deliberationMinRounds).toBe(3);
  });
});
