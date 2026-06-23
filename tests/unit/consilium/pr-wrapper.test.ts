/**
 * Unit tests for server/services/consilium/pr-wrapper.ts (Phase D.4 + design-review hardening).
 *
 * Injects a FAKE simple-git client (push + getRemotes) + a FAKE execFile — no
 * network, no real repo, no `gh` binary. Covers (§14.7 + B-3/B-3+/B-4/H-6/H-7/M-6/M-7):
 *   - pushBranch calls push(["-u","origin","--",branch]) (B-4 arg-array + `--` terminator)
 *   - openDraftPr invokes gh with an ARG ARRAY; body via --body-file; --draft only (H-6)
 *   - B-3: a non-matching / shell-metachar branch is REJECTED before git/gh
 *   - B-3+: a leading-dash title (e.g. `--add-reviewer x`, `-F`) or leading-dash
 *           branch is REJECTED; `git push` carries a `--` terminator
 *   - H-7a: --repo is derived from origin; a malformed origin → typed bad-origin (no PR)
 *   - H-7b: env passed to execFile strips inherited GH_HOST / GH_* it didn't set
 *   - gh non-zero exit → typed failure, never throws
 *   - M-6: an existing PR for the branch is reused (no duplicate create)
 *   - M-7: create fails "already exists" → recover the existing URL, return ok
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  pushBranch,
  openDraftPr,
  isValidLoopBranch,
  type GitPushClient,
  type ExecFileFn,
} from "../../../server/services/consilium/pr-wrapper.js";

const LOOP = "11111111-2222-3333-4444-555555555555";
const BRANCH = `consilium/loop-${LOOP}/round-2`;
const REPO = "/some/allowlisted/repo";
const ORIGIN = "https://github.com/acme/widget.git";
const OWNER_REPO = "acme/widget";

function fakeGit(over: Partial<GitPushClient> = {}): GitPushClient & {
  push: ReturnType<typeof vi.fn>;
  getRemotes: ReturnType<typeof vi.fn>;
} {
  const push = vi.fn(async () => undefined);
  const getRemotes = vi.fn(async () => [{ name: "origin", refs: { fetch: ORIGIN, push: ORIGIN } }]);
  return { push, getRemotes, ...over } as GitPushClient & {
    push: ReturnType<typeof vi.fn>;
    getRemotes: ReturnType<typeof vi.fn>;
  };
}

/** Route gh invocations by sub-command; capture argv + env per call. */
function fakeExec(handlers: {
  list?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  create?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
}): ExecFileFn & ReturnType<typeof vi.fn> {
  return vi.fn(async (file: string, args: string[]) => {
    expect(file).toBe("gh"); // never a shell
    if (args[1] === "list") return (handlers.list ?? (async () => ({ stdout: "[]", stderr: "" })))(args);
    if (args[1] === "create") return (handlers.create ?? (async () => ({ stdout: "", stderr: "" })))(args);
    return { stdout: "", stderr: "" };
  }) as ExecFileFn & ReturnType<typeof vi.fn>;
}

describe("isValidLoopBranch (B-3)", () => {
  it("accepts a server-derived branch", () => {
    expect(isValidLoopBranch(BRANCH)).toBe(true);
  });
  it("rejects injection / non-matching branches", () => {
    expect(isValidLoopBranch("foo; rm -rf /")).toBe(false);
    expect(isValidLoopBranch("main")).toBe(false);
    expect(isValidLoopBranch(`consilium/loop-${LOOP}/round-2; echo x`)).toBe(false);
    expect(isValidLoopBranch("../../etc/passwd")).toBe(false);
  });
});

describe("pushBranch", () => {
  it("calls push(['-u','origin','--',branch]) (B-4 arg-array + `--` terminator)", async () => {
    const git = fakeGit();
    const res = await pushBranch(REPO, BRANCH, git);
    expect(res.ok).toBe(true);
    expect(git.push).toHaveBeenCalledWith(["-u", "origin", "--", BRANCH]);
  });

  it("REJECTS a non-matching/injection branch before any push (B-3)", async () => {
    const git = fakeGit();
    const res = await pushBranch(REPO, "foo; rm -rf /", git);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("bad-branch");
    expect(git.push).not.toHaveBeenCalled();
  });

  it("REJECTS a leading-dash branch before any push (B-3+)", async () => {
    const git = fakeGit();
    const res = await pushBranch(REPO, "-consilium/x", git);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("bad-branch");
    expect(git.push).not.toHaveBeenCalled();
  });

  it("never throws on a push failure → typed failure (scrubbed)", async () => {
    const git = fakeGit({ push: vi.fn(async () => { throw new Error("remote rejected /home/x/.ssh/key"); }) });
    const res = await pushBranch(REPO, BRANCH, git);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("unknown");
      expect(res.message).not.toContain("/home/x/.ssh"); // scrubbed
    }
  });
});

