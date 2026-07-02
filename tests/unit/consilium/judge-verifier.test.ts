/**
 * judge-verifier.test.ts — Stage B (design §5, `judge` method): the controller's verifier
 * prompt builder + reply parser. PURE (no gateway) — asserts the ADVERSARIAL/REFUTE posture
 * (risk 2) and the fail-soft refute-by-default parse.
 */
import { describe, it, expect } from "vitest";
import {
  buildJudgeVerifierPrompt,
  parseJudgeVerifierOutput,
} from "../../../server/services/consilium/consilium-loop-controller.js";

describe("buildJudgeVerifierPrompt — adversarial / fenced", () => {
  const prompt = buildJudgeVerifierPrompt({
    criterion: "When run, the CLI prints the version",
    apTitle: "Add --version flag",
    apPriority: "P0",
    diff: "diff --git a/cli.ts\n+console.log(VERSION)",
  });

  it("instructs the verifier to REFUTE by default (not rubber-stamp)", () => {
    expect(prompt.system).toMatch(/REFUTE/);
    expect(prompt.system).toMatch(/NOT met UNLESS/i);
    // A TODO/test-only diff must be a FAIL per the prompt.
    expect(prompt.system).toMatch(/TODO/);
  });

  it("fences the UNTRUSTED criterion + diff as data and asks for a strict JSON verdict", () => {
    expect(prompt.user).toMatch(/UNTRUSTED/);
    expect(prompt.user).toMatch(/When run, the CLI prints the version/);
    expect(prompt.user).toMatch(/\+console\.log\(VERSION\)/);
    expect(prompt.system).toMatch(/"passed"/);
  });

  it("does NOT crash on an empty diff (renders a placeholder)", () => {
    const p = buildJudgeVerifierPrompt({ criterion: "x", apTitle: "y", apPriority: "P1", diff: "" });
    expect(p.user).toMatch(/empty diff/);
  });
});

describe("parseJudgeVerifierOutput — refute-by-default", () => {
  it("parses a clean green verdict", () => {
    expect(parseJudgeVerifierOutput('{ "passed": true, "reason": "met" }')).toEqual({ passed: true, summary: "met" });
  });

  it("parses a red verdict", () => {
    expect(parseJudgeVerifierOutput('prose... { "passed": false, "reason": "unmet" } trailing')).toEqual({
      passed: false,
      summary: "unmet",
    });
  });

  it("UNPARSEABLE reply ⇒ passed:false (never a false green)", () => {
    expect(parseJudgeVerifierOutput("the criterion looks met to me!").passed).toBe(false);
  });

  it("SHAPE-INVALID reply (no boolean passed) ⇒ passed:false", () => {
    expect(parseJudgeVerifierOutput('{ "passed": "yes" }').passed).toBe(false);
  });
});
