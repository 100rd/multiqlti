/**
 * Unit tests for server/services/consilium/diff-context.ts (Phase A2).
 *
 * Drives `buildDiffContext` with a FAKE GitDiffClient (no real repo) and an
 * allowlist set to the real cwd so the H-1 path check passes. Covers:
 *   - input assembly (objective + Changes + Test results sections)
 *   - byte-bounding / truncated flag
 *   - round-1 null baseline (objective only, no diff)
 *   - git failure → GitFail (scrubbed)
 *   - B-1 git arg-injection: --output=, --ext-diff, --no-index, leading-dash
 *     refs are REJECTED before any diff runs; --end-of-options is always pinned
 *   - H-2: resolved sha (not the raw input) is used downstream
 *   - H-4: a planted secret in the diff is redacted before it enters the input
 */
import { describe, it, expect, vi } from "vitest";
import { buildDiffContext, type GitDiffClient } from "../../../server/services/consilium/diff-context.js";

const REPO = process.cwd();
const ALLOW = [REPO];
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

/** A fake git that resolves HEAD + any valid hex ref, and returns canned diffs. */
function fakeGit(overrides: Partial<GitDiffClient> = {}): GitDiffClient {
  return {
    revparse: vi.fn(async (args: string[]) => {
      const ref = args[args.length - 1];
      if (ref === "HEAD^{commit}") return HEAD_SHA + "\n";
      if (ref.startsWith("b".repeat(7))) return BASE_SHA + "\n";
      return ref.replace(/\^\{commit\}$/, "") + "\n";
    }),
    diff: vi.fn(async (args: string[]) =>
      args.includes("--stat") ? " file.ts | 2 +-\n 1 file changed" : "diff --git a/file.ts b/file.ts\n+added line",
    ),
    ...overrides,
  };
}

describe("buildDiffContext — assembly & rounds", () => {
  it("round 1 (null baseline) → objective only, no diff section", async () => {
    const git = fakeGit();
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: null, objective: "Build the thing", allowedRepoPaths: ALLOW, maxDiffBytes: 1000, gitClient: git });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).toBe("Build the thing");
    expect(res.input).not.toContain("Changes since last review");
    expect(res.baselineCommit).toBeNull();
    expect(res.headCommit).toBe(HEAD_SHA);
    expect(res.truncated).toBe(false);
    expect(git.diff).not.toHaveBeenCalled();
  });

  it("assembles objective + Changes + Test results sections", async () => {
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "Obj", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, testSummary: "12 passed, 0 failed", gitClient: fakeGit() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).toContain("Obj");
    expect(res.input).toContain("## Changes since last review");
    expect(res.input).toContain("```diff");
    expect(res.input).toContain("## Test results");
    expect(res.input).toContain("12 passed, 0 failed");
  });

  it("byte-bounds the diff and sets truncated", async () => {
    const big = "x".repeat(5000);
    const git = fakeGit({ diff: vi.fn(async (args: string[]) => (args.includes("--stat") ? "stat" : big)) });
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "Obj", allowedRepoPaths: ALLOW, maxDiffBytes: 1024, gitClient: git });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.input, "utf8")).toBeLessThan(2000);
    expect(res.input).toContain("diff truncated");
  });
});

describe("buildDiffContext — H-2 resolved sha downstream", () => {
  it("uses the revparse-RESOLVED sha in the diff range, not the raw input", async () => {
    const git = fakeGit();
    await buildDiffContext({ repoPath: REPO, baselineCommit: "b".repeat(7), objective: "O", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, gitClient: git });
    const diffCalls = (git.diff as ReturnType<typeof vi.fn>).mock.calls;
    for (const [args] of diffCalls) {
      expect(args).toContain(`${BASE_SHA}..${HEAD_SHA}`);
      expect(args).not.toContain(`${"b".repeat(7)}..${HEAD_SHA}`);
    }
  });
});