describe("openDraftPr", () => {
  const OPTS = { base: "main", head: BRANCH, title: "Consilium round 2", body: "- [ ] do the thing\n" };

  beforeEach(() => {
    delete process.env.GH_HOST;
    delete process.env.GH_ENTERPRISE_TOKEN;
    delete process.env.GH_TOKEN;
  });
  afterEach(() => {
    delete process.env.GH_HOST;
    delete process.env.GH_ENTERPRISE_TOKEN;
    delete process.env.GH_TOKEN;
  });

  it("invokes gh create with an ARG ARRAY: --draft, --repo, --body-file (no shell metachars)", async () => {
    let createArgs: string[] = [];
    const exec = fakeExec({
      create: async (args) => { createArgs = args; return { stdout: "https://github.com/o/r/pull/42\n", stderr: "" }; },
    });
    const res = await openDraftPr(REPO, OPTS, exec, fakeGit());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.prUrl).toBe("https://github.com/o/r/pull/42");

    expect(createArgs.slice(0, 2)).toEqual(["pr", "create"]);
    expect(createArgs).toContain("--draft");
    expect(createArgs).toEqual(expect.arrayContaining(["--repo", OWNER_REPO])); // H-7a explicit repo
    expect(createArgs).toEqual(expect.arrayContaining(["--base", "main", "--head", BRANCH, "--title", OPTS.title]));
    expect(createArgs.indexOf("--body-file")).toBeGreaterThan(-1);
    expect(createArgs).not.toContain(OPTS.body); // body NEVER in argv — only the file path
    expect(createArgs.includes("--merge")).toBe(false); // H-6: never auto-merge
    expect(createArgs.some((a) => /[;&|`$]/.test(a))).toBe(false);
  });

  it("REJECTS an injected (non-matching) head branch before any gh call (B-3)", async () => {
    const exec = fakeExec({});
    const res = await openDraftPr(REPO, { ...OPTS, head: "foo; rm -rf /" }, exec, fakeGit());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("bad-branch");
    expect(exec).not.toHaveBeenCalled();
  });

  it("B-3+: REJECTS a leading-dash title (flag injection) before any gh call", async () => {
    const exec = fakeExec({});
    for (const bad of ["--add-reviewer x", "-F", "--label evil"]) {
      const res = await openDraftPr(REPO, { ...OPTS, title: bad }, exec, fakeGit());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.kind).toBe("bad-title");
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("H-7a: --repo derived from origin; malformed origin → typed bad-origin (no PR)", async () => {
    const exec = fakeExec({ create: async () => ({ stdout: "https://x/pull/1", stderr: "" }) });
    const badGit = fakeGit({ getRemotes: vi.fn(async () => [{ name: "origin", refs: { fetch: "not-a-url", push: "not-a-url" } }]) });
    const res = await openDraftPr(REPO, OPTS, exec, badGit);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("bad-origin");
    expect(exec).not.toHaveBeenCalled(); // no list, no create
  });

  it("H-7a: missing origin remote → typed bad-origin (no PR)", async () => {
    const exec = fakeExec({});
    const noOrigin = fakeGit({ getRemotes: vi.fn(async () => []) });
    const res = await openDraftPr(REPO, OPTS, exec, noOrigin);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("bad-origin");
    expect(exec).not.toHaveBeenCalled();
  });

  it("H-7b: env passed to execFile strips inherited GH_HOST / GH_ENTERPRISE_TOKEN", async () => {
    process.env.GH_HOST = "attacker.example";
    process.env.GH_ENTERPRISE_TOKEN = "leak-me";
    process.env.GH_TOKEN = "intended-token";
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const exec = vi.fn(async (_file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      if (args[1] === "create") seenEnv = opts?.env;
      return { stdout: args[1] === "create" ? "https://github.com/o/r/pull/9\n" : "[]", stderr: "" };
    }) as ExecFileFn;
    const res = await openDraftPr(REPO, OPTS, exec, fakeGit());
    expect(res.ok).toBe(true);
    expect(seenEnv).toBeDefined();
    expect(seenEnv?.GH_HOST).toBeUndefined();            // inherited GH_* stripped
    expect(seenEnv?.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(seenEnv?.GH_TOKEN).toBe("intended-token");    // only the intended token kept
  });

  it("gh non-zero exit → typed failure, never throws (H-6 unauth/absent)", async () => {
    const exec = fakeExec({
      create: async () => { throw Object.assign(new Error("gh: not authenticated"), { code: 1 }); },
    });
    const res = await openDraftPr(REPO, OPTS, exec, fakeGit());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("gh-failed");
  });

  it("M-6: existing PR for the branch is reused — no duplicate create", async () => {
    const createSpy = vi.fn(async () => ({ stdout: "https://github.com/o/r/pull/99\n", stderr: "" }));
    const exec = fakeExec({
      list: async () => ({ stdout: JSON.stringify([{ url: "https://github.com/o/r/pull/7" }]), stderr: "" }),
      create: createSpy,
    });
    const res = await openDraftPr(REPO, OPTS, exec, fakeGit());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.prUrl).toBe("https://github.com/o/r/pull/7"); // reused
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("M-7: create fails 'already exists' → recovers the existing URL, returns ok", async () => {
    let listCalls = 0;
    const exec = vi.fn(async (_file: string, args: string[]) => {
      if (args[1] === "list") {
        listCalls += 1;
        // first list (M-6 pre-check) → empty; second list (M-7 recovery) → found
        return { stdout: listCalls === 1 ? "[]" : JSON.stringify([{ url: "https://github.com/o/r/pull/55" }]), stderr: "" };
      }
      if (args[1] === "create") throw new Error("a pull request for branch \"X\" into branch \"main\" already exists");
      return { stdout: "", stderr: "" };
    }) as ExecFileFn;
    const res = await openDraftPr(REPO, OPTS, exec, fakeGit());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.prUrl).toBe("https://github.com/o/r/pull/55"); // M-7 recovery
    expect(listCalls).toBe(2); // pre-check + recovery
  });
});
