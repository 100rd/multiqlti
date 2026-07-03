/**
 * sdlc-verify-before-merge-integration.test.ts — REAL-GIT integration for §3E
 * verify-before-merge's `integrateBaseBranch` helper.
 *
 * WHY THIS EXISTS (the incident it locks down): the base sha was resolved with
 * `git rev-parse --end-of-options <ref>`. In rev-parse's DEFAULT (echo) mode git prints the
 * literal `--end-of-options` token back on its OWN line before the sha
 * (`--end-of-options\n<sha>`); `.trim()` only strips the OUTER whitespace, so `resolved`
 * became the two-line string `"--end-of-options\n<sha>"`. Handed to
 * `git merge --no-edit --end-of-options <resolved>` that whole string is ONE positional
 * (the real `--end-of-options` before it disables option parsing) ⇒
 * `merge: --end-of-options <sha> - not something we can merge` — a FALSE "integration
 * conflict" when the command itself was malformed. Fully-mocked unit tests never run real
 * git, so they miss this exactly like the #482→#485 fan-out D/F bug. This test drives the
 * REAL helper + real `git` against scratch repos, so a regression fails deterministically.
 *
 * Coverage:
 *  (a) a branch cut from an OLDER base, with "main" advanced, MERGES cleanly (argv correct,
 *      ref resolvable) and the branch advances;
 *  (b) a genuine overlapping-edit conflict is reported as a `kind: "conflict"` and ABORTED
 *      (worktree left clean);
 *  (c) the merge argv is SEPARATE elements — the sha is a lone clean 40-hex token, never a
 *      `--end-of-options <sha>` concatenation, and resolution uses rev-parse VERIFY mode.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { integrateBaseBranch } from "../../server/services/sdlc/executor.js";
import { defaultGitRaw, type GitRunner } from "../../server/services/sdlc/worktree.js";

let originDir: string;
let cloneDir: string;
let oldBaseSha: string;

/** Run a real git command in `dir`, returning trimmed stdout. */
function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function initRepo(dir: string): void {
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "config", "user.email", "test@example.com");
  gitIn(dir, "config", "user.name", "Test");
  gitIn(dir, "config", "commit.gpgsign", "false");
}

beforeEach(() => {
  // origin: a normal repo used as the fetch remote; realpath'd (macOS /var → /private/var).
  originDir = realpathSync(mkdtempSync(join(tmpdir(), "vbm-origin-")));
  initRepo(originDir);
  execFileSync("git", ["-C", originDir, "commit", "-q", "--allow-empty", "-m", "base"]);
  oldBaseSha = gitIn(originDir, "rev-parse", "HEAD");

  // clone: the "round worktree". `origin/main` starts at the OLD base (stale) until the
  // helper fetches. We cut the round branch off the old base and add OUR commit on it.
  cloneDir = realpathSync(mkdtempSync(join(tmpdir(), "vbm-clone-")));
  execFileSync("git", ["clone", "-q", originDir, cloneDir]);
  gitIn(cloneDir, "config", "user.email", "test@example.com");
  gitIn(cloneDir, "config", "user.name", "Test");
  gitIn(cloneDir, "config", "commit.gpgsign", "false");
  gitIn(cloneDir, "checkout", "-q", "-b", "consilium/loop-x/round-1");
});

