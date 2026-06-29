/**
 * executor.test.ts — SDLC orchestration (component 5).
 *
 * Drives `runSdlcHandoff` over FULLY injected seams (worktree / coder / push /
 * openPr / git runner) — no real repo, no claude, no gh. Load-bearing:
 *   - CLEANUP GUARANTEE: the worktree is removed even when the coder THROWS
 *     (timeout / binary missing) — the removal runs in a `finally`.
 *   - the handoff NEVER throws — every failure degrades to `{ prRef:null, ... }`.
 *   - BRANCH GATING: a non-uuid loopId yields a non-B-3 branch → rejected BEFORE
 *     a worktree is ever cut.
 *   - happy path → `{ prRef:<url>, headCommit }`; the commit/PR title are
 *     server-derived (no model text); untrusted titles only reach the commit body.
 *   - no-changes / push-fail / pr-fail degrade correctly and STILL clean up.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runSdlcHandoff,
  buildCommitMessage,
  buildPrTitle,
  type SdlcHandoffRequest,
} from "../../../server/services/sdlc/executor.js";
import type { ActionPoint } from "@shared/types";

const LOOP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const REPO = "/allowlisted/omniscience";
const ROOTS = ["/allowlisted"];
const BRANCH = `consilium/loop-${LOOP}/round-2`;

const APS: ActionPoint[] = [
  { title: "Fix `;rm -rf /` in parser\nwith newline", priority: "P0" },
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

/** git runner whose `status --porcelain` reports `hasChanges`. */
function makeGitRaw(hasChanges: boolean) {
  return vi.fn(async (_repo: string, args: string[]) => {
    if (args[0] === "status") return hasChanges ? " M server/x.ts\n" : "";
    if (args[0] === "rev-parse") return "headsha000\n";
    return "";
  });
}

function makeDeps(over: Record<string, unknown> = {}) {
  return {
    createWorktree: vi.fn(async () => FAKE_WT),
    removeWorktree: vi.fn(async () => undefined),
    resolveDefaultBranchFn: vi.fn(async () => "main"),
    runCoder: vi.fn(async () => ({ ok: true, summary: "edited 2 files", tokensUsed: 5 })),
    push: vi.fn(async () => ({ ok: true as const, branch: BRANCH })),
    openPr: vi.fn(async () => ({ ok: true as const, prUrl: "https://github.com/x/y/pull/9" })),
    gitRaw: makeGitRaw(true),
    ...over,
  };
}

describe("runSdlcHandoff — cleanup guarantee", () => {
  it("removes the worktree even when the coder THROWS (finally)", async () => {
    const deps = makeDeps({
      runCoder: vi.fn(async () => {
        throw new Error("CLI timed out after 600000ms at /home/u/.claude");
      }),
    });
    const res = await runSdlcHandoff(baseReq(), deps as never);
    // No throw — degraded result.
    expect(res.prRef).toBeNull();
    expect(res.error).toBeDefined();
    expect(res.error).not.toContain("/home/u"); // fs layout scrubbed
    // The worktree was STILL removed.
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
    expect(deps.removeWorktree).toHaveBeenCalledWith(REPO, FAKE_WT.worktreeDir, expect.objectContaining({ baseDir: FAKE_WT.baseDir }));
  });

  it("removes the worktree on the happy path too", async () => {
    const deps = makeDeps();
    const res = await runSdlcHandoff(baseReq(), deps as never);
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
    expect(res.headCommit).toBe("headsha000");
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
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

  it("commit subject is server-fixed; untrusted titles only in the sanitized body", () => {
    const { subject, body } = buildCommitMessage(2, APS);
    expect(subject).toBe("consilium: SDLC changes for round 2");
    expect(subject).not.toMatch(/rm -rf/);
    // The body carries the title but with control chars / newlines stripped.
    expect(body).toContain("Add the redactor");
    expect(body).not.toMatch(/\n.*rm -rf.*\n.*with newline/); // newline inside title collapsed
  });
});

describe("runSdlcHandoff — degraded paths still clean up", () => {
  it("no changes produced → no PR, error note, worktree removed", async () => {
    const deps = makeDeps({ gitRaw: makeGitRaw(false) });
    const res = await runSdlcHandoff(baseReq(), deps as never);
    expect(res.prRef).toBeNull();
    expect(res.error).toMatch(/no changes/);
    expect(deps.openPr).not.toHaveBeenCalled();
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
  });

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
