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
  type SdlcProgress,
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

describe("runSdlcHandoff — progress reporting (onProgress)", () => {
  /** Collect a deep copy of every beat (the executor may reuse fields across emits). */
  function collect() {
    const events: SdlcProgress[] = [];
    return { events, onProgress: (p: SdlcProgress) => events.push({ ...p }) };
  }

  it("emits coding+committing per AP with INCREASING index, then pushing→opening_pr→done", async () => {
    const deps = makeDeps(); // both APs dirty → both commit
    const { events, onProgress } = collect();
    await runSdlcHandoff(baseReq(), deps as never, onProgress);

    const phases = events.map((e) => e.phase);
    // One coding + one committing beat per AP (both committed), then the tail phases.
    expect(phases.filter((p) => p === "coding")).toHaveLength(APS.length);
    expect(phases.filter((p) => p === "committing")).toHaveLength(APS.length);
    expect(phases).toContain("pushing");
    expect(phases).toContain("opening_pr");
    // The LAST beat is the terminal "done".
    expect(phases[phases.length - 1]).toBe("done");

    // coding indices increase 1..N and carry the right total.
    const codingIdx = events.filter((e) => e.phase === "coding").map((e) => e.actionPointIndex);
    expect(codingIdx).toEqual([1, 2]);
    expect(events.every((e) => e.actionPointTotal === APS.length)).toBe(true);

    // completedCount climbs as commits land: AP1 coding sees 0 committed, AP2 coding sees 1.
    const coding = events.filter((e) => e.phase === "coding");
    expect(coding[0].completedCount).toBe(0);
    expect(coding[1].completedCount).toBe(1);
    // The terminal beat reports all N committed.
    expect(events[events.length - 1]).toMatchObject({
      phase: "done",
      actionPointIndex: APS.length,
      actionPointTotal: APS.length,
      completedCount: APS.length,
    });
  });

  it("CLAMPS + control-strips the UNTRUSTED action-point title in every coding beat", async () => {
    const deps = makeDeps();
    const { events, onProgress } = collect();
    await runSdlcHandoff(baseReq(), deps as never, onProgress);

    const coding0 = events.find((e) => e.phase === "coding" && e.actionPointIndex === 1)!;
    // APS[0].title carries shell metachars + a newline — survives ONLY control-stripped.
    expect(coding0.actionPointTitle).not.toMatch(/[\n\r]/);
    expect(coding0.actionPointTitle).toBe("Fix `;rm -rf /` in parser with newline");
    // The tail phases carry no AP title.
    expect(events.find((e) => e.phase === "pushing")!.actionPointTitle).toBe("");
    expect(events.find((e) => e.phase === "done")!.actionPointTitle).toBe("");
  });

  it("a THROWING onProgress sink never breaks the executor's NEVER-THROWS guarantee", async () => {
    const deps = makeDeps();
    const res = await runSdlcHandoff(baseReq(), deps as never, () => {
      throw new Error("malicious progress sink");
    });
    // The run still completes + opens the PR; the bad sink is swallowed.
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("omitting onProgress (the consilium LOOP path) is a zero-behavior-change no-op", async () => {
    const deps = makeDeps();
    const res = await runSdlcHandoff(baseReq(), deps as never);
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
    expect(res.headCommit).toBe("headsha000");
  });

  it("ZERO-commit round still emits a terminal done (no pushing/opening_pr beats)", async () => {
    // Nothing dirty → no commits → no push/PR — but the terminal done still fires.
    const deps = makeDeps({ gitRaw: makeGitRaw(false) });
    const { events, onProgress } = collect();
    await runSdlcHandoff(baseReq(), deps as never, onProgress);
    const phases = events.map((e) => e.phase);
    expect(phases).toContain("coding");
    expect(phases).not.toContain("committing"); // never reached the commit step
    expect(phases).not.toContain("pushing");
    expect(phases).not.toContain("opening_pr");
    expect(phases[phases.length - 1]).toBe("done");
    expect(events[events.length - 1].completedCount).toBe(0);
  });
});

describe("runSdlcHandoff — LIVE per-AP task list (progress.aps)", () => {
  function collect() {
    const events: SdlcProgress[] = [];
    // Deep-copy each beat (the tracker deep-copies `aps` per beat, but be defensive).
    return {
      events,
      onProgress: (p: SdlcProgress) => events.push(JSON.parse(JSON.stringify(p)) as SdlcProgress),
    };
  }

  it("carries the FULL action-point list on every beat and transitions statuses live", async () => {
    const deps = makeDeps(); // both APs dirty → both commit → both `completed`
    const { events, onProgress } = collect();
    await runSdlcHandoff(baseReq(), deps as never, onProgress);

    // Every beat carries the whole list, in order, with stable 1-based indices.
    for (const e of events) {
      expect(e.aps).toBeDefined();
      expect(e.aps!.map((a) => a.i)).toEqual([1, 2]);
    }

    // AP1 is `active` while it is coded; AP2 is still `pending`.
    const coding1 = events.find((e) => e.phase === "coding" && e.actionPointIndex === 1)!;
    expect(coding1.aps!.map((a) => a.status)).toEqual(["active", "pending"]);
    expect(coding1.step).toBe("coder"); // unskilled path ⇒ single coder step
    expect(coding1.fixIteration).toBe(0);
    expect(coding1.fixBudget).toBeUndefined(); // verification off

    // By the time AP2 is coded, AP1 has settled to `completed`.
    const coding2 = events.find((e) => e.phase === "coding" && e.actionPointIndex === 2)!;
    expect(coding2.aps!.map((a) => a.status)).toEqual(["completed", "active"]);

    // The terminal beat shows BOTH settled.
    expect(events[events.length - 1].aps!.map((a) => a.status)).toEqual(["completed", "completed"]);
  });

  it("SANITIZES + clamps the UNTRUSTED titles carried in the aps list", async () => {
    const deps = makeDeps();
    const { events, onProgress } = collect();
    await runSdlcHandoff(baseReq(), deps as never, onProgress);
    // APS[0].title has shell metachars + a newline — control-stripped, no newline.
    const list = events[0].aps!;
    expect(list[0].title).toBe("Fix `;rm -rf /` in parser with newline");
    expect(list[0].title).not.toMatch(/[\n\r]/);
    expect(list[1].title).toBe("Add the redactor");
  });

  it("marks partial-preserve and failed APs with the right live status", async () => {
    // Both APs throw. Dirty worktree → committed [partial]; nothing dirty → failed.
    const throwing = vi.fn(async () => {
      throw new Error("CLI timed out at /home/u/.claude");
    });
    const partialDeps = makeDeps({ runCoder: throwing });
    const p = collect();
    await runSdlcHandoff(baseReq(), partialDeps as never, p.onProgress);
    expect(p.events[p.events.length - 1].aps!.map((a) => a.status)).toEqual(["partial", "partial"]);

    const failedDeps = makeDeps({ runCoder: throwing, gitRaw: makeGitRaw(false) });
    const f = collect();
    await runSdlcHandoff(baseReq(), failedDeps as never, f.onProgress);
    expect(f.events[f.events.length - 1].aps!.map((a) => a.status)).toEqual(["failed", "failed"]);
  });

  it("caps the aps list defensively at 100 entries", async () => {
    const many: ActionPoint[] = Array.from({ length: 101 }, (_, i) => ({
      title: `AP ${i}`,
      priority: "P2",
    }));
    const deps = makeDeps();
    const { events, onProgress } = collect();
    await runSdlcHandoff(baseReq({ actionPoints: many }), deps as never, onProgress);
    expect(events[0].aps).toHaveLength(100);
    expect(events[0].aps![99].i).toBe(100);
  });
});

// ─── §3E verify-before-merge — base→round integration merge ─────────────────────

/** A git runner that discriminates the integration calls. A real content CONFLICT is modeled
 *  the way the production runner (simple-git `.raw`) actually behaves: `merge` does NOT throw —
 *  it returns the "CONFLICT …" text and leaves an UNMERGED index (`ls-files --unmerged`
 *  non-empty). `commandError` models a merge that genuinely throws (malformed cmd / bad ref)
 *  with NO unmerged entries. Records every call for assertion. */
function makeIntegGitRaw(opts: { conflict?: boolean; commandError?: boolean; remoteResolves?: boolean } = {}) {
  return vi.fn(async (_repo: string, args: string[]) => {
    if (args[0] === "status") return " M server/x.ts\n"; // dirty → commits happen
    if (args[0] === "fetch") return "";
    if (args[0] === "ls-files" && args.includes("--unmerged")) {
      // Unmerged index entries exist ONLY for a real content conflict.
      return opts.conflict ? "100644 aaa 1\tserver/x.ts\n100644 bbb 2\tserver/x.ts\n" : "";
    }
    if (args[0] === "rev-parse") {
      // The caller's plain `rev-parse HEAD` (no --verify) → the round HEAD.
      if (args.includes("HEAD") && !args.includes("--verify")) return "headsha000\n";
      // The helper resolves the base via rev-parse VERIFY mode (single-object, no flag echo).
      if (args.includes("--verify")) return opts.remoteResolves === false ? "" : "basesha111\n";
      return "";
    }
    if (args[0] === "merge") {
      if (args[1] === "--abort") return "";
      if (opts.commandError) throw new Error("--end-of-options basesha111 - not something we can merge");
      // simple-git `.raw` does NOT reject on a content conflict — it resolves with the text.
      if (opts.conflict) return "CONFLICT (content): Merge conflict in server/x.ts\n";
      return "";
    }
    return "";
  });
}

describe("runSdlcHandoff — §3E integration merge (integrateBase)", () => {
  it("integrateBase=true, CLEAN merge: merges the base INTO the round branch, pushes, returns integrationBase", async () => {
    const gitRaw = makeIntegGitRaw();
    const deps = makeDeps({ gitRaw });
    const res = await runSdlcHandoff(baseReq({ integrateBase: true }), deps as never);
    // A merge of the resolved base ran before the push.
    const merged = gitRaw.mock.calls.find((c) => (c[1] as string[])[0] === "merge" && (c[1] as string[]).includes("basesha111"));
    expect(merged).toBeDefined();
    expect(res.prRef).toBe("https://github.com/x/y/pull/9"); // PR still opened
    expect(res.integrationBase).toBe("basesha111"); // baseline the controller diffs against
    expect(res.integrationConflict).toBeUndefined();
    expect(deps.push).toHaveBeenCalledTimes(1);
  });

  it("integrateBase=true, CONFLICT: aborts the merge, surfaces the error, NEVER pushes a broken merge", async () => {
    const gitRaw = makeIntegGitRaw({ conflict: true });
    const deps = makeDeps({ gitRaw });
    const res = await runSdlcHandoff(baseReq({ integrateBase: true }), deps as never);
    expect(res.prRef).toBeNull();
    expect(res.integrationConflict).toBe(true);
    expect(res.error).toContain("integration conflict");
    // The merge was aborted and NOTHING was pushed / PR'd (no silent broken-merge landing).
    expect(gitRaw.mock.calls.some((c) => (c[1] as string[])[0] === "merge" && (c[1] as string[])[1] === "--abort")).toBe(true);
    expect(deps.push).not.toHaveBeenCalled();
    expect(deps.openPr).not.toHaveBeenCalled();
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1); // cleanup still guaranteed
  });

  it("integrateBase=true, COMMAND ERROR: reported as 'could not run' NOT a conflict, never pushes", async () => {
    // A merge that fails for a NON-content reason (malformed cmd / unresolvable ref) leaves no
    // unmerged entries — it must be classified distinctly so the operator is not told there's a
    // conflict when the command was simply wrong. Still aborts + falls back safely (no PR).
    const gitRaw = makeIntegGitRaw({ commandError: true });
    const deps = makeDeps({ gitRaw });
    const res = await runSdlcHandoff(baseReq({ integrateBase: true }), deps as never);
    expect(res.prRef).toBeNull();
    expect(res.integrationConflict).toBeFalsy(); // NOT flagged a conflict
    expect(res.error).toContain("integration could not run");
    expect(res.error).not.toContain("integration conflict");
    expect(deps.push).not.toHaveBeenCalled();
    expect(deps.openPr).not.toHaveBeenCalled();
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1); // cleanup still guaranteed
  });

  it("integrateBase absent (default): NO fetch/merge runs — byte-identical to today", async () => {
    const gitRaw = makeIntegGitRaw();
    const deps = makeDeps({ gitRaw });
    const res = await runSdlcHandoff(baseReq(), deps as never); // integrateBase omitted
    expect(gitRaw.mock.calls.some((c) => (c[1] as string[])[0] === "fetch")).toBe(false);
    expect(gitRaw.mock.calls.some((c) => (c[1] as string[])[0] === "merge")).toBe(false);
    expect(res.integrationBase).toBeUndefined();
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
  });
})