afterEach(() => {
  for (const d of [cloneDir, originDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** Write + commit a file in `dir` on the current branch. */
function commitFile(dir: string, name: string, content: string, msg: string): string {
  execFileSync("bash", ["-c", `printf '%s' "$2" > "$0/$1"`, dir, name, content]);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", msg);
  return gitIn(dir, "rev-parse", "HEAD");
}

/** A gitRaw that records every (args) it is asked to run, then delegates to the real runner. */
function recordingGitRaw(): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitRunner = (repoPath, args) => {
    calls.push([...args]);
    return defaultGitRaw(repoPath, args);
  };
  return { runner, calls };
}

describe("integrateBaseBranch — REAL git", () => {
  it("(a) merges an advanced base into a branch cut from an older base; branch advances", async () => {
    // OUR commit on the round branch touches feature.txt.
    commitFile(cloneDir, "feature.txt", "our work\n", "feat: round work");
    const roundHeadBefore = gitIn(cloneDir, "rev-parse", "HEAD");

    // "main" advances on origin (a NON-overlapping file) AFTER the branch was cut.
    const advancedSha = commitFile(originDir, "advanced.txt", "from main\n", "chore: advance main");
    expect(advancedSha).not.toBe(oldBaseSha);

    const { runner, calls } = recordingGitRaw();
    const res = await integrateBaseBranch(runner, cloneDir, "main");

    // Clean merge: ok, and the returned integrationBase is the freshly-fetched advanced sha.
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.integrationBase).toMatch(/^[0-9a-f]{40}$/);
    expect(res.integrationBase).toBe(advancedSha);

    // The round branch ADVANCED (a real merge commit) past its own pre-merge HEAD, and now
    // contains BOTH our work and main's advancement.
    const roundHeadAfter = gitIn(cloneDir, "rev-parse", "HEAD");
    expect(roundHeadAfter).not.toBe(roundHeadBefore);
    const tree = gitIn(cloneDir, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
    expect(tree).toContain("feature.txt");
    expect(tree).toContain("advanced.txt");
    // The advanced base sha is now an ANCESTOR of the round HEAD (it was truly integrated).
    expect(() =>
      execFileSync("git", ["-C", cloneDir, "merge-base", "--is-ancestor", advancedSha, "HEAD"]),
    ).not.toThrow();
    // Worktree left clean.
    expect(gitIn(cloneDir, "status", "--porcelain")).toBe("");

    // (c) ARGV: the merge call passes SEPARATE elements — flag and a lone clean sha.
    const mergeCall = calls.find((c) => c[0] === "merge");
    expect(mergeCall).toBeDefined();
    expect(mergeCall).toEqual(["merge", "--no-edit", "--end-of-options", advancedSha]);
    // The last element is a bare 40-hex sha — NOT a `--end-of-options <sha>` concatenation
    // and free of any embedded flag/newline (the exact bug shape).
    const mergeRef = mergeCall![mergeCall!.length - 1];
    expect(mergeRef).toMatch(/^[0-9a-f]{40}$/);
    expect(mergeRef).not.toContain("--end-of-options");
    expect(mergeRef).not.toMatch(/\s/);
    // NO argv element anywhere collapses a flag and a ref into one token.
    for (const call of calls) {
      for (const arg of call) {
        expect(arg).not.toMatch(/--end-of-options\s+\S/);
      }
    }
    // Resolution used rev-parse VERIFY mode (single-object, no flag echo) — the actual fix.
    const revParseVerify = calls.find((c) => c[0] === "rev-parse" && c.includes("--verify"));
    expect(revParseVerify).toBeDefined();
  });

  it("(b) reports a genuine overlapping-edit conflict as kind:'conflict' and aborts cleanly", async () => {
    // OUR commit edits conflict.txt one way…
    commitFile(cloneDir, "conflict.txt", "OUR VERSION\n", "feat: our edit");
    // …and main edits the SAME file differently → a real content conflict on merge.
    const advancedSha = commitFile(originDir, "conflict.txt", "MAIN VERSION\n", "chore: main edit");

    const res = await integrateBaseBranch(defaultGitRaw, cloneDir, "main");

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected conflict");
    expect(res.kind).toBe("conflict");
    expect(res.error).toMatch(/integration conflict merging main/);
    // The merge was ABORTED — no in-progress merge, worktree clean, HEAD unchanged from ours.
    expect(gitIn(cloneDir, "status", "--porcelain")).toBe("");
    expect(() => gitIn(cloneDir, "rev-parse", "--verify", "MERGE_HEAD")).toThrow();
    // The advanced base was NOT merged (it is not an ancestor — we aborted).
    expect(() =>
      execFileSync("git", ["-C", cloneDir, "merge-base", "--is-ancestor", advancedSha, "HEAD"]),
    ).toThrow();
  });

  it("(c) an unresolvable base ref is a command ERROR, not a conflict", async () => {
    commitFile(cloneDir, "feature.txt", "our work\n", "feat: round work");
    // A base that no fetch/ref can resolve → the helper must NOT call it a content conflict.
    const res = await integrateBaseBranch(defaultGitRaw, cloneDir, "no-such-base-ref");

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.kind).toBe("error");
    expect(res.error).toMatch(/integration could not run/);
    // Nothing was merged; worktree stays clean.
    expect(gitIn(cloneDir, "status", "--porcelain")).toBe("");
  });
});
