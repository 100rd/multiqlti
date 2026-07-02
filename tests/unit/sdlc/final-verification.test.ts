/**
 * final-verification.test.ts — Stage A: the executor's FINAL-STATE re-verification.
 *
 * Action points are implemented SEQUENTIALLY in ONE shared worktree, so a LATER AP can
 * regress what an EARLIER AP's per-criterion tests verified. Stage A re-runs the WHOLE
 * suite ONCE against the FINAL combined tree (after the last AP, before the PR), with a
 * bounded fix loop. The subprocess is mocked (injected runTests).
 *
 * Asserts:
 *   - DISABLED (finalVerification null/absent) ⇒ ZERO behavior change: no extra test run,
 *     no final fix, no final block in the PR body / testSummary / trace.
 *   - GATED: the SAME sandbox gate as per-AP verification — with verification OFF (no
 *     verify context) final verification NEVER runs even if its own flag is on.
 *   - PASS: one final run, GREEN in the PR body + [PASS] in the round testSummary.
 *   - FAIL→FIX→GREEN: the bounded fix loop re-invokes the implementer (fenced failure
 *     summary) with the FULL action-point set, commits the fix, reaches green.
 *   - REGRESSION (budget exhausted): the PR still opens (Draft), FLAGGED RED; the trace
 *     criterion shows passed:true but passedAtFinal:false.
 *   - VERIFY-ONLY (maxFinalFixIterations=0): records the outcome, attempts NO fix.
 *   - the whole-run wall-clock budget short-circuits final fixes.
 *   - NEVER blocks PR creation.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runSdlcHandoff,
  type SdlcHandoffRequest,
  type VerificationConfig,
  type FinalVerificationConfig,
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

const FVCFG = (over: Partial<FinalVerificationConfig> = {}): FinalVerificationConfig => ({
  enabled: true,
  maxFinalFixIterations: 1,
  ...over,
});

/** An AP WITHOUT an acceptance criterion ⇒ NO per-AP verification runs, so every
 *  runTests call in these tests comes PURELY from the final re-verification. */
const AP = (over: Partial<ActionPoint> = {}): ActionPoint => ({
  title: "Fix the parser",
  priority: "P0",
  rationale: "bug",
  ...over,
});

const baseReq = (over: Partial<SdlcHandoffRequest> = {}): SdlcHandoffRequest => ({
  repoPath: REPO,
  loopId: LOOP,
  round: 2,
  actionPoints: [AP()],
  allowedRepoPaths: ["/allowlisted"],
  archetype: "repo-assessment", // ⇒ skilled steps ⇒ a verify context can be built
  verification: VCFG(),
  ...over,
});

const pass: TestRunResult = { passed: true, ran: true, summary: "PASSED\nall green", exitCode: 0, timedOut: false };
const fail: TestRunResult = { passed: false, ran: true, summary: "FAILED (exit 1)\n1 failing", exitCode: 1, timedOut: false };
const notRun: TestRunResult = { passed: false, ran: false, summary: "not verified — no test command", exitCode: null, timedOut: false };
/** The reported bug: the final command could NOT be LAUNCHED (env broken). ran:false ⇒
 *  the final fix loop must be SKIPPED (no code change makes an unlaunchable command run). */
const launchFail: TestRunResult = {
  passed: false,
  ran: false,
  summary: "test command could not be launched (spawn uv ENOENT) — fix the environment or config testCommand",
  exitCode: null,
  timedOut: false,
};
/** Finding #6 at the final phase: the whole-suite final run was KILLED by the wall-clock
 *  cap. ran:true but AMBIGUOUS/UNADJUDICATED ⇒ the final fix loop must be SKIPPED. */
const timedOut: TestRunResult = {
  passed: false,
  ran: true,
  summary:
    "TIMED OUT after 300000ms — suite may exceed testRunTimeoutMs (raise the cap for a slow suite) or the change introduced a hang; not adjudicated, fix loop skipped",
  exitCode: null,
  timedOut: true,
};

