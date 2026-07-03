/**
 * parallel-develop.test.ts — wave-scheduled, dependency-aware develop (design §4).
 *
 * Drives `runSdlcHandoff` with `parallel.enabled` over FULLY injected seams (per-AP
 * worktree create/remove, coder, push, openPr, git runner). Load-bearing / adversarial:
 *   - OFF (default) ⇒ BYTE-IDENTICAL sequential path: ONE worktree, NO `ap-` branch, NO
 *     merge — proof the feature is inert when disabled.
 *   - ON, independent APs ⇒ N per-AP worktrees (each on a `…/round-<n>-ap-<k>` SIBLING branch
 *     off the integration HEAD) merged back into the ROUND branch; ONE PR from the round branch.
 *   - CONCURRENCY is bounded by `maxConcurrency` (risk e).
 *   - MERGE CONFLICT (risk c) ⇒ the AP is re-run on the integrated tree, its work SURFACED
 *     (note mentions the conflict), never silently dropped.
 *   - worktree cleanup is UNCONDITIONAL — one remove per created worktree, even on throw.
 *   - the wall-clock DEADLINE (risk a/b) settles remaining APs as failed, opens no PR.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runSdlcHandoff,
  type SdlcHandoffRequest,
} from "../../../server/services/sdlc/executor.js";
import type { ActionPoint } from "@shared/types";

const LOOP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const REPO = "/allowlisted/omniscience";
const ROOTS = ["/allowlisted"];
const ROUND = 2;
const ROUND_BRANCH = `consilium/loop-${LOOP}/round-${ROUND}`;

const TWO_INDEP: ActionPoint[] = [
  { title: "Fix parser", priority: "P0" },
  { title: "Add redactor", priority: "P1" },
];

const baseReq = (over: Partial<SdlcHandoffRequest> = {}): SdlcHandoffRequest => ({
  repoPath: REPO,
  loopId: LOOP,
  round: ROUND,
  actionPoints: TWO_INDEP,
  allowedRepoPaths: ROOTS,
  ...over,
});

/** A createWorktree whose dir/baseDir ENCODE the branch, so commit/merge calls can be
 *  attributed to the integration worktree vs. a specific per-AP worktree. */
function makeCreateWorktree() {
  return vi.fn(async (opts: { branch: string; baseRef?: string }) => ({
    worktreeDir: `/tmp/tree/${opts.branch}`,
    baseDir: `/tmp/base/${opts.branch}`,
    branch: opts.branch,
    baseRef: opts.baseRef ?? "main",
  }));
}

/** git runner: `status` = dirty, `rev-parse` = a sha, `merge` = clean unless `conflictOn`
 *  matches the ap-branch arg (then it throws like a real conflict). Records all calls. */
function makeGitRaw(opts: { conflictOn?: RegExp } = {}) {
  return vi.fn(async (_repo: string, args: string[]) => {
    if (args[0] === "status") return " M server/x.ts\n";
    if (args[0] === "rev-parse") return "headsha000\n";
    if (args[0] === "merge" && args[1] === "--no-ff") {
      const branch = args[3];
      if (opts.conflictOn && opts.conflictOn.test(branch)) {
        throw new Error(`CONFLICT (content): Merge conflict in server/x.ts`);
      }
      return "";
    }
    return "";
  });
}

function makeDeps(over: Record<string, unknown> = {}) {
  return {
    createWorktree: makeCreateWorktree(),
    removeWorktree: vi.fn(async () => undefined),
    resolveDefaultBranchFn: vi.fn(async () => "main"),
    runCoder: vi.fn(async () => ({ ok: true, summary: "edited", tokensUsed: 5 })),
    push: vi.fn(async () => ({ ok: true as const, branch: ROUND_BRANCH })),
    openPr: vi.fn(async () => ({ ok: true as const, prUrl: "https://github.com/x/y/pull/9" })),
    gitRaw: makeGitRaw(),
    ...over,
  };
}

/** All branches ever handed to createWorktree, in call order. */
const createdBranches = (deps: ReturnType<typeof makeDeps>): string[] =>
  (deps.createWorktree as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { branch: string }).branch);

/** All `git merge --no-ff` target branches. */
const mergedBranches = (deps: ReturnType<typeof makeDeps>): string[] =>
  (deps.gitRaw as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => (c[1] as string[])[0] === "merge" && (c[1] as string[])[1] === "--no-ff")
    .map((c) => (c[1] as string[])[3]);

