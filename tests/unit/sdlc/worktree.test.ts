/**
 * worktree.test.ts — SDLC worktree lifecycle (component 1).
 *
 * Drives `createSdlcWorktree` / `removeSdlcWorktree` / `resolveDefaultBranch`
 * over an injected ARG-ARRAY git runner + a fake `mkdtemp` — no real repo, no
 * real worktree on disk. Load-bearing assertions:
 *   - BRANCH-NAME GATING (B-3): a non-`consilium/loop-<uuid>/round-<n>` branch
 *     (and a leading-dash branch) is REJECTED before any git command runs.
 *   - the repo is re-validated against the fail-closed allowlist (H-5).
 *   - an unsafe `baseRef` (leading dash / `..`) is rejected.
 *   - the worktree dir is the server-minted temp dir (NEVER the user's checkout)
 *     and `git worktree add` gets the gated branch + baseRef as POSITIONALS.
 *   - `removeSdlcWorktree` NEVER throws (finally-safe cleanup).
 */
import { describe, it, expect, vi } from "vitest";
import {
  createSdlcWorktree,
  removeSdlcWorktree,
  resolveDefaultBranch,
  type GitRunner,
} from "../../../server/services/sdlc/worktree.js";

const LOOP = "11111111-2222-3333-4444-555555555555";
const REPO = "/allowlisted/omniscience";
const ROOTS = ["/allowlisted"];
const BRANCH = `consilium/loop-${LOOP}/round-2`;

/** A git runner that records calls and returns canned stdout per subcommand. */
function fakeGit(over: (args: string[]) => string | Promise<string> = () => ""): {
  raw: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const raw: GitRunner = async (_repo, args) => {
    calls.push(args);
    return over(args);
  };
  return { raw, calls };
}

const fakeMkdtemp = vi.fn(async (_prefix: string) => "/tmp/sdlc-wt-XXXX");

describe("createSdlcWorktree — gating", () => {
  it("REJECTS a non-B-3 branch before any git runs", async () => {
    const git = fakeGit();
    await expect(
      createSdlcWorktree({
        repoPath: REPO,
        branch: "feature/evil; rm -rf /", // not the server-derived shape
        allowedRepoPaths: ROOTS,
        gitRaw: git.raw,
        mkdtempFn: fakeMkdtemp,
      }),
    ).rejects.toThrow(/B-3/);
    expect(git.calls).toHaveLength(0); // gate is BEFORE git
  });

  it("REJECTS a leading-dash branch (flag-injection shape)", async () => {
    const git = fakeGit();
    await expect(
      createSdlcWorktree({
        repoPath: REPO,
        branch: "--upload-pack=evil",
        allowedRepoPaths: ROOTS,
        gitRaw: git.raw,
        mkdtempFn: fakeMkdtemp,
      }),
    ).rejects.toThrow(/B-3/);
    expect(git.calls).toHaveLength(0);
  });

  it("REJECTS a repo outside the fail-closed allowlist (H-5)", async () => {
    const git = fakeGit();
    await expect(
      createSdlcWorktree({
        repoPath: "/etc",
        branch: BRANCH,
        allowedRepoPaths: ROOTS,
        gitRaw: git.raw,
        mkdtempFn: fakeMkdtemp,
      }),
    ).rejects.toThrow(/repo-allowlist|allowlist|outside/);
    expect(git.calls).toHaveLength(0);
  });

  it("REJECTS an empty allowlist (fail-closed)", async () => {
    const git = fakeGit();
    await expect(
      createSdlcWorktree({ repoPath: REPO, branch: BRANCH, allowedRepoPaths: [], gitRaw: git.raw, mkdtempFn: fakeMkdtemp }),
    ).rejects.toThrow();
    expect(git.calls).toHaveLength(0);
  });

  it("REJECTS an unsafe baseRef (leading dash)", async () => {
    const git = fakeGit();
    await expect(
      createSdlcWorktree({
        repoPath: REPO,
        branch: BRANCH,
        baseRef: "--output=/evil",
        allowedRepoPaths: ROOTS,
        gitRaw: git.raw,
        mkdtempFn: fakeMkdtemp,
      }),
    ).rejects.toThrow(/baseRef/);
  });
});

