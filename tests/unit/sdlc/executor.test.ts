/**
 * executor.test.ts — SDLC orchestration (component 5), PER-ACTION-POINT model.
 *
 * Drives `runSdlcHandoff` over FULLY injected seams (worktree / coder / push /
 * openPr / git runner) — no real repo, no claude, no gh. Load-bearing:
 *   - PER-AP loop: N action points → N coder runs + N commit attempts in ONE
 *     worktree, sequentially.
 *   - CONFIGURABLE timeout: `req.coderTimeoutMs` is threaded into every coder run.
 *   - PARTIAL PRESERVE: a coder run that THROWS (timeout) but left edits is still
 *     committed `[partial]` and the round still pushes + opens ONE Draft PR; the
 *     PR body summarizes per-AP status.
 *   - CLEANUP GUARANTEE: the worktree is removed even when a coder run throws.
 *   - the handoff NEVER throws; ZERO commits → `{ prRef:null, error }`.
 *   - BRANCH/PR title are server-derived; untrusted text only in commit/PR body.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runSdlcHandoff,
  buildApCommitMessage,
  buildPrStatusBody,
  buildPrTitle,
  type SdlcHandoffRequest,
  type ApOutcome,
} from "../../../server/services/sdlc/executor.js";
import type { ActionPoint } from "@shared/types";

const LOOP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const REPO = "/allowlisted/omniscience";
const ROOTS = ["/allowlisted"];
const BRANCH = `consilium/loop-${LOOP}/round-2`;

const APS: ActionPoint[] = [
  { title: "Fix `;rm -rf /` in parser\nwith newline", priority: "P0", rationale: "unsanitized\ninput" },
  { title: "Add the redactor", priority: "P1" },
];

const baseReq = (over: Partial<SdlcHandoffRequest> = {}): SdlcHandoffRequest => ({
  repoPath: REPO,
  loopId: LOOP,
  round: 2,
  actionPoints: APS,
  allowedRepoPaths: ROOTS,
  ...over,
});

const FAKE_WT = { worktreeDir: "/tmp/sdlc-wt-XXXX/tree", baseDir: "/tmp/sdlc-wt-XXXX", branch: BRANCH, baseRef: "main" };

/** git runner whose `status --porcelain` reports `hasChanges`; records all calls. */
function makeGitRaw(hasChanges: boolean) {
  return vi.fn(async (_repo: string, args: string[]) => {
    if (args[0] === "status") return hasChanges ? " M server/x.ts\n" : "";
    if (args[0] === "rev-parse") return "headsha000\n";
    return "";
  });
}