describe("parallel OFF (default) — byte-identical sequential path", () => {
  it("cuts ONE worktree, NO ap-branch, NO merge", async () => {
    const deps = makeDeps();
    const res = await runSdlcHandoff(baseReq(), deps as never); // parallel absent
    expect(createdBranches(deps)).toEqual([ROUND_BRANCH]); // exactly one worktree
    expect(createdBranches(deps).some((b) => /-ap-\d+$/.test(b))).toBe(false);
    expect(mergedBranches(deps)).toHaveLength(0);
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("explicit { enabled:false } is also the sequential path", async () => {
    const deps = makeDeps();
    await runSdlcHandoff(baseReq({ parallel: { enabled: false, maxConcurrency: 3 } }), deps as never);
    expect(createdBranches(deps)).toEqual([ROUND_BRANCH]);
    expect(mergedBranches(deps)).toHaveLength(0);
  });

  it("single-AP round takes the sequential path even when parallel is ON", async () => {
    const deps = makeDeps();
    await runSdlcHandoff(
      baseReq({ actionPoints: [{ title: "only one", priority: "P0" }], parallel: { enabled: true, maxConcurrency: 3 } }),
      deps as never,
    );
    expect(createdBranches(deps)).toEqual([ROUND_BRANCH]); // no fan-out for a single AP
    expect(mergedBranches(deps)).toHaveLength(0);
  });
});

describe("parallel ON — wave fan-out + merge", () => {
  it("cuts an integration worktree + one per-AP worktree, merges each ap-branch back", async () => {
    const deps = makeDeps();
    const res = await runSdlcHandoff(
      baseReq({ parallel: { enabled: true, maxConcurrency: 3 } }),
      deps as never,
    );
    const branches = createdBranches(deps);
    // integration (round) branch first, then one per-AP branch each.
    expect(branches[0]).toBe(ROUND_BRANCH);
    expect(branches).toContain(`${ROUND_BRANCH}-ap-1`);
    expect(branches).toContain(`${ROUND_BRANCH}-ap-2`);
    expect(branches).toHaveLength(3);
    // Both ap-branches merged back into the integration branch, in deterministic order.
    expect(mergedBranches(deps)).toEqual([`${ROUND_BRANCH}-ap-1`, `${ROUND_BRANCH}-ap-2`]);
    // ONE PR, opened from the round (integration) branch.
    expect(deps.openPr).toHaveBeenCalledTimes(1);
    const [dir, prOpts] = (deps.openPr as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(dir).toBe(`/tmp/tree/${ROUND_BRANCH}`); // pushed from the integration worktree
    expect(prOpts.head).toBe(ROUND_BRANCH);
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
  });

  it("removes EVERY worktree it created (unconditional cleanup) — integration + per-AP", async () => {
    const deps = makeDeps();
    await runSdlcHandoff(baseReq({ parallel: { enabled: true, maxConcurrency: 3 } }), deps as never);
    // 2 per-AP worktrees + 1 integration worktree = 3 removals.
    expect(deps.removeWorktree).toHaveBeenCalledTimes(3);
  });

  it("bounds concurrency by maxConcurrency (risk e)", async () => {
    let inFlight = 0;
    let peak = 0;
    const runCoder = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { ok: true, summary: "edited", tokensUsed: 1 };
    });
    const threeIndep: ActionPoint[] = [
      { title: "A", priority: "P0" },
      { title: "B", priority: "P0" },
      { title: "C", priority: "P0" },
    ];
    const deps = makeDeps({ runCoder });
    await runSdlcHandoff(
      baseReq({ actionPoints: threeIndep, parallel: { enabled: true, maxConcurrency: 2 } }),
      deps as never,
    );
    expect(peak).toBeLessThanOrEqual(2); // never more than the cap in flight at once
    expect(runCoder).toHaveBeenCalledTimes(3); // all three still ran
  });

  it("respects judge-declared dependencies — a dependent AP runs in a LATER wave", async () => {
    // B depends on A (#1): A must be merged before B's worktree is cut off the integration
    // HEAD. Observe: A's ap-1 branch is merged BEFORE B's ap-2 worktree is created.
    const order: string[] = [];
    const createWorktree = vi.fn(async (opts: { branch: string; baseRef?: string }) => {
      order.push(`create:${opts.branch}`);
      return { worktreeDir: `/tmp/tree/${opts.branch}`, baseDir: `/tmp/base/${opts.branch}`, branch: opts.branch, baseRef: opts.baseRef ?? "main" };
    });
    const gitRaw = vi.fn(async (_repo: string, args: string[]) => {
      if (args[0] === "status") return " M x\n";
      if (args[0] === "rev-parse") return "headsha000\n";
      if (args[0] === "merge" && args[1] === "--no-ff") {
        order.push(`merge:${args[3]}`);
        return "";
      }
      return "";
    });
    const deps = makeDeps({ createWorktree, gitRaw });
    const aps: ActionPoint[] = [
      { title: "A", priority: "P0" },
      { title: "B", priority: "P0", dependsOn: [1] },
    ];
    await runSdlcHandoff(baseReq({ actionPoints: aps, parallel: { enabled: true, maxConcurrency: 3 } }), deps as never);
    const mergeA = order.indexOf(`merge:${ROUND_BRANCH}-ap-1`);
    const createB = order.indexOf(`create:${ROUND_BRANCH}-ap-2`);
    expect(mergeA).toBeGreaterThanOrEqual(0);
    expect(createB).toBeGreaterThan(mergeA); // B fanned out only AFTER A merged
  });
});

describe("parallel ON — adversarial", () => {
  it("MERGE CONFLICT (risk c) ⇒ the AP is re-run on the integrated tree and SURFACED", async () => {
    // ap-1 conflicts on merge → abort → fallback re-run on the integration worktree.
    const gitRaw = makeGitRaw({ conflictOn: /-ap-1$/ });
    const deps = makeDeps({ gitRaw });
    const res = await runSdlcHandoff(
      baseReq({ parallel: { enabled: true, maxConcurrency: 3 } }),
      deps as never,
    );
    // The conflicting merge was attempted then aborted.
    const g = deps.gitRaw as ReturnType<typeof vi.fn>;
    expect(g.mock.calls.some((c) => (c[1] as string[])[0] === "merge" && (c[1] as string[])[1] === "--abort")).toBe(true);
    // A fallback commit ran ON THE INTEGRATION worktree (not a per-AP dir).
    const integrationCommits = g.mock.calls.filter(
      (c) => c[0] === `/tmp/tree/${ROUND_BRANCH}` && (c[1] as string[])[0] === "commit",
    );
    expect(integrationCommits.length).toBeGreaterThanOrEqual(1);
    // The PR opens; the conflicted AP's note surfaces the conflict (never silent — risk c).
    const [, prOpts] = (deps.openPr as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(prOpts.body).toMatch(/merge conflict/i);
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
  });

  it("FAIL-LOUD FALLBACK ⇒ when EVERY per-AP worktree setup fails, degrade to the sequential path (no empty PR)", async () => {
    // Simulate the fan-out breakage class (the shipped D/F-ref bug): createWorktree SUCCEEDS
    // for the round (integration) branch but THROWS for every per-AP branch. With 0 commits on
    // the integration branch + setup failures, the executor must fall back to sequential and
    // still produce a PR — not an empty 0-commit result.
    const createWorktree = vi.fn(async (opts: { branch: string; baseRef?: string }) => {
      if (/-ap-\d+$/.test(opts.branch)) throw new Error("fatal: cannot lock ref (simulated D/F)");
      return { worktreeDir: `/tmp/tree/${opts.branch}`, baseDir: `/tmp/base/${opts.branch}`, branch: opts.branch, baseRef: opts.baseRef ?? "main" };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = makeDeps({ createWorktree });
    const res = await runSdlcHandoff(baseReq({ parallel: { enabled: true, maxConcurrency: 3 } }), deps as never);

    // The fan-out was attempted (per-AP creates threw) THEN the sequential path ran on the
    // integration worktree, committing both APs there.
    const integrationCommits = (deps.gitRaw as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === `/tmp/tree/${ROUND_BRANCH}` && (c[1] as string[])[0] === "commit",
    );
    expect(integrationCommits.length).toBe(2); // both APs committed sequentially on the integration tree
    // NO merge was performed (sequential path merges nothing) and a PR still opened.
    expect(mergedBranches(deps)).toHaveLength(0);
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
    // The degrade was surfaced LOUDLY.
    expect(warn.mock.calls.some((c) => /FALLING BACK to.*sequential/i.test(String(c[0])))).toBe(true);
    warn.mockRestore();
  });

  it("NO double-run: a PARTIAL fan-out (some APs committed) does NOT trigger the sequential fallback", async () => {
    // ap-2's worktree create throws, but ap-1 fans out + merges fine (committedCount > 0), so the
    // guard must NOT re-run the whole round sequentially (that would double-apply ap-1).
    const createWorktree = vi.fn(async (opts: { branch: string; baseRef?: string }) => {
      if (/-ap-2$/.test(opts.branch)) throw new Error("fatal: cannot lock ref (simulated)");
      return { worktreeDir: `/tmp/tree/${opts.branch}`, baseDir: `/tmp/base/${opts.branch}`, branch: opts.branch, baseRef: opts.baseRef ?? "main" };
    });
    const deps = makeDeps({ createWorktree });
    const res = await runSdlcHandoff(baseReq({ parallel: { enabled: true, maxConcurrency: 3 } }), deps as never);
    // ap-1 merged via the fan-out; ap-2 surfaced as failed. NO sequential re-commit on the
    // integration worktree (the fan-out path never commits directly on it).
    expect(mergedBranches(deps)).toEqual([`${ROUND_BRANCH}-ap-1`]);
    const integrationCommits = (deps.gitRaw as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === `/tmp/tree/${ROUND_BRANCH}` && (c[1] as string[])[0] === "commit",
    );
    expect(integrationCommits).toHaveLength(0);
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
  });

  it("wall-clock DEADLINE (risk a/b) ⇒ remaining APs failed, no PR, worktrees still cleaned", async () => {
    // now(): first call (deadline compute) = 0 ⇒ deadline = +budget; subsequent = huge ⇒
    // the first wave check trips immediately, no AP runs.
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(9_000_000_000);
    const deps = makeDeps({ now });
    const res = await runSdlcHandoff(
      baseReq({ parallel: { enabled: true, maxConcurrency: 3 } }),
      deps as never,
    );
    expect(deps.runCoder).not.toHaveBeenCalled(); // nothing started
    expect(res.prRef).toBeNull(); // zero commits → no PR
    expect(res.error).toBeTruthy();
    // The integration worktree is still removed in the outer finally.
    expect(deps.removeWorktree).toHaveBeenCalled();
  });
});