describe("buildDiffContext — B-1 git argument injection (BINDING)", () => {
  const injections = ["--output=/etc/cron.d/x", "--ext-diff", "--no-index", "-HEAD", "main", "v3..HEAD", "HEAD~1"];
  for (const bad of injections) {
    it(`rejects baselineCommit "${bad}" before any diff runs`, async () => {
      const git = fakeGit();
      const res = await buildDiffContext({ repoPath: REPO, baselineCommit: bad, objective: "O", allowedRepoPaths: ALLOW, maxDiffBytes: 1000, gitClient: git });
      expect(res.ok).toBe(false);
      expect(git.diff).not.toHaveBeenCalled();
    });
  }

  it("pins --end-of-options before the range on every diff invocation", async () => {
    const git = fakeGit();
    await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "O", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, gitClient: git });
    const diffCalls = (git.diff as ReturnType<typeof vi.fn>).mock.calls;
    expect(diffCalls.length).toBeGreaterThan(0);
    for (const [args] of diffCalls) {
      const eoo = args.indexOf("--end-of-options");
      const range = args.indexOf(`${BASE_SHA}..${HEAD_SHA}`);
      expect(eoo).toBeGreaterThanOrEqual(0);
      expect(eoo).toBeLessThan(range);
    }
  });

  it("pins --end-of-options on the revparse verification too", async () => {
    const git = fakeGit();
    await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "O", allowedRepoPaths: ALLOW, maxDiffBytes: 1000, gitClient: git });
    const calls = (git.revparse as ReturnType<typeof vi.fn>).mock.calls;
    for (const [args] of calls) {
      expect(args).toContain("--verify");
      expect(args).toContain("--end-of-options");
    }
  });
});

describe("buildDiffContext — failures & H-1 allowlist", () => {
  it("unresolvable HEAD (git throws) → unresolved-ref GitFail, raw git string NOT leaked", async () => {
    // The resolver never embeds git's raw error for a resolution failure — it fails
    // closed with a crafted, path-free operator reason. So a leaked path/secret in
    // the underlying "fatal: ..." can NEVER reach the message (structural guarantee).
    const git = fakeGit({ revparse: vi.fn(async () => { throw new Error("fatal: /home/secret/.git Needed a single revision"); }) });
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: null, objective: "O", allowedRepoPaths: ALLOW, maxDiffBytes: 1000, gitClient: git });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorKind).toBe("unresolved-ref");
    expect(res.message).not.toContain("/home/secret");
    expect(res.message).not.toContain("Needed a single revision");
    expect(res.message).toContain("not present in the local checkout");
  });

  it("no fetch client on the injected git → resolution stays local, still fails closed", async () => {
    // A fake without `fetch` must not throw when the sha is missing — the optional
    // fetch is skipped and the resolver returns unresolved-ref (never a raw error).
    const git = fakeGit({ revparse: vi.fn(async () => { throw new Error("fatal: bad object"); }) });
    expect(git.fetch).toBeUndefined();
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "O", allowedRepoPaths: ALLOW, maxDiffBytes: 1000, gitClient: git });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorKind).toBe("unresolved-ref");
  });

  it("fetch-then-resolve (unit): a sha absent on first verify resolves after ONE fetch", async () => {
    // First revparse throws (missing); fetch is invoked ONCE; the second revparse
    // succeeds. Proves the recovery seam calls fetch exactly once and re-verifies.
    let verifyCalls = 0;
    const fetch = vi.fn(async () => undefined);
    const git = fakeGit({
      revparse: vi.fn(async (args: string[]) => {
        const ref = args[args.length - 1];
        verifyCalls += 1;
        // HEAD resolves normally; the baseline sha is "missing" until fetched.
        if (ref === "HEAD^{commit}") return HEAD_SHA + "\n";
        if (verifyCalls <= 2) throw new Error("fatal: Needed a single revision");
        return BASE_SHA + "\n";
      }),
      fetch,
    });
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "O", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, gitClient: git });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(["origin", BASE_SHA]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.baselineCommit).toBe(BASE_SHA);
  });

  it("empty allowlist → GitFail (fail-closed), no git call", async () => {
    const git = fakeGit();
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: null, objective: "O", allowedRepoPaths: [], maxDiffBytes: 1000, gitClient: git });
    expect(res.ok).toBe(false);
    expect(git.revparse).not.toHaveBeenCalled();
  });

  it("repoPath outside the allowlist → GitFail", async () => {
    const git = fakeGit();
    const res = await buildDiffContext({ repoPath: "/tmp", baselineCommit: null, objective: "O", allowedRepoPaths: ALLOW, maxDiffBytes: 1000, gitClient: git });
    expect(res.ok).toBe(false);
    expect(git.revparse).not.toHaveBeenCalled();
  });
});

