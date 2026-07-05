/**
 * spec-writer.test.ts — the remote spec-PR writer with a FAKE `gh` answering by
 * argv (no real gh / network). Covers: a NEW issue creates ref+file+PR; an existing
 * PR is reused with NO creates; bad-origin / leading-dash title fail typed; a gh
 * write outage never throws; a branch-already-exists stderr continues to file+PR.
 */
import { describe, it, expect, vi } from "vitest";
import { writeSpecPr } from "../../../../server/services/consilium/trackers/spec-writer.js";
import type { ExecFileFn } from "../../../../server/services/github-status.js";

interface FakeOpts {
  existingPrs?: Array<{ url?: string; state?: string }>;
  defaultBranch?: string;
  baseSha?: string;
  prUrl?: string;
  /** Return a stderr string to THROW for a matching call (simulates gh non-zero exit). */
  throwOn?: (args: string[]) => string | undefined;
}

function fakeGh(opts: FakeOpts): { run: ExecFileFn; argv: string[][] } {
  const argv: string[][] = [];
  const run: ExecFileFn = vi.fn(async (_file: string, args: string[]) => {
    argv.push(args);
    const stderr = opts.throwOn?.(args);
    if (stderr !== undefined) {
      throw Object.assign(new Error("gh failed"), { stderr });
    }
    const json = (obj: unknown) => ({ stdout: JSON.stringify(obj), stderr: "" });

    if (args[0] === "pr" && args[1] === "list") return json(opts.existingPrs ?? []);
    if (args[0] === "repo" && args[1] === "view") {
      return json({ defaultBranchRef: { name: opts.defaultBranch ?? "main" } });
    }
    if (args[0] === "api") {
      const methodIdx = args.indexOf("--method");
      if (methodIdx === -1) {
        // GET git/ref/heads/<base> → base sha.
        return json({ object: { sha: opts.baseSha ?? "basesha123" } });
      }
      // POST refs / PUT contents → capture-style success (non-JSON body).
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "create") {
      return { stdout: `${opts.prUrl ?? "https://github.com/acme/widget/pull/7"}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  return { run, argv };
}

const PARAMS = {
  targetRepoPath: "/repo/widget",
  issueNumber: 7,
  branch: "spec/gh-issue-7",
  filePath: "docs/specs/gh-issue-7-thing.md",
  fileContent: "---\ntitle: x\n---\nbody",
  commitMessage: "feat: add spec for issue #7 (closes #7)",
  prTitle: "spec: thing (closes #7)",
  prBody: "Closes #7",
};

const okRemote = async () => "https://github.com/acme/widget.git";
const deps = (run: ExecFileFn, gitRemoteUrl = okRemote) => ({ runGh: run, gitRemoteUrl, log: () => {} });

function has(argv: string[][], pred: (a: string[]) => boolean): boolean {
  return argv.some(pred);
}

describe("writeSpecPr", () => {
  it("NEW issue → creates branch ref + file + PR", async () => {
    const { run, argv } = fakeGh({});
    const res = await writeSpecPr(deps(run), PARAMS);
    expect(res).toEqual({ ok: true, reused: false, prUrl: "https://github.com/acme/widget/pull/7" });
    expect(has(argv, (a) => a[0] === "api" && a.includes("--method") && a.includes("POST") && a.some((x) => x.startsWith("ref=refs/heads/spec/gh-issue-7")))).toBe(true);
    expect(has(argv, (a) => a[0] === "api" && a.includes("PUT") && a.includes("repos/acme/widget/contents/docs/specs/gh-issue-7-thing.md"))).toBe(true);
    expect(has(argv, (a) => a[0] === "pr" && a[1] === "create")).toBe(true);
  });

  it("existing PR → reused, NO create calls", async () => {
    const { run, argv } = fakeGh({ existingPrs: [{ url: "https://github.com/acme/widget/pull/3", state: "OPEN" }] });
    const res = await writeSpecPr(deps(run), PARAMS);
    expect(res).toEqual({ ok: true, reused: true, prUrl: "https://github.com/acme/widget/pull/3" });
    expect(has(argv, (a) => a.includes("--method"))).toBe(false); // no ref/file writes
    expect(has(argv, (a) => a[0] === "pr" && a[1] === "create")).toBe(false);
  });

  it("bad-origin when the remote is not resolvable", async () => {
    const { run } = fakeGh({});
    const res = await writeSpecPr(deps(run, async () => null), PARAMS);
    expect(res).toEqual({ ok: false, reason: "bad-origin" });
  });

  it("rejects a leading-dash PR title (flag injection)", async () => {
    const { run, argv } = fakeGh({});
    const res = await writeSpecPr(deps(run), { ...PARAMS, prTitle: "--oops" });
    expect(res).toEqual({ ok: false, reason: "bad-title" });
    expect(argv.length).toBe(0); // rejected before any gh call
  });

  it("rejects a non-spec branch shape", async () => {
    const { run } = fakeGh({});
    const res = await writeSpecPr(deps(run), { ...PARAMS, branch: "consilium/loop-x/round-1" });
    expect(res).toEqual({ ok: false, reason: "bad-branch" });
  });

  it("a gh write outage never throws → typed failure", async () => {
    const { run } = fakeGh({ throwOn: (a) => (a[0] === "api" && a.includes("POST") ? "network unreachable" : undefined) });
    const res = await writeSpecPr(deps(run), PARAMS);
    expect(res).toEqual({ ok: false, reason: "branch-create-failed" });
  });

  it("branch-already-exists stderr → continues to file + PR", async () => {
    const { run, argv } = fakeGh({ throwOn: (a) => (a[0] === "api" && a.includes("POST") ? "HTTP 422: Reference already exists" : undefined) });
    const res = await writeSpecPr(deps(run), PARAMS);
    expect(res.ok).toBe(true);
    expect(has(argv, (a) => a.includes("PUT"))).toBe(true);
    expect(has(argv, (a) => a[0] === "pr" && a[1] === "create")).toBe(true);
  });

  it("recovers a PR-create already-exists race via pr list", async () => {
    // pr list is empty first (dedup miss), pr create throws already-exists, then the
    // recovery pr list returns the URL.
    let prListCalls = 0;
    const argv: string[][] = [];
    const run: ExecFileFn = vi.fn(async (_f: string, args: string[]) => {
      argv.push(args);
      if (args[0] === "pr" && args[1] === "list") {
        prListCalls += 1;
        return { stdout: JSON.stringify(prListCalls === 1 ? [] : [{ url: "https://github.com/acme/widget/pull/9" }]), stderr: "" };
      }
      if (args[0] === "repo" && args[1] === "view") return { stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }), stderr: "" };
      if (args[0] === "api" && args.indexOf("--method") === -1) return { stdout: JSON.stringify({ object: { sha: "s" } }), stderr: "" };
      if (args[0] === "api") return { stdout: "", stderr: "" };
      if (args[0] === "pr" && args[1] === "create") throw Object.assign(new Error("x"), { stderr: "a pull request already exists" });
      return { stdout: "", stderr: "" };
    });
    const res = await writeSpecPr({ runGh: run, gitRemoteUrl: okRemote, log: () => {} }, PARAMS);
    expect(res).toEqual({ ok: true, reused: true, prUrl: "https://github.com/acme/widget/pull/9" });
  });
});