function makeGitRaw() {
  return vi.fn(async (_repo: string, args: string[]) => {
    if (args[0] === "status") return " M server/x.ts\n";
    if (args[0] === "rev-parse") return "headsha000\n";
    return "";
  });
}

/** Commit [subject, body] pairs the git runner was asked to make. */
function commitMessages(gitRaw: ReturnType<typeof vi.fn>): Array<{ subject: string; body: string }> {
  return gitRaw.mock.calls
    .filter((c) => (c[1] as string[])[0] === "commit")
    .map((c) => ({ subject: (c[1] as string[])[2], body: (c[1] as string[])[4] }));
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

/** A runTests fake returning a SCRIPTED sequence (then repeats the last entry). */
function sequencedRunTests(seq: TestRunResult[]) {
  let i = 0;
  return vi.fn(async () => seq[Math.min(i++, seq.length - 1)]);
}

const prBody = (deps: ReturnType<typeof makeDeps>) =>
  (deps.openPr as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;

describe("Stage A — DISABLED ⇒ zero behavior change", () => {
  it("finalVerification null ⇒ NO final test run, NO final block anywhere", async () => {
    const runTests = vi.fn(async () => pass);
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(baseReq({ finalVerification: null }), deps as never);
    // AP has no criterion ⇒ no per-AP verify; final off ⇒ runTests NEVER called.
    expect(runTests).not.toHaveBeenCalled();
    // 2 skilled steps × 1 AP, no final fix invocations.
    expect((deps.runCoder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(res.finalVerification).toBeUndefined();
    expect(res.testSummary).toBeUndefined();
    expect(prBody(deps)).not.toMatch(/Final-state re-verification/);
    // No final-fix commit — only the AP commit exists.
    expect(commitMessages(deps.gitRaw as ReturnType<typeof vi.fn>)).toHaveLength(1);
  });

  it("finalVerification.enabled:false ⇒ NO final test run", async () => {
    const runTests = vi.fn(async () => pass);
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(baseReq({ finalVerification: FVCFG({ enabled: false }) }), deps as never);
    expect(runTests).not.toHaveBeenCalled();
    expect(res.finalVerification).toBeUndefined();
  });
});

describe("Stage A — sandbox gate (same as per-AP verification)", () => {
  it("verification OFF (no verify context) ⇒ final verification NEVER runs even if its flag is on", async () => {
    const runTests = vi.fn(async () => pass);
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(
      baseReq({ verification: null, finalVerification: FVCFG({ enabled: true }) }),
      deps as never,
    );
    expect(runTests).not.toHaveBeenCalled();
    expect(res.finalVerification).toBeUndefined();
  });

  it("no skilled steps (archetype null) ⇒ no verify context ⇒ no final verification", async () => {
    const runTests = vi.fn(async () => pass);
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(
      baseReq({ archetype: null, finalVerification: FVCFG({ enabled: true }) }),
      deps as never,
    );
    expect(runTests).not.toHaveBeenCalled();
    expect(res.finalVerification).toBeUndefined();
  });
});

describe("Stage A — PASS", () => {
  it("runs the final suite ONCE; GREEN in the PR body + [PASS] in the testSummary", async () => {
    const runTests = sequencedRunTests([pass]);
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(baseReq({ finalVerification: FVCFG() }), deps as never);
    expect(runTests).toHaveBeenCalledTimes(1); // one final run, no per-AP verify
    // The final run uses the CONFIG test command + timeout (never AP text).
    const arg = runTests.mock.calls[0][0] as { testCommand: string | null; timeoutMs: number; worktreeDir: string };
    expect(arg.testCommand).toBe("npm test");
    expect(arg.worktreeDir).toBe(WT);
    expect(res.finalVerification).toEqual(
      expect.objectContaining({ method: "test-run", ran: true, passed: true, fixIterations: 0 }),
    );
    expect(prBody(deps)).toMatch(/Final-state re-verification: GREEN/);
    expect(res.testSummary).toMatch(/Final-state re-verification: \[PASS\]/);
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
  });
});

describe("Stage A — FAIL → bounded fix loop → GREEN", () => {
  it("re-invokes the implementer with the FULL AP set + fenced summary, commits the fix, reaches green", async () => {
    const runTests = sequencedRunTests([fail, pass]); // final#0 fail → fix → re-verify pass
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(
      baseReq({ finalVerification: FVCFG({ maxFinalFixIterations: 1 }) }),
      deps as never,
    );
    expect(runTests).toHaveBeenCalledTimes(2); // initial final + one re-verify
    const coderCalls = (deps.runCoder as ReturnType<typeof vi.fn>).mock.calls;
    // 2 skilled steps + 1 final fix = 3 coder calls.
    expect(coderCalls).toHaveLength(3);
    const fixCall = coderCalls[2];
    // The final fix is handed the ROUND's full action-point set (not a single criterion).
    expect(fixCall[0]).toBe(WT);
    expect(Array.isArray(fixCall[1])).toBe(true);
    expect(fixCall[1]).toHaveLength(1); // baseReq carries one action point
    const opts = fixCall[2] as { systemPrompt: string };
    expect(opts.systemPrompt).toMatch(/tests are currently FAILING/i);
    expect(opts.systemPrompt).toContain("1 failing"); // fenced failure summary
    expect(res.finalVerification).toEqual(
      expect.objectContaining({ ran: true, passed: true, fixIterations: 1 }),
    );
    // The final fix lands as its own server-fixed commit.
    const commits = commitMessages(deps.gitRaw as ReturnType<typeof vi.fn>);
    expect(commits.some((c) => c.subject.includes("final-state re-verification fixes"))).toBe(true);
  });
});

describe("Stage A — REGRESSION (budget exhausted): Draft still opens, FLAGGED", () => {
  it("final never goes green ⇒ passed:false, PR body RED, but the PR still opens", async () => {
    const runTests = sequencedRunTests([fail]); // always fails
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(
      baseReq({ finalVerification: FVCFG({ maxFinalFixIterations: 1 }) }),
      deps as never,
    );
    // initial final + 1 fix re-verify = 2 runTests; budget caps further fixes.
    expect(runTests).toHaveBeenCalledTimes(2);
    expect(res.finalVerification).toEqual(expect.objectContaining({ passed: false, fixIterations: 1 }));
    expect(prBody(deps)).toMatch(/Final-state re-verification: RED/);
    expect(prBody(deps)).toMatch(/REGRESSION/);
    expect(res.testSummary).toMatch(/REGRESSION/);
    // NEVER blocks PR creation.
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
  });

  it("a per-AP criterion that passed at implement time shows passed:true but passedAtFinal:false", async () => {
    // AP WITH a criterion: per-AP verify passes; the FINAL suite then fails.
    const runTests = sequencedRunTests([pass, fail]); // per-AP pass, then final fail (repeats)
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(
      baseReq({
        actionPoints: [AP({ acceptanceCriterion: "When built Then compiles" })],
        finalVerification: FVCFG({ maxFinalFixIterations: 1 }),
      }),
      deps as never,
    );
    const crit = res.executionTrace!.controller.workers[0].criteria[0];
    expect(crit.method).toBe("test-run");
    expect(crit.passed).toBe(true); // green when the AP was implemented
    expect(crit.passedAtFinal).toBe(false); // regressed by the final combined state
    expect(res.finalVerification?.passed).toBe(false);
  });
});

describe("Stage A — VERIFY-ONLY (maxFinalFixIterations=0)", () => {
  it("records the failing outcome but attempts NO fix (no extra coder / re-run)", async () => {
    const runTests = sequencedRunTests([fail]);
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(
      baseReq({ finalVerification: FVCFG({ maxFinalFixIterations: 0 }) }),
      deps as never,
    );
    expect(runTests).toHaveBeenCalledTimes(1); // ONE final run, no re-verify
    expect((deps.runCoder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2); // skilled steps only
    expect(res.finalVerification).toEqual(expect.objectContaining({ passed: false, fixIterations: 0 }));
  });

  it("a non-running final command (not verified) is surfaced as NOT-RUN", async () => {
    const runTests = sequencedRunTests([notRun]);
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(
      baseReq({ finalVerification: FVCFG({ maxFinalFixIterations: 0 }) }),
      deps as never,
    );
    expect(res.finalVerification).toEqual(expect.objectContaining({ ran: false, passed: false }));
    expect(prBody(deps)).toMatch(/Final-state re-verification: NOT-RUN/);
  });
});

describe("Stage A — launch failure (ran:false) SKIPS the final fix loop", () => {
  it("a spawn-ENOENT final run burns ZERO final fix iterations even with budget left", async () => {
    // The bug at the final-verification phase: an env error must NOT enter the fix loop.
    const runTests = sequencedRunTests([launchFail]);
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(
      baseReq({ finalVerification: FVCFG({ maxFinalFixIterations: 3 }) }),
      deps as never,
    );
    // ONE final run; the loop is skipped (ran:false) despite a budget of 3.
    expect(runTests).toHaveBeenCalledTimes(1);
    // Only the 2 skilled implement steps; ZERO final fix coder re-invocations.
    expect((deps.runCoder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(res.finalVerification).toEqual(
      expect.objectContaining({ ran: false, passed: false, fixIterations: 0 }),
    );
    expect(prBody(deps)).toMatch(/Final-state re-verification: NOT-RUN/);
    // NEVER blocks PR creation.
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
  });
});

describe("Stage A — final-run TIMEOUT (ambiguous) SKIPS the final fix loop, NOT-ADJUDICATED", () => {
  it("a TIMED-OUT final run burns ZERO final fix iterations even with budget left (finding #6)", async () => {
    // The finding-#6 bug at the final phase: a timeout must NOT enter the fix loop — no
    // code change makes a config-level cap pass, and the next final run pays the same
    // wall-clock. With a budget of 3, the loop must be skipped entirely.
    const runTests = sequencedRunTests([timedOut]);
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(
      baseReq({ finalVerification: FVCFG({ maxFinalFixIterations: 3 }) }),
      deps as never,
    );
    // ONE final run; the loop is skipped (timedOut) despite a budget of 3.
    expect(runTests).toHaveBeenCalledTimes(1);
    // Only the 2 skilled implement steps; ZERO final fix coder re-invocations.
    expect((deps.runCoder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(res.finalVerification).toEqual(
      expect.objectContaining({ ran: true, passed: false, fixIterations: 0, timedOut: true }),
    );
    // NEVER blocks PR creation.
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
  });

  it("classifies the final block NOT-ADJUDICATED (timeout), never RED/REGRESSION", async () => {
    const runTests = sequencedRunTests([timedOut]);
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(
      baseReq({ finalVerification: FVCFG({ maxFinalFixIterations: 3 }) }),
      deps as never,
    );
    const body = prBody(deps);
    expect(body).toMatch(/Final-state re-verification: NOT-ADJUDICATED \(timeout\)/);
    expect(body).not.toMatch(/Final-state re-verification: RED/);
    expect(body).not.toMatch(/REGRESSION/);
    expect(body).toMatch(/not a confirmed regression/i);
    // The testSummary (convergence wire) grounds the next review on NOT-ADJUDICATED.
    expect(res.testSummary).toMatch(/NOT-ADJUDICATED \(timeout\)/);
    expect(res.testSummary).not.toMatch(/REGRESSION/);
  });

  it("does NOT stamp a bogus passedAtFinal:false when the FINAL run timed out (marks timedOut instead)", async () => {
    // AP WITH a criterion that PASSED at implement time; the final whole-suite run then
    // TIMES OUT. passedAtFinal must be OMITTED (unadjudicated — `false` would read as a
    // regression); the criterion is marked timedOut so the UI shows "not adjudicated".
    const runTests = sequencedRunTests([pass, timedOut]); // per-AP pass, then final timeout
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(
      baseReq({
        actionPoints: [AP({ acceptanceCriterion: "When built Then compiles" })],
        finalVerification: FVCFG({ maxFinalFixIterations: 3 }),
      }),
      deps as never,
    );
    const crit = res.executionTrace!.controller.workers[0].criteria[0];
    expect(crit.passed).toBe(true); // green when the AP was implemented
    expect(crit.timedOut).toBe(true); // final run unadjudicated
    expect("passedAtFinal" in crit).toBe(false); // NOT stamped (no bogus "regressed")
  });

  it("CONTRAST: a non-timeout final RED still enters the final fix loop", async () => {
    const runTests = sequencedRunTests([fail, pass]); // red → fix → pass
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(
      baseReq({ finalVerification: FVCFG({ maxFinalFixIterations: 3 }) }),
      deps as never,
    );
    expect(runTests).toHaveBeenCalledTimes(2); // initial + one re-verify
    expect(res.finalVerification).toEqual(expect.objectContaining({ passed: true, fixIterations: 1 }));
  });
});

describe("Stage A — live progress beat (was silent → looked like a frozen 'committing')", () => {
  function collect() {
    const events: SdlcProgress[] = [];
    return { events, onProgress: (p: SdlcProgress) => events.push(JSON.parse(JSON.stringify(p)) as SdlcProgress) };
  }

  it("emits a final-verification beat on start and per final fix iteration", async () => {
    const runTests = sequencedRunTests([fail, pass]); // final#0 fail → fix → re-verify pass
    const deps = makeDeps({ runTests });
    const { events, onProgress } = collect();
    await runSdlcHandoff(
      baseReq({ finalVerification: FVCFG({ maxFinalFixIterations: 2 }) }),
      deps as never,
      onProgress,
    );
    const finalBeats = events.filter((e) => e.phase === "final-verification");
    // start test-runner(0) → fix-coder(1) → re-verify test-runner(1).
    expect(finalBeats.map((e) => `${e.step}:${e.fixIteration}`)).toEqual([
      "test-runner:0",
      "fix-coder:1",
      "test-runner:1",
    ]);
    // The budget rides every final beat; it carries the AP total (no single AP).
    for (const e of finalBeats) {
      expect(e.fixBudget).toBe(2);
      expect(e.actionPointTotal).toBe(1);
      expect(e.actionPointTitle).toBe("");
    }
  });

  it("verify-only (0 fixes) still emits exactly one start beat", async () => {
    const runTests = sequencedRunTests([pass]);
    const deps = makeDeps({ runTests });
    const { events, onProgress } = collect();
    await runSdlcHandoff(
      baseReq({ finalVerification: FVCFG({ maxFinalFixIterations: 0 }) }),
      deps as never,
      onProgress,
    );
    const finalBeats = events.filter((e) => e.phase === "final-verification");
    expect(finalBeats.map((e) => `${e.step}:${e.fixIteration}`)).toEqual(["test-runner:0"]);
  });

  it("NO callback ⇒ the final phase is a complete no-op (never throws)", async () => {
    const runTests = sequencedRunTests([fail, pass]);
    const deps = makeDeps({ runTests });
    // No onProgress passed — must not throw and must still produce the final verification.
    const res = await runSdlcHandoff(
      baseReq({ finalVerification: FVCFG({ maxFinalFixIterations: 1 }) }),
      deps as never,
    );
    expect(res.finalVerification).toEqual(expect.objectContaining({ passed: true, fixIterations: 1 }));
  });
});

describe("Stage A — whole-run wall-clock budget", () => {
  it("short-circuits final fixes once the deadline is past", async () => {
    const runTests = sequencedRunTests([fail]); // would fix, but the clock is past the deadline
    // now(): T0 at ctx build (deadline = T0 + 2h), then a value 3h later ⇒ over budget.
    let calls = 0;
    const now = vi.fn(() => (calls++ === 0 ? 0 : 3 * 3_600_000));
    const deps = makeDeps({ runTests, now });
    const res = await runSdlcHandoff(
      baseReq({ finalVerification: FVCFG({ maxFinalFixIterations: 3 }) }),
      deps as never,
    );
    // Only the initial final run; the budget guard stopped before any fix re-invoke.
    expect(runTests).toHaveBeenCalledTimes(1);
    expect((deps.runCoder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2); // steps only
    expect(res.finalVerification).toEqual(expect.objectContaining({ passed: false, fixIterations: 0 }));
  });
});