describe("buildDiffContext — H-4 secret egress", () => {
  it("redacts a planted AWS credential and private key from the diff body", async () => {
    const leaky = [
      "+AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
      "+-----BEGIN RSA PRIVATE KEY-----",
      "+MIIEowIBAAKCAQEA1234567890abcdefXYZ",
      "+-----END RSA PRIVATE KEY-----",
      "+password=hunter2supersecretvalue",
    ].join("\n");
    const git = fakeGit({ diff: vi.fn(async (args: string[]) => (args.includes("--stat") ? "stat" : leaky)) });
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "O", allowedRepoPaths: ALLOW, maxDiffBytes: 100_000, gitClient: git });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).not.toContain("wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY");
    expect(res.input).not.toContain("hunter2supersecretvalue");
    expect(res.input).not.toContain("MIIEowIBAAKCAQEA");
    expect(res.input).toContain("<REDACTED:aws-credential>");
    expect(res.input).toContain("<REDACTED:private-key>");
    expect(res.input).toContain("<REDACTED:password>");
  });
});

describe("buildDiffContext — input bounds (testSummary + objective)", () => {
  it("clips an oversized testSummary and sets the truncated flag", async () => {
    const huge = "T".repeat(50_000); // > MAX_TEST_SUMMARY_CHARS (20_000)
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: null, objective: "Obj", allowedRepoPaths: ALLOW, maxDiffBytes: 1000, testSummary: huge, gitClient: fakeGit() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.truncated).toBe(true);
    // Section is present but clipped well below the 50k input.
    expect(res.input).toContain("## Test results");
    expect(res.input).toContain("test results truncated");
    expect(res.input.length).toBeLessThan(25_000);
  });

  it("does NOT flag truncated for a small testSummary", async () => {
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: null, objective: "Obj", allowedRepoPaths: ALLOW, maxDiffBytes: 1000, testSummary: "3 passed", gitClient: fakeGit() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.truncated).toBe(false);
    expect(res.input).not.toContain("test results truncated");
  });

  it("rejects a whitespace-only objective on round 1 (no diff) → GitFail", async () => {
    const git = fakeGit();
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: null, objective: "   \n\t  ", allowedRepoPaths: ALLOW, maxDiffBytes: 1000, gitClient: git });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/empty/i);
  });

  it("tolerates a blank objective WITH a diff (placeholder, diff carries content)", async () => {
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "  ", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, gitClient: fakeGit() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).toContain("No objective supplied");
    expect(res.input).toContain("## Changes since last review");
  });
});


