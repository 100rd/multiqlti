/**
 * Unit tests for plan-schema.ts (T3) — the strict zod gate for the Opus-authored
 * orchestrator plan. Never trust raw LLM JSON (the manager allowlist lesson).
 *
 * Covers: accept valid plans; reject unknown step types / oversized strings /
 * too-many steps / bad per-step args; the safe JSON.parse wrapper returns a
 * typed error and NEVER throws.
 *
 * Invoked by vitest unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect } from "vitest";
import {
  parsePlan,
  validateSteps,
  PLAN_STEP_HARD_MAX,
} from "../../../server/orchestrator/plan-schema.js";

const validPlanJson = JSON.stringify({
  steps: [
    { type: "research", query: "compare frameworks", candidateUrls: ["https://opentofu.org/x"] },
    { type: "debate", question: "Which framework?", rounds: 3 },
    { type: "synthesize", instruction: "produce a recommendation" },
  ],
});

describe("plan-schema — parsePlan (safe JSON wrapper)", () => {
  it("accepts a valid plan and returns typed steps", () => {
    const result = parsePlan(validPlanJson, 8);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.steps).toHaveLength(3);
      expect(result.steps[0].type).toBe("research");
    }
  });

  it("returns a safe error (never throws) on malformed JSON", () => {
    const result = parsePlan("{not valid json", 8);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/json/i);
  });

  it("returns a safe error when the steps array is missing", () => {
    const result = parsePlan(JSON.stringify({ foo: "bar" }), 8);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown step type", () => {
    const json = JSON.stringify({ steps: [{ type: "exfiltrate", query: "x" }] });
    const result = parsePlan(json, 8);
    expect(result.ok).toBe(false);
  });

  it("rejects a plan longer than the requested maxSteps", () => {
    const steps = Array.from({ length: 9 }, () => ({ type: "ground", query: "g" }));
    const result = parsePlan(JSON.stringify({ steps }), 8);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/step/i);
  });

  it("rejects a plan longer than the hard cap even if maxSteps is huge", () => {
    const steps = Array.from({ length: PLAN_STEP_HARD_MAX + 1 }, () => ({
      type: "ground",
      query: "g",
    }));
    const result = parsePlan(JSON.stringify({ steps }), 9999);
    expect(result.ok).toBe(false);
  });

  it("rejects research args missing candidateUrls", () => {
    const json = JSON.stringify({ steps: [{ type: "research", query: "x" }] });
    const result = parsePlan(json, 8);
    expect(result.ok).toBe(false);
  });

  it("rejects an oversized query string (DoS)", () => {
    const json = JSON.stringify({
      steps: [{ type: "research", query: "x".repeat(60_000), candidateUrls: [] }],
    });
    const result = parsePlan(json, 8);
    expect(result.ok).toBe(false);
  });

  it("rejects too many candidate URLs in one research step", () => {
    const candidateUrls = Array.from({ length: 200 }, (_, i) => `https://opentofu.org/${i}`);
    const json = JSON.stringify({ steps: [{ type: "research", query: "x", candidateUrls }] });
    const result = parsePlan(json, 8);
    expect(result.ok).toBe(false);
  });

  it("rejects an empty plan (must have at least one step)", () => {
    const result = parsePlan(JSON.stringify({ steps: [] }), 8);
    expect(result.ok).toBe(false);
  });
});

describe("plan-schema — validateSteps (already-parsed edited plan)", () => {
  it("accepts a valid edited steps[] array", () => {
    const result = validateSteps([{ type: "debate", question: "q", rounds: 2 }], 8);
    expect(result.ok).toBe(true);
  });

  it("rejects edited steps with a bad type", () => {
    const result = validateSteps([{ type: "rm-rf", question: "q" }], 8);
    expect(result.ok).toBe(false);
  });
});
