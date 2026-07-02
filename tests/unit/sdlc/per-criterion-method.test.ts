/**
 * per-criterion-method.test.ts — Stage B (design §5 + §9 "Stage 6"): the SDLC executor's
 * per-criterion verification-method routing + lint-clean-in-the-coder's-green.
 *
 * Everything is driven over FULLY injected seams (worktree / coder / push / openPr / git
 * runner / runTests / judgeVerify) — no real repo, claude, gh, or subprocess. Asserts:
 *   - SWITCH OFF ⇒ BYTE-IDENTICAL: `perCriterionMethod` absent/false ⇒ an AP's
 *     `verificationMethod` is IGNORED (a "manual-ops" AP still runs the coder).
 *   - MANUAL-OPS: the coder is SKIPPED, no commit, the AP is SURFACED (never green — risk
 *     1), listed in the PR body's "Manual operations required" section + counted separately
 *     in the round testSummary, EXCLUDED from the green/red counters.
 *   - JUDGE: the coder runs, then the verifier grades the DIFF; passed = verdict-green;
 *     an ABSENT verifier / a throw ⇒ not-passed (refute-by-default — risk 2).
 *   - LINT: a lint failure after a passing test enters the SAME fix loop (lint prompt),
 *     converges to green; a lint SPAWN failure ⇒ not-run; a lint TIMEOUT ⇒ not-adjudicated.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runSdlcHandoff,
  MANUAL_OPS_SUMMARY,
  MANUAL_OPS_NOTE,
  type SdlcHandoffRequest,
  type VerificationConfig,
  type JudgeVerifyFn,
} from "../../../server/services/sdlc/executor.js";
import type { TestRunResult } from "../../../server/services/sdlc/test-runner.js";
import type { ActionPoint } from "@shared/types";
import type { Skill } from "@shared/schema";

const LOOP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const REPO = "/allowlisted/omniscience";
const BRANCH = `consilium/loop-${LOOP}/round-2`;
const WT = "/tmp/sdlc-wt-XXXX/tree";
const FAKE_WT = { worktreeDir: WT, baseDir: "/tmp/sdlc-wt-XXXX", branch: BRANCH, baseRef: "main" };

const VCFG = (over: Partial<VerificationConfig> = {}): VerificationConfig => ({
  enabled: true,
  maxFixIterations: 3,
  testCommand: "npm test",
  testRunTimeoutMs: 300_000,
  ...over,
});

const AP = (over: Partial<ActionPoint> = {}): ActionPoint => ({
  title: "Do the thing",
  priority: "P0",
  rationale: "because",
  ...over,
});

const baseReq = (over: Partial<SdlcHandoffRequest> = {}): SdlcHandoffRequest => ({
  repoPath: REPO,
  loopId: LOOP,
  round: 2,
  actionPoints: [AP()],
  allowedRepoPaths: ["/allowlisted"],
  ...over,
});

const pass: TestRunResult = { passed: true, ran: true, summary: "PASSED\nall green", exitCode: 0, timedOut: false };
const fail: TestRunResult = { passed: false, ran: true, summary: "FAILED (exit 1)\n1 failing", exitCode: 1, timedOut: false };
const launchFail: TestRunResult = {
  passed: false,
  ran: false,
  summary: "test command could not be launched (spawn ruff ENOENT) — fix the environment or config testCommand",
  exitCode: null,
  timedOut: false,
};
const timedOut: TestRunResult = {
  passed: false,
  ran: true,
  summary: "TIMED OUT after 300000ms — not adjudicated, fix loop skipped",
  exitCode: null,
  timedOut: true,
};

/** git runner: dirty by default; returns a canned diff for `diff --cached`. */
function makeGitRaw(diff = "diff --git a/x b/x\n+changed") {
  return vi.fn(async (_repo: string, args: string[]) => {
    if (args[0] === "status") return " M server/x.ts\n";
    if (args[0] === "rev-parse") return "headsha000\n";
    if (args[0] === "diff") return diff;
    return "";
  });
}