describe("buildDiffContext — BRANCH-targeted ref resolves as the HEAD side", () => {
  const REF_SHA = "c".repeat(40);

  function refGit(): GitDiffClient {
    return {
      revparse: vi.fn(async (args: string[]) => {
        const ref = args[args.length - 1];
        if (ref === "feature/x^{commit}") return REF_SHA + "\n";
        if (ref === "HEAD^{commit}") return HEAD_SHA + "\n";
        if (ref.startsWith("b".repeat(7))) return BASE_SHA + "\n";
        return ref.replace(/\^\{commit\}$/, "") + "\n";
      }),
      diff: vi.fn(async (args: string[]) =>
        args.includes("--stat") ? "stat" : "diff --git a/f b/f\n+x",
      ),
    };
  }

  it("resolves loop.reviewRef as HEAD: records its sha and diffs baseline..<ref>", async () => {
    const git = refGit();
    const res = await buildDiffContext({
      repoPath: REPO,
      baselineCommit: BASE_SHA,
      ref: "feature/x",
      objective: "O",
      allowedRepoPaths: ALLOW,
      maxDiffBytes: 10_000,
      gitClient: git,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The recorded head sha is the REF's tip, not the working-tree HEAD.
    expect(res.headCommit).toBe(REF_SHA);
    expect(res.headCommit).not.toBe(HEAD_SHA);
    // The diff range pins the ref's resolved tip as the head side.
    for (const [args] of (git.diff as ReturnType<typeof vi.fn>).mock.calls) {
      expect(args).toContain(`${BASE_SHA}..${REF_SHA}`);
    }
    // SECURITY: the ref is verified via revparse, pinned behind --end-of-options.
    expect(git.revparse).toHaveBeenCalledWith(["--verify", "--end-of-options", "feature/x^{commit}"]);
  });

  it("ref absent ⇒ resolves the working-tree HEAD (full back-compat)", async () => {
    const res = await buildDiffContext({
      repoPath: REPO,
      baselineCommit: null,
      objective: "O",
      allowedRepoPaths: ALLOW,
      maxDiffBytes: 1000,
      gitClient: refGit(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.headCommit).toBe(HEAD_SHA);
  });
});

describe("buildDiffContext — MED-1 oversized diff is never buffered", () => {
  it("refuses to read the body when --stat reports a pathologically large change", async () => {
    const git = fakeGit({
      diff: vi.fn(async (args: string[]) => {
        if (args.includes("--stat"))
          return " f | 9999999 +++\n 1 file changed, 9000000 insertions(+), 1000000 deletions(-)";
        throw new Error("MUST NOT buffer the full diff body for an oversized change");
      }),
    });
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "Obj", allowedRepoPaths: ALLOW, maxDiffBytes: 1000, gitClient: git });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.truncated).toBe(true);
    // Only the bounded --stat call happened; the full-body read was skipped.
    const bodyReads = (git.diff as ReturnType<typeof vi.fn>).mock.calls.filter(([a]: [string[]]) => !a.includes("--stat"));
    expect(bodyReads).toHaveLength(0);
    expect(res.input).not.toContain("```diff");
    expect(res.input).toContain("diff omitted");
    expect(res.input).toContain("9000000 insertions");
  });

  it("a normal-sized diff is read and embedded unchanged (gate is transparent)", async () => {
    const git = fakeGit();
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "Obj", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, gitClient: git });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).toContain("```diff");
    expect(res.input).toContain("added line");
    expect(res.truncated).toBe(false);
  });
});

describe("buildDiffContext — LOW-1 re-validates the stored reviewRef", () => {
  it("an INVALID stored ref fails the round cleanly and NEVER reaches git", async () => {
    const git = fakeGit();
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "O", allowedRepoPaths: ALLOW, maxDiffBytes: 1000, ref: "-x", gitClient: git });
    expect(res.ok).toBe(false);
    expect(git.revparse).not.toHaveBeenCalled();
    expect(git.diff).not.toHaveBeenCalled();
  });

  it("a VALID stored ref passes re-validation and reaches git", async () => {
    const git = fakeGit({ revparse: vi.fn(async () => HEAD_SHA + "\n") });
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "O", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, ref: "feature/x", gitClient: git });
    expect(res.ok).toBe(true);
    expect(git.revparse).toHaveBeenCalled();
  });
});

