/**
 * sdlc-worktree-fanout.test.ts — REAL-GIT integration for parallel-develop fan-out.
 *
 * WHY THIS EXISTS (the incident it locks down): the parallel-develop fan-out shipped with a
 * per-AP branch shape `consilium/loop-<id>/round-<n>/ap-<k>` — a CHILD of the round branch.
 * git stores each branch as a loose ref FILE, so once the round branch `…/round-<n>` exists,
 * creating a child ref `…/round-<n>/ap-<k>` is a directory/file (D/F) conflict and
 * `git worktree add` fails with "cannot lock ref … exists; cannot create …". EVERY per-AP
 * worktree creation threw ⇒ every AP failed ⇒ ZERO branches, ZERO commits, integration stayed
 * at base. The fully-mocked unit tests never hit real git, so they MISSED it. This test drives
 * the REAL `createSdlcWorktree` / `removeSdlcWorktree` / git runner against a scratch repo, so
 * a regression to the child shape (or any real-git fan-out breakage) fails here deterministically.
 *
 * The only injected seams are the CODER (writes a file so the tree is dirty; the executor
 * stages + commits it) and push/openPr (no network). Everything git is real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, readFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile } from "fs/promises";
import {
  runSdlcHandoff,
  type SdlcHandoffRequest,
} from "../../server/services/sdlc/executor.js";
import type { ActionPoint } from "@shared/types";

const LOOP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ROUND = 1;
const ROUND_BRANCH = `consilium/loop-${LOOP}/round-${ROUND}`;

let repoDir: string;
let baseSha: string;

/** Run a real git command in `repoDir`, returning trimmed stdout. */
function git(...args: string[]): string {
  return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();
}

beforeEach(() => {
  // A scratch repo under the OS temp root, realpath'd so it agrees with the allowlist check
  // (assertAllowedRepoPath realpaths both sides — on macOS /var → /private/var).
  repoDir = realpathSync(mkdtempSync(join(tmpdir(), "sdlc-fanout-repo-")));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  execFileSync("git", ["-C", repoDir, "commit", "-q", "--allow-empty", "-m", "base"]);
  baseSha = git("rev-parse", "HEAD");
});

afterEach(() => {
  // Best-effort: drop any worktrees the run may have left, then the repo.
  try {
    execFileSync("git", ["-C", repoDir, "worktree", "prune"]);
  } catch {
    /* ignore */
  }
  rmSync(repoDir, { recursive: true, force: true });
});

/** Three independent APs, each writing a distinct file (via the fake coder). */
const APS: ActionPoint[] = [
  { title: "alpha", priority: "P0" },
  { title: "beta", priority: "P0" },
  { title: "gamma", priority: "P0" },
];

/** Fake coder: writes `<title>.txt` into the per-AP worktree so the executor commits it. */
function makeFileWritingCoder() {
  return vi.fn(async (worktreeDir: string, aps: readonly ActionPoint[]) => {
    const ap = aps[0];
    await writeFile(join(worktreeDir, `${ap.title}.txt`), `content for ${ap.title}\n`, "utf8");
    return { ok: true, summary: `wrote ${ap.title}.txt`, tokensUsed: 1 };
  });
}

function baseReq(over: Partial<SdlcHandoffRequest> = {}): SdlcHandoffRequest {
  return {
    repoPath: repoDir,
    loopId: LOOP,
    round: ROUND,
    actionPoints: APS,
    allowedRepoPaths: [repoDir],
    base: "main",
    baseRef: baseSha, // cut the integration branch off the base commit
    parallel: { enabled: true, maxConcurrency: 3 },
    ...over,
  };
}

function baseDeps(over: Record<string, unknown> = {}) {
  return {
    runCoder: makeFileWritingCoder(),
    push: vi.fn(async () => ({ ok: true as const, branch: ROUND_BRANCH })),
    openPr: vi.fn(async () => ({ ok: true as const, prUrl: "https://github.com/x/y/pull/1" })),
    resolveDefaultBranchFn: vi.fn(async () => "main"),
    // createWorktree / removeWorktree / gitRaw are the REAL defaults (not injected).
    ...over,
  };
}

describe("parallel-develop fan-out — REAL git", () => {
  it("creates a per-AP SIBLING branch, commits in each worktree, merges all into the integration branch", async () => {
    const deps = baseDeps();
    const res = await runSdlcHandoff(baseReq(), deps as never);

    // A PR opened ⇒ commits landed (pushAndOpenPr returns null on ZERO commits — the exact
    // symptom of the bug this locks down).
    expect(res.error).toBeUndefined();
    expect(res.prRef).toBe("https://github.com/x/y/pull/1");
    expect(res.headCommit).toMatch(/^[0-9a-f]{40}$/);

    // The integration branch ADVANCED past the base (git rev-list --count base..head > 0 was
    // literally 0 in the incident). Each AP = its own commit + a --no-ff merge commit ⇒ >= 3.
    const advanced = Number(git("rev-list", "--count", `${baseSha}..${res.headCommit}`));
    expect(advanced).toBeGreaterThanOrEqual(APS.length);

    // Every AP's file is present in the FINAL integration tree — all three merged in.
    const tree = git("ls-tree", "-r", "--name-only", res.headCommit).split("\n");
    expect(tree).toContain("alpha.txt");
    expect(tree).toContain("beta.txt");
    expect(tree).toContain("gamma.txt");
    // And the content is the coder's (proves the per-AP worktree edit reached the branch).
    expect(git("show", `${res.headCommit}:alpha.txt`)).toContain("content for alpha");

    // FAN-OUT actually ran (NOT the sequential fallback): the per-AP SIBLING branches exist.
    // Under the buggy CHILD shape (`…/round-1/ap-k`) none of these are ever created.
    const branches = git("branch", "--list", "--format=%(refname:short)").split("\n");
    expect(branches).toContain(`${ROUND_BRANCH}-ap-1`);
    expect(branches).toContain(`${ROUND_BRANCH}-ap-2`);
    expect(branches).toContain(`${ROUND_BRANCH}-ap-3`);
    // The coder ran once per AP in its OWN worktree (3 distinct dirs).
    const coderDirs = new Set(
      (deps.runCoder as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string),
    );
    expect(coderDirs.size).toBe(APS.length);

    // Cleanup held: NO leaked worktrees remain — only the main repo is registered.
    const worktrees = git("worktree", "list", "--porcelain")
      .split("\n")
      .filter((l) => l.startsWith("worktree "));
    expect(worktrees).toHaveLength(1);
  });

  it("dependency-aware waves: a dependent AP is merged after its prerequisite and still lands", async () => {
    // gamma (#3) depends on alpha (#1): alpha must merge before gamma's worktree is cut off the
    // integration HEAD. All three still land on the integration branch.
    const aps: ActionPoint[] = [
      { title: "alpha", priority: "P0" },
      { title: "beta", priority: "P0" },
      { title: "gamma", priority: "P0", dependsOn: [1] },
    ];
    const deps = baseDeps();
    const res = await runSdlcHandoff(baseReq({ actionPoints: aps }), deps as never);

    expect(res.prRef).toBe("https://github.com/x/y/pull/1");
    const tree = git("ls-tree", "-r", "--name-only", res.headCommit).split("\n");
    expect(tree).toEqual(expect.arrayContaining(["alpha.txt", "beta.txt", "gamma.txt"]));
    const worktrees = git("worktree", "list", "--porcelain")
      .split("\n")
      .filter((l) => l.startsWith("worktree "));
    expect(worktrees).toHaveLength(1);
  });
});