/** Commits the git runner was asked to make: [subject, body] pairs. */
function commitMessages(gitRaw: ReturnType<typeof vi.fn>): Array<{ subject: string; body: string }> {
  return gitRaw.mock.calls
    .filter((c) => (c[1] as string[])[0] === "commit")
    .map((c) => {
      const args = c[1] as string[];
      return { subject: args[2], body: args[4] };
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
    gitRaw: makeGitRaw(true),
    ...over,
  };
}

describe("runSdlcHandoff — per-action-point loop", () => {
  it("runs the coder ONCE PER action point (single-AP prompt) and commits each", async () => {
    const deps = makeDeps();
    const res = await runSdlcHandoff(baseReq(), deps as never);
    // N action points → N coder runs, each handed a SINGLE-element AP array.
    expect(deps.runCoder).toHaveBeenCalledTimes(APS.length);
    for (let i = 0; i < APS.length; i++) {
      const [dir, aps] = (deps.runCoder as ReturnType<typeof vi.fn>).mock.calls[i];
      expect(dir).toBe(FAKE_WT.worktreeDir);
      expect(aps).toHaveLength(1); // one action point per run
      expect(aps[0]).toBe(APS[i]);
    }
    // One commit per AP (all dirty), then ONE PR aggregating them.
    expect(commitMessages(deps.gitRaw as ReturnType<typeof vi.fn>)).toHaveLength(APS.length);
    expect(deps.openPr).toHaveBeenCalledTimes(1);
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
    expect(res.headCommit).toBe("headsha000");
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("threads the CONFIGURABLE per-AP timeout into every coder run", async () => {
    const deps = makeDeps();
    await runSdlcHandoff(baseReq({ coderTimeoutMs: 1_234_000 }), deps as never);
    for (const call of (deps.runCoder as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[2]?.timeoutMs).toBe(1_234_000);
    }
  });
});

describe("runSdlcHandoff — partial preserve on timeout/error", () => {
  it("a coder run that THROWS but left edits is committed [partial]; the round STILL opens a PR", async () => {
    // AP0 runs clean; AP1 times out (throws) but the worktree is dirty → its work
    // is preserved as a [partial] commit. The round still pushes + opens ONE PR.
    const runCoder = vi
      .fn()
      .mockImplementationOnce(async () => ({ ok: true, summary: "did ap0", tokensUsed: 1 }))
      .mockImplementationOnce(async () => {
        throw new Error("CLI timed out after 1200000ms at /home/u/.claude");
      });
    const deps = makeDeps({ runCoder });
    const res = await runSdlcHandoff(baseReq(), deps as never);

    const commits = commitMessages(deps.gitRaw as ReturnType<typeof vi.fn>);
    expect(commits).toHaveLength(2); // BOTH APs committed — partial work preserved
    const partial = commits.find((c) => c.body.includes("[partial]"));
    expect(partial).toBeDefined();
    expect(partial?.body).not.toContain("/home/u"); // scrubbed note
    // The PR still opens, aggregating the work.
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
    const [, opts] = (deps.openPr as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.body).toMatch(/\[completed\]/);
    expect(opts.body).toMatch(/\[partial\]/);
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("ZERO commits (all runs failed, nothing staged) → prRef null + error, worktree removed", async () => {
    const runCoder = vi.fn(async () => {
      throw new Error("CLI binary not installed");
    });
    const deps = makeDeps({ runCoder, gitRaw: makeGitRaw(false) }); // nothing dirty
    const res = await runSdlcHandoff(baseReq(), deps as never);
    expect(res.prRef).toBeNull();
    expect(res.error).toMatch(/no commits/);
    expect(deps.openPr).not.toHaveBeenCalled();
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
  });
});

describe("runSdlcHandoff — cleanup guarantee", () => {
  it("removes the worktree even when a coder run throws (finally)", async () => {
    const deps = makeDeps({
      runCoder: vi.fn(async () => {
        throw new Error("CLI timed out after 1200000ms at /home/u/.claude");
      }),
      gitRaw: makeGitRaw(false), // no edits preserved → no PR, but cleanup still runs
    });
    const res = await runSdlcHandoff(baseReq(), deps as never);
    expect(res.prRef).toBeNull();
    expect(res.error).not.toContain("/home/u"); // scrubbed
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
    expect(deps.removeWorktree).toHaveBeenCalledWith(REPO, FAKE_WT.worktreeDir, expect.objectContaining({ baseDir: FAKE_WT.baseDir }));
  });
});

describe("runSdlcHandoff — branch gating", () => {
  it("REJECTS a non-uuid loopId (non-B-3 branch) BEFORE cutting a worktree", async () => {
    const deps = makeDeps();
    const res = await runSdlcHandoff(baseReq({ loopId: "not-a-uuid" }), deps as never);
    expect(res.prRef).toBeNull();
    expect(res.error).toMatch(/B-3/);
    expect(deps.createWorktree).not.toHaveBeenCalled();
    expect(deps.removeWorktree).not.toHaveBeenCalled();
  });

  it("REJECTS an empty action-point list before cutting a worktree", async () => {
    const deps = makeDeps();
    const res = await runSdlcHandoff(baseReq({ actionPoints: [] }), deps as never);
    expect(res.prRef).toBeNull();
    expect(res.error).toMatch(/no action points/);
    expect(deps.createWorktree).not.toHaveBeenCalled();
  });
});

describe("runSdlcHandoff — server-derived branch/PR title, untrusted text quarantined", () => {
  it("opens the Draft PR with a server-derived title + head, never model text", async () => {
    const deps = makeDeps();
    await runSdlcHandoff(baseReq(), deps as never);
    expect(deps.openPr).toHaveBeenCalledTimes(1);
    const [, opts] = (deps.openPr as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.title).toBe(buildPrTitle(2));
    expect(opts.title).not.toMatch(/rm -rf/); // no action-point text in the title
    expect(opts.head).toBe(BRANCH); // server-derived branch
    expect(opts.base).toBe("main");
  });
});

describe("runSdlcHandoff — degraded paths still clean up", () => {
  it("push fail → branch-only, openPr NOT attempted, worktree removed", async () => {
    const deps = makeDeps({ push: vi.fn(async () => ({ ok: false, kind: "unknown", message: "no remote" })) });
    const res = await runSdlcHandoff(baseReq(), deps as never);
    expect(res.prRef).toBeNull();
    expect(res.error).toMatch(/push failed/);
    expect(deps.openPr).not.toHaveBeenCalled();
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("gh fail → branch pushed, prRef null, headCommit kept, worktree removed", async () => {
    const deps = makeDeps({ openPr: vi.fn(async () => ({ ok: false, kind: "gh-failed", message: "gh unauth" })) });
    const res = await runSdlcHandoff(baseReq(), deps as never);
    expect(res.prRef).toBeNull();
    expect(res.headCommit).toBe("headsha000");
    expect(res.error).toMatch(/open PR manually/);
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
  });
});

describe("buildApCommitMessage — server-fixed subject, sanitized untrusted body", () => {
  const ap: ActionPoint = { title: "Fix `;rm -rf /`\nthing", priority: "P0", rationale: "because\nreasons" };

  it("subject is the server shape `Consilium round N: <prio> <clamped title>` (single line)", () => {
    const { subject } = buildApCommitMessage(2, ap, 1, 3, false);
    expect(subject.startsWith("Consilium round 2: P0 ")).toBe(true);
    expect(subject).toContain("Fix `;rm -rf /` thing"); // control chars / newline collapsed
    expect(subject).not.toContain("\n");
  });

  it("body carries the sanitized title + rationale (newlines collapsed)", () => {
    const { body } = buildApCommitMessage(2, ap, 1, 3, false);
    expect(body).toContain("Fix `;rm -rf /` thing");
    expect(body).toContain("Rationale: because reasons");
    expect(body).toContain("Action point 1/3 (priority P0)");
    expect(body).not.toContain("[partial]");
  });

  it("a partial run adds the [partial] marker + a sanitized note", () => {
    // buildApCommitMessage sanitizes (control-strips) but does NOT path-scrub —
    // runActionPoint scrubs the throw message before passing it as the note.
    const { body } = buildApCommitMessage(2, ap, 2, 3, true, "coder timed out");
    expect(body).toContain("[partial] coder run timed out or errored");
    expect(body).toContain("Note: coder timed out");
  });
});

describe("buildPrStatusBody — enriched header + addressed action points + outcome table", () => {
  const outcomes: ApOutcome[] = [
    { index: 1, priority: "P0", title: "alpha", status: "completed", committed: true },
    { index: 2, priority: "P0", title: "beta", status: "partial", committed: true, note: "coder timed out" },
    { index: 3, priority: "P1", title: "gamma", status: "failed", committed: false, note: "no changes" },
  ];

  it("renders provenance header (loop/round/repo), the per-AP outcome table + footer", () => {
    const body = buildPrStatusBody({
      loopId: LOOP,
      round: 2,
      repoName: "omniscience",
      actionPoints: APS,
      outcomes,
    });
    // Header provenance — server-controlled values.
    expect(body).toContain("Automated SDLC Draft PR");
    expect(body).toContain(`Loop: \`${LOOP}\``);
    expect(body).toContain("Round: 2");
    expect(body).toContain("Repo: `omniscience`");
    // Per-AP outcome table (unchanged shape).
    expect(body).toContain("2/3 produced commits");
    expect(body).toContain("[completed] (P0) alpha");
    expect(body).toContain("[partial] (P0) beta — coder timed out");
    expect(body).toContain("[failed] (P1) gamma — no changes");
    // Footer — paused human gate.
    expect(body).toContain("paused at the human gate");
  });

  it("lists the verdict's action points addressed (priority + clamped title + 1-line rationale), control-stripped", () => {
    const body = buildPrStatusBody({
      loopId: LOOP,
      round: 2,
      repoName: "omniscience",
      actionPoints: APS, // APS[0] has shell metachars + newlines in title/rationale
      outcomes,
    });
    expect(body).toContain("Action points addressed");
    // Untrusted title/rationale survive ONLY control-stripped (newlines collapsed).
    expect(body).toContain("1. [P0] Fix `;rm -rf /` in parser with newline — unsanitized input");
    expect(body).toContain("2. [P1] Add the redactor");
    // The clamp/strip removed the raw newline — no multi-line injection.
    expect(body).not.toContain("parser\nwith");
  });

  it("degrades to '_none recorded_' when there are no action points", () => {
    const body = buildPrStatusBody({ loopId: LOOP, round: 2, repoName: "r", actionPoints: [], outcomes });
    expect(body).toContain("_none recorded_");
  });
});