describe("buildDiffContext — Option A repository-map section", () => {
  const MAP = "- `server/a.ts`: `foo` [function]\n  imported by: `server/b.ts`";

  it("injects the map BETWEEN the objective and the diff, under a header", async () => {
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "Obj", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, repoMap: MAP, gitClient: fakeGit() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).toContain("## Repository map (files touched by this diff + their importers)");
    expect(res.input).toContain("`server/a.ts`");
    // ordering: objective < repo map < changes
    const iObj = res.input.indexOf("Obj");
    const iMap = res.input.indexOf("## Repository map");
    const iDiff = res.input.indexOf("## Changes since last review");
    expect(iObj).toBeGreaterThanOrEqual(0);
    expect(iMap).toBeGreaterThan(iObj);
    expect(iDiff).toBeGreaterThan(iMap);
  });

  it("absent repoMap ⇒ NO map section (byte-identical to before)", async () => {
    const withArg = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "Obj", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, repoMap: undefined, gitClient: fakeGit() });
    const without = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "Obj", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, gitClient: fakeGit() });
    expect(withArg.ok && without.ok).toBe(true);
    if (!withArg.ok || !without.ok) return;
    expect(withArg.input).toBe(without.input);
    expect(withArg.input).not.toContain("## Repository map");
  });

  it("a blank repoMap emits NO section", async () => {
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "Obj", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, repoMap: "   \n  ", gitClient: fakeGit() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).not.toContain("## Repository map");
  });

  it("defensively redacts a secret that reaches assembly in the map text", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLEKEYDATA1234567890";
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "Obj", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, repoMap: `- \`c.ts\`: AWS_SECRET_ACCESS_KEY=${secret}`, gitClient: fakeGit() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).not.toContain(secret);
    expect(res.input).toContain("<REDACTED:");
  });

  it("round 1 (null baseline) never emits a map even if one is passed", async () => {
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: null, objective: "Obj", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, repoMap: MAP, gitClient: fakeGit() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).not.toContain("## Repository map");
  });
});

describe("buildDiffContext — repo-conventions section", () => {
  const CONV = "```\nBe kind to tests.\n```";
  const MAP = "- `server/a.ts`: `foo` [function]\n  imported by: `server/b.ts`";

  it("injects conventions AFTER the objective and BEFORE the repo map", async () => {
    const res = await buildDiffContext({
      repoPath: REPO,
      baselineCommit: BASE_SHA,
      objective: "Obj",
      allowedRepoPaths: ALLOW,
      maxDiffBytes: 10_000,
      repoMap: MAP,
      repoConventions: CONV,
      gitClient: fakeGit(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).toContain("## Repository conventions (AGENTS.md / CLAUDE.md)");
    expect(res.input).toContain("Be kind to tests.");
    // ordering: objective < conventions < repo map < changes
    const iObj = res.input.indexOf("Obj");
    const iConv = res.input.indexOf("## Repository conventions");
    const iMap = res.input.indexOf("## Repository map");
    const iDiff = res.input.indexOf("## Changes since last review");
    expect(iObj).toBeGreaterThanOrEqual(0);
    expect(iConv).toBeGreaterThan(iObj);
    expect(iMap).toBeGreaterThan(iConv);
    expect(iDiff).toBeGreaterThan(iMap);
  });

  it("absent repoConventions ⇒ NO section (byte-identical to before)", async () => {
    const withArg = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "Obj", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, repoConventions: undefined, gitClient: fakeGit() });
    const without = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "Obj", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, gitClient: fakeGit() });
    expect(withArg.ok && without.ok).toBe(true);
    if (!withArg.ok || !without.ok) return;
    expect(withArg.input).toBe(without.input);
    expect(withArg.input).not.toContain("## Repository conventions");
  });

  it("a blank repoConventions emits NO section", async () => {
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "Obj", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, repoConventions: "   \n  ", gitClient: fakeGit() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).not.toContain("## Repository conventions");
  });

  it("defensively redacts a secret that reaches assembly in the conventions text", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLEKEYDATA1234567890";
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: BASE_SHA, objective: "Obj", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, repoConventions: `AWS_SECRET_ACCESS_KEY=${secret}`, gitClient: fakeGit() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).not.toContain(secret);
    expect(res.input).toContain("<REDACTED:");
  });

  it("round 1 (null baseline) never emits a conventions section even if one is passed", async () => {
    const res = await buildDiffContext({ repoPath: REPO, baselineCommit: null, objective: "Obj", allowedRepoPaths: ALLOW, maxDiffBytes: 10_000, repoConventions: CONV, gitClient: fakeGit() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).not.toContain("## Repository conventions");
  });
});