function makeDeps(over: Record<string, unknown> = {}) {
  return {
    createWorktree: vi.fn(async () => FAKE_WT),
    removeWorktree: vi.fn(async () => undefined),
    resolveDefaultBranchFn: vi.fn(async () => "main"),
    runCoder: vi.fn(async () => ({ ok: true, summary: "edited", tokensUsed: 5 })),
    push: vi.fn(async () => ({ ok: true as const, branch: BRANCH })),
    openPr: vi.fn(async () => ({ ok: true as const, prUrl: "https://github.com/x/y/pull/9" })),
    gitRaw: makeGitRaw(),
    getSkills: vi.fn(async () => [] as Skill[]),
    ...over,
  };
}

const prBody = (deps: ReturnType<typeof makeDeps>) =>
  (deps.openPr as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;

// ─── Manual-ops ───────────────────────────────────────────────────────────────

describe("Stage B — manual-ops routing", () => {
  it("SKIPS the coder for a manual-ops AP and SURFACES it (never green); a code AP still ships", async () => {
    const runCoder = vi.fn(async () => ({ ok: true, summary: "edited", tokensUsed: 1 }));
    const deps = makeDeps({ runCoder });
    const res = await runSdlcHandoff(
      baseReq({
        perCriterionMethod: true,
        actionPoints: [
          AP({ title: "Rotate the leaked secret", priority: "P0", verificationMethod: "manual-ops", acceptanceCriterion: "the key is revoked" }),
          AP({ title: "Add the redactor", priority: "P1", verificationMethod: "test-run" }),
        ],
      }),
      deps as never,
    );
    // The coder ran for the CODE AP only (never for the manual-ops AP).
    for (const call of runCoder.mock.calls) {
      expect((call[1] as ActionPoint[])[0].title).not.toMatch(/Rotate the leaked secret/);
    }
    // A PR opened (the code AP committed); the manual-ops AP produced NO commit.
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
    const body = prBody(deps);
    expect(body).toMatch(/Manual operations required/);
    expect(body).toMatch(/Rotate the leaked secret/);
    expect(body).toMatch(/manual op — needs human/);
  });

  it("manual-ops is EXCLUDED from the green/red counters and counted separately in testSummary", async () => {
    const runTests = vi.fn(async () => pass); // the code AP's test run is green
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(
      baseReq({
        perCriterionMethod: true,
        archetype: "repo-assessment", // ⇒ verify context available for the code AP
        verification: VCFG(),
        actionPoints: [
          AP({ title: "Rotate secret", priority: "P0", verificationMethod: "manual-ops", acceptanceCriterion: "revoked" }),
          AP({ title: "Gate coverage in CI", priority: "P0", verificationMethod: "test-run", acceptanceCriterion: "coverage gate present" }),
        ],
      }),
      deps as never,
    );
    // Only the code AP counts toward the mechanical green/red total (1/1), NOT the manual op.
    expect(res.testSummary).toMatch(/Per-criterion verification: 1\/1 green/);
    expect(res.testSummary).toMatch(/1 manual-ops surfaced/);
    // The manual-op criterion in the trace is NEVER green.
    const manualLeaf = res.executionTrace?.controller.workers
      .flatMap((w) => w.criteria)
      .find((c) => c.method === "manual-ops");
    expect(manualLeaf).toBeDefined();
    expect(manualLeaf?.passed).toBe(false);
    expect(manualLeaf?.ran).toBe(false);
  });

  it("SWITCH OFF ⇒ byte-identical: a manual-ops-labelled AP still runs the coder (method ignored)", async () => {
    const runCoder = vi.fn(async () => ({ ok: true, summary: "edited", tokensUsed: 1 }));
    const deps = makeDeps({ runCoder });
    await runSdlcHandoff(
      // perCriterionMethod omitted (default off)
      baseReq({ actionPoints: [AP({ title: "Rotate secret", verificationMethod: "manual-ops" })] }),
      deps as never,
    );
    expect(runCoder).toHaveBeenCalledTimes(1); // the coder DID run (method ignored)
  });
});

// ─── Judge method ───────────────────────────────────────────────────────────

describe("Stage B — judge-method verifier", () => {
  const judgeReq = (verificationMethod: ActionPoint["verificationMethod"] = "judge") =>
    baseReq({
      perCriterionMethod: true,
      archetype: null, // single unskilled coder → 1 coder call, then the judge verifier
      actionPoints: [AP({ title: "Improve the README clarity", verificationMethod, acceptanceCriterion: "README explains setup" })],
    });

  it("runs the coder, then grades the DIFF; passed = verifier verdict-green", async () => {
    const judgeVerify: JudgeVerifyFn = vi.fn(async () => ({ passed: true, summary: "the diff adds a setup section" }));
    const deps = makeDeps({ judgeVerify });
    const res = await runSdlcHandoff(judgeReq(), deps as never);
    // The verifier saw the AP's diff (captured via `git diff --cached`).
    expect(judgeVerify).toHaveBeenCalledTimes(1);
    const input = (judgeVerify as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(input.criterion).toMatch(/README explains setup/);
    expect(input.diff).toMatch(/\+changed/);
    const leaf = res.executionTrace?.controller.workers.flatMap((w) => w.criteria).find((c) => c.method === "judge");
    expect(leaf?.passed).toBe(true);
    expect(leaf?.ran).toBe(true);
  });

  it("verifier REFUTES (passed:false) ⇒ criterion not green; PR flags the unmet P0", async () => {
    const judgeVerify: JudgeVerifyFn = vi.fn(async () => ({ passed: false, summary: "the diff only adds a TODO" }));
    const deps = makeDeps({ judgeVerify });
    const res = await runSdlcHandoff(judgeReq(), deps as never);
    const leaf = res.executionTrace?.controller.workers.flatMap((w) => w.criteria).find((c) => c.method === "judge");
    expect(leaf?.passed).toBe(false);
    expect(prBody(deps)).toMatch(/Verification gate: FLAGGED/);
  });

  it("NO verifier wired ⇒ not-run, not-passed (refute-by-default), NEVER green", async () => {
    const deps = makeDeps(); // no judgeVerify
    const res = await runSdlcHandoff(judgeReq(), deps as never);
    const leaf = res.executionTrace?.controller.workers.flatMap((w) => w.criteria).find((c) => c.method === "judge");
    expect(leaf?.passed).toBe(false);
    expect(leaf?.ran).toBe(false);
    expect(leaf?.summary).toMatch(/judge verifier unavailable/);
  });

  it("a verifier THROW ⇒ not-passed (refute-by-default)", async () => {
    const judgeVerify: JudgeVerifyFn = vi.fn(async () => {
      throw new Error("gateway 503 at /srv/model");
    });
    const deps = makeDeps({ judgeVerify });
    const res = await runSdlcHandoff(judgeReq(), deps as never);
    const leaf = res.executionTrace?.controller.workers.flatMap((w) => w.criteria).find((c) => c.method === "judge");
    expect(leaf?.passed).toBe(false);
    expect(leaf?.ran).toBe(false);
  });
});

// ─── Lint-clean in the coder's green ────────────────────────────────────────

describe("Stage B — lint-clean folded into the coder's green", () => {
  /** runTests fake that answers per COMMAND: the test command vs the lint command. */
  function byCommand(map: { test: TestRunResult[]; lint: TestRunResult[] }) {
    let ti = 0;
    let li = 0;
    return vi.fn(async (opts: { testCommand: string | null }) => {
      if (opts.testCommand === "uv run ruff format --check .") return map.lint[Math.min(li++, map.lint.length - 1)];
      return map.test[Math.min(ti++, map.test.length - 1)];
    });
  }

  const lintReq = (over: Partial<VerificationConfig> = {}) =>
    baseReq({
      archetype: "repo-assessment",
      verification: VCFG({ lintCommand: "uv run ruff format --check .", ...over }),
      actionPoints: [AP({ acceptanceCriterion: "the parser is fixed" })],
    });

  it("test green + lint RED → fix loop (lint prompt) → lint green ⇒ criterion GREEN", async () => {
    // test always green; lint fails once, then passes after the fix.
    const runTests = byCommand({ test: [pass], lint: [fail, pass] });
    const runCoder = vi.fn(async () => ({ ok: true, summary: "edited", tokensUsed: 1 }));
    const deps = makeDeps({ runTests, runCoder });
    const res = await runSdlcHandoff(lintReq(), deps as never);
    // The fix coder was re-invoked with a LINT-specific prompt.
    const fixCalls = runCoder.mock.calls.filter((c) => /lint\/format check is currently FAILING/i.test((c[2] as { systemPrompt?: string })?.systemPrompt ?? ""));
    expect(fixCalls.length).toBeGreaterThanOrEqual(1);
    // Final criterion is GREEN (both test + lint pass) after 1 fix.
    const leaf = res.executionTrace?.controller.workers.flatMap((w) => w.criteria).find((c) => c.method === "test-run");
    expect(leaf?.passed).toBe(true);
    expect(leaf?.fixIterations).toBe(1);
  });

  it("lint SPAWN failure (ran:false) ⇒ NOT-RUN, fix loop SKIPPED", async () => {
    const runTests = byCommand({ test: [pass], lint: [launchFail] });
    const runCoder = vi.fn(async () => ({ ok: true, summary: "edited", tokensUsed: 1 }));
    const deps = makeDeps({ runTests, runCoder });
    const res = await runSdlcHandoff(lintReq(), deps as never);
    const leaf = res.executionTrace?.controller.workers.flatMap((w) => w.criteria).find((c) => c.method === "test-run");
    expect(leaf?.ran).toBe(false);
    expect(leaf?.passed).toBe(false);
    // NO lint fix invocation (a launch failure is an env problem no code change fixes).
    const fixCalls = runCoder.mock.calls.filter((c) => /lint\/format/i.test((c[2] as { systemPrompt?: string })?.systemPrompt ?? ""));
    expect(fixCalls).toHaveLength(0);
  });

  it("lint TIMEOUT ⇒ NOT-ADJUDICATED, fix loop SKIPPED", async () => {
    const runTests = byCommand({ test: [pass], lint: [timedOut] });
    const runCoder = vi.fn(async () => ({ ok: true, summary: "edited", tokensUsed: 1 }));
    const deps = makeDeps({ runTests, runCoder });
    const res = await runSdlcHandoff(lintReq(), deps as never);
    const leaf = res.executionTrace?.controller.workers.flatMap((w) => w.criteria).find((c) => c.method === "test-run");
    expect(leaf?.timedOut).toBe(true);
    expect(leaf?.passed).toBe(false);
    const fixCalls = runCoder.mock.calls.filter((c) => /lint\/format/i.test((c[2] as { systemPrompt?: string })?.systemPrompt ?? ""));
    expect(fixCalls).toHaveLength(0);
  });

  it("lintCommand UNSET ⇒ only the test runs (byte-identical to the pre-lint path)", async () => {
    const runTests = vi.fn(async () => pass);
    const deps = makeDeps({ runTests });
    await runSdlcHandoff(
      baseReq({ archetype: "repo-assessment", verification: VCFG(), actionPoints: [AP({ acceptanceCriterion: "fixed" })] }),
      deps as never,
    );
    // No lint command ⇒ the runner is called ONLY for the test command.
    for (const call of (runTests as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0].testCommand).toBe("npm test");
    }
  });

  it("lint runs in FINAL verification too (whole-suite green requires lint-clean)", async () => {
    const runTests = byCommand({ test: [pass], lint: [pass] });
    const deps = makeDeps({ runTests });
    // AP WITHOUT a criterion ⇒ NO per-AP verify; every runTests call is the FINAL phase.
    await runSdlcHandoff(
      baseReq({
        archetype: "repo-assessment",
        verification: VCFG({ lintCommand: "uv run ruff format --check ." }),
        finalVerification: { enabled: true, maxFinalFixIterations: 1 },
        actionPoints: [AP()], // no acceptanceCriterion
      }),
      deps as never,
    );
    // The FINAL re-verification ran BOTH the test command AND the lint command.
    const calls = (runTests as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].testCommand);
    expect(calls).toContain("npm test");
    expect(calls).toContain("uv run ruff format --check .");
  });

  it("exposes the manual-ops constants for the PR body/tests", () => {
    expect(MANUAL_OPS_SUMMARY).toMatch(/human operation/);
    expect(MANUAL_OPS_NOTE).toMatch(/surfaced for a human/);
  });
});
