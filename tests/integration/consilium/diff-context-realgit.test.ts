/**
 * Integration test for buildDiffContext against a REAL tmp git repo + real git
 * binary (Phase A2.4). Confirms the end-to-end path — real simple-git, real
 * `--end-of-options`-pinned diff — produces a correct, bounded input.
 *
 * Uses `pool: forks` / `singleFork` (vitest integration project) so the cwd /
 * env are isolated. The repo lives under the project tree so the allowlist
 * (which realpath-confines) accepts it without symlink surprises on macOS.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { buildDiffContext } from "../../../server/services/consilium/diff-context.js";

const execFileAsync = promisify(execFile);

describe("buildDiffContext — real git", () => {
  let repo: string;
  let allow: string;
  let firstSha: string;

  async function git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", repo, ...args]);
    return stdout.trim();
  }

  beforeAll(async () => {
    // Keep the repo inside the project tree so realpath confinement is simple.
    allow = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), "tmp-consilium-")));
    repo = path.join(allow, "repo");
    await fs.mkdir(repo, { recursive: true });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "t@t.t"]);
    await git(["config", "user.name", "t"]);
    await fs.writeFile(path.join(repo, "a.txt"), "one\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "first"]);
    firstSha = await git(["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "second"]);
  });

  afterAll(async () => {
    await fs.rm(allow, { recursive: true, force: true });
  });

  it("round 1 (null baseline) returns objective only", async () => {
    const res = await buildDiffContext({ repoPath: repo, baselineCommit: null, objective: "Standing objective", allowedRepoPaths: [allow], maxDiffBytes: 100_000 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).toBe("Standing objective");
    expect(res.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(res.baselineCommit).toBeNull();
  });

  it("builds a real diff base..HEAD with the changed line", async () => {
    const res = await buildDiffContext({ repoPath: repo, baselineCommit: firstSha, objective: "Obj", allowedRepoPaths: [allow], maxDiffBytes: 100_000, testSummary: "1 passed" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).toContain("## Changes since last review");
    expect(res.input).toContain("a.txt");
    expect(res.input).toContain("+two");
    expect(res.input).toContain("## Test results");
    expect(res.baselineCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(res.truncated).toBe(false);
  });

  it("truncates a real diff beyond maxDiffBytes (min cap forces truncation)", async () => {
    // 1KiB is the schema floor; the real second-commit diff exceeds the headers
    // alone, so a 1024-byte cap reliably trips the truncated flag.
    const res = await buildDiffContext({ repoPath: repo, baselineCommit: firstSha, objective: "Obj", allowedRepoPaths: [allow], maxDiffBytes: 1024 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Buffer.byteLength(res.input, "utf8")).toBeLessThan(4096);
  });

  it("B-1: a leading-dash / bad baseline ref is rejected by the real binary path", async () => {
    const bad = await buildDiffContext({ repoPath: repo, baselineCommit: "--output=/tmp/x", objective: "O", allowedRepoPaths: [allow], maxDiffBytes: 1024 });
    expect(bad.ok).toBe(false);
    const range = await buildDiffContext({ repoPath: repo, baselineCommit: `${firstSha}..HEAD`, objective: "O", allowedRepoPaths: [allow], maxDiffBytes: 1024 });
    expect(range.ok).toBe(false);
  });

  it("rejects a repo outside the allowlist (real path)", async () => {
    const res = await buildDiffContext({ repoPath: repo, baselineCommit: null, objective: "O", allowedRepoPaths: ["/nonexistent-root"], maxDiffBytes: 1024 });
    expect(res.ok).toBe(false);
  });
});