describe("createSdlcWorktree — happy path", () => {
  it("creates the worktree under the server-minted temp dir with the gated positionals", async () => {
    const git = fakeGit();
    const res = await createSdlcWorktree({
      repoPath: REPO,
      branch: BRANCH,
      baseRef: "main",
      allowedRepoPaths: ROOTS,
      gitRaw: git.raw,
      mkdtempFn: fakeMkdtemp,
    });
    // The worktree dir is INSIDE the mkdtemp dir — never the user's checkout.
    expect(res.worktreeDir.startsWith("/tmp/sdlc-wt-XXXX")).toBe(true);
    expect(res.worktreeDir).not.toContain("omniscience");
    expect(res.branch).toBe(BRANCH);
    expect(res.baseRef).toBe("main");

    const add = git.calls.find((c) => c[0] === "worktree" && c[1] === "add");
    expect(add).toBeDefined();
    // `-b <branch> <path> <baseRef>` — branch + baseRef are gated positionals.
    expect(add).toEqual(["worktree", "add", "-b", BRANCH, res.worktreeDir, "main"]);
  });

  it("recovers from an already-existing branch via `-B`", async () => {
    let firstAdd = true;
    const git = fakeGit((args) => {
      if (args[0] === "worktree" && args[1] === "add" && args[2] === "-b" && firstAdd) {
        firstAdd = false;
        throw new Error("fatal: a branch named '...' already exists");
      }
      return "";
    });
    const res = await createSdlcWorktree({
      repoPath: REPO,
      branch: BRANCH,
      baseRef: "main",
      allowedRepoPaths: ROOTS,
      gitRaw: git.raw,
      mkdtempFn: fakeMkdtemp,
    });
    const forced = git.calls.find((c) => c[0] === "worktree" && c[1] === "add" && c[2] === "-B");
    expect(forced).toEqual(["worktree", "add", "-B", BRANCH, res.worktreeDir, "main"]);
  });

  it("force-removes a STILL-PRESENT stale worktree dir when prune alone can't clear it (killed-run recovery)", async () => {
    // Arrange: the branch is registered to an abandoned worktree whose on-disk
    // dir is still there (a killed run that never reached `removeSdlcWorktree`),
    // so `prune` (no-op — the dir exists) + the first `-B` retry BOTH still
    // collide. Only a `worktree list` lookup + a forced `remove` of the stale
    // path should let the FINAL `-B` attempt succeed.
    const stalePath = "/tmp/sdlc-wt-OLD/tree";
    let addAttempts = 0;
    const git = fakeGit((args) => {
      if (args[0] === "worktree" && args[1] === "add") {
        addAttempts += 1;
        if (addAttempts < 3) {
          throw new Error(`fatal: '${BRANCH}' is already used by worktree at '${stalePath}'`);
        }
        return "";
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return [
          "worktree /allowlisted/omniscience",
          "HEAD 0000000000000000000000000000000000000000",
          "branch refs/heads/main",
          "",
          `worktree ${stalePath}`,
          "HEAD 1111111111111111111111111111111111111111",
          `branch refs/heads/${BRANCH}`,
          "",
        ].join("\n");
      }
      return "";
    });

    // Act
    const res = await createSdlcWorktree({
      repoPath: REPO,
      branch: BRANCH,
      baseRef: "main",
      allowedRepoPaths: ROOTS,
      gitRaw: git.raw,
      mkdtempFn: fakeMkdtemp,
    });

    // Assert: it located + force-removed the stale worktree, then succeeded.
    expect(res.branch).toBe(BRANCH);
    const forcedRemove = git.calls.find(
      (c) => c[0] === "worktree" && c[1] === "remove" && c[2] === "--force",
    );
    expect(forcedRemove).toEqual(["worktree", "remove", "--force", stalePath]);
    expect(addAttempts).toBe(3);
  });
});

describe("resolveDefaultBranch", () => {
  it("strips `origin/` from the symbolic-ref result", async () => {
    const git = fakeGit((args) =>
      args[0] === "symbolic-ref" ? "origin/main\n" : "should-not-be-used\n",
    );
    expect(await resolveDefaultBranch(REPO, git.raw)).toBe("main");
  });

  it("falls back to the local HEAD branch, then to `main`", async () => {
    const git = fakeGit((args) => {
      if (args[0] === "symbolic-ref") throw new Error("no origin/HEAD");
      if (args[0] === "rev-parse") return "develop\n";
      return "";
    });
    expect(await resolveDefaultBranch(REPO, git.raw)).toBe("develop");

    const git2 = fakeGit(() => {
      throw new Error("not a git repo");
    });
    expect(await resolveDefaultBranch(REPO, git2.raw)).toBe("main");
  });
});

describe("removeSdlcWorktree — finally-safe", () => {
  it("calls `worktree remove --force` and NEVER throws (even when git fails)", async () => {
    const git = fakeGit((args) => {
      if (args[0] === "worktree" && args[1] === "remove") throw new Error("locked");
      return "";
    });
    await expect(
      removeSdlcWorktree(REPO, "/tmp/sdlc-wt-XXXX/tree", { baseDir: "/tmp/sdlc-wt-XXXX", gitRaw: git.raw }),
    ).resolves.toBeUndefined();
    const remove = git.calls.find((c) => c[0] === "worktree" && c[1] === "remove");
    expect(remove).toEqual(["worktree", "remove", "--force", "/tmp/sdlc-wt-XXXX/tree"]);
  });
});
