/**
 * spec-status-writer.test.ts — SPEC-2 (spec-as-task.md §4) status lifecycle writer.
 *
 * Covers the pure core + the remote (`gh`) write with a FAKE gh (no real gh/network):
 *   - rewriteSpecStatus: CAS-guard on expectedFrom (race/human-edit safety), exact
 *     formatting preservation, malformed/absent status handled safely, idempotence.
 *   - specStatusForTerminalLoop: converged stays in-progress; failed/cap/escalated/
 *     cancelled → blocked (never `ready` — no re-fire); never auto-`done`.
 *   - specStatusForPrMerge / reconcileSpecStatusOnPrMerge: ONLY a MERGED code PR → done.
 *   - specRelPath: fenced inside the spec repo (rejects `..`/absolute escapes).
 *   - writeSpecStatusRemote: ready→in-progress happy path; sha-conflict + status-
 *     mismatch = best-effort no-op; bad-origin/read-failure never throw.
 */
import { describe, it, expect, vi } from "vitest";
import {
  rewriteSpecStatus,
  specStatusForTerminalLoop,
  specStatusForPrMerge,
  specRelPath,
  writeSpecStatusRemote,
  reconcileSpecStatusOnPrMerge,
} from "../../../server/services/consilium/spec-status-writer.js";
import type { ExecFileFn } from "../../../server/services/github-status.js";

const SPEC = (status: string) => `---
title: "Add rate limiting"
status: ${status}
source: { kind: human }
acceptanceCriteria:
  - "429 on overflow"
---
## Problem
No rate limit.
`;

// ─── rewriteSpecStatus (pure, CAS-guarded) ─────────────────────────────────────

describe("rewriteSpecStatus", () => {
  it("flips ready → in-progress, changing ONLY the status line", () => {
    const r = rewriteSpecStatus(SPEC("ready"), "ready", "in-progress");
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.content).toBe(SPEC("in-progress"));
    // Body + other frontmatter keys untouched.
    expect(r.content).toContain('title: "Add rate limiting"');
    expect(r.content).toContain("## Problem");
  });

  it("CAS guard: refuses to flip when the file is not the expected `from` (race/human edit)", () => {
    // Two ticks racing: the file already reads in-progress → second writer no-ops.
    const r = rewriteSpecStatus(SPEC("in-progress"), "ready", "in-progress");
    expect(r).toEqual({ changed: false, reason: "unchanged", current: "in-progress" });

    const human = rewriteSpecStatus(SPEC("draft"), "ready", "in-progress");
    expect(human).toEqual({ changed: false, reason: "status-mismatch", current: "draft" });
  });

  it("preserves quotes-independent formatting, indentation, and a trailing comment", () => {
    const withComment = `---\nstatus:   ready   # gate\ntitle: x\n---\nbody\n`;
    const r = rewriteSpecStatus(withComment, "ready", "in-progress");
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.content).toBe(`---\nstatus:   in-progress   # gate\ntitle: x\n---\nbody\n`);
  });

  it("handles a quoted status value", () => {
    const q = `---\nstatus: "ready"\n---\nbody\n`;
    const r = rewriteSpecStatus(q, "ready", "blocked");
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.content).toBe(`---\nstatus: blocked\n---\nbody\n`);
  });

  it("safely no-ops on absent frontmatter / absent status (never throws)", () => {
    expect(rewriteSpecStatus("no frontmatter here\n", "ready", "done")).toEqual({
      changed: false,
      reason: "no-frontmatter",
    });
    expect(rewriteSpecStatus(`---\ntitle: x\n---\nbody\n`, "ready", "done")).toEqual({
      changed: false,
      reason: "no-status-field",
    });
  });

  it("does not match a `status:` line in the BODY (only frontmatter)", () => {
    const bodyOnly = `---\ntitle: x\n---\nstatus: ready in prose\n`;
    expect(rewriteSpecStatus(bodyOnly, "ready", "in-progress")).toEqual({
      changed: false,
      reason: "no-status-field",
    });
  });
});

// ─── terminal-loop → spec status mapping (SPEC-2 §4) ───────────────────────────

describe("specStatusForTerminalLoop", () => {
  it("converged leaves the spec in-progress (code PR is the next gate — no auto-done)", () => {
    expect(specStatusForTerminalLoop("converged")).toBeNull();
  });
  it("stalled terminals → blocked (NOT ready — blocked never re-fires the watch)", () => {
    expect(specStatusForTerminalLoop("failed")?.to).toBe("blocked");
    expect(specStatusForTerminalLoop("stopped_cap")?.to).toBe("blocked");
    expect(specStatusForTerminalLoop("escalated")?.to).toBe("blocked");
    expect(specStatusForTerminalLoop("cancelled")?.to).toBe("blocked");
    // Never `ready`, never `done`.
    for (const s of ["failed", "stopped_cap", "escalated", "cancelled"]) {
      expect(specStatusForTerminalLoop(s)?.to).not.toBe("ready");
      expect(specStatusForTerminalLoop(s)?.to).not.toBe("done");
    }
  });
  it("non-terminal / unknown states never touch the spec", () => {
    expect(specStatusForTerminalLoop("reviewing")).toBeNull();
    expect(specStatusForTerminalLoop("awaiting_merge")).toBeNull();
  });
});

// ─── code-PR merge → done (SPEC-2 §4, GATE 2) ──────────────────────────────────

describe("specStatusForPrMerge", () => {
  it("ONLY a MERGED PR closes the spec → done", () => {
    expect(specStatusForPrMerge("MERGED")?.to).toBe("done");
    for (const s of ["OPEN", "DRAFT", "CLOSED", "unknown"]) {
      expect(specStatusForPrMerge(s)).toBeNull(); // never auto-done without a merge.
    }
  });
});

// ─── specRelPath (fenced) ──────────────────────────────────────────────────────

describe("specRelPath", () => {
  it("derives a repo-relative path inside the repo", () => {
    expect(specRelPath("/repo", "/repo/docs/specs/x.md")).toBe("docs/specs/x.md");
  });
  it("rejects paths that escape the repo (../ or absolute)", () => {
    expect(specRelPath("/repo", "/etc/passwd")).toBeNull();
    expect(specRelPath("/repo/a", "/repo/b/x.md")).toBeNull();
    expect(specRelPath("/repo", "/repo")).toBeNull();
  });
});

// ─── writeSpecStatusRemote (fake gh) ───────────────────────────────────────────

interface FakeOpts {
  defaultBranch?: string;
  fileStatus?: string; // the status in the remote file the GET returns
  sha?: string;
  putStderr?: string; // set → PUT throws this stderr (runGhCapture → {ok:false})
  contentsNull?: boolean; // GET returns null (gh degraded)
}

function fakeGh(opts: FakeOpts): { run: ExecFileFn; argv: string[][]; puts: string[][] } {
  const argv: string[][] = [];
  const puts: string[][] = [];
  const run: ExecFileFn = vi.fn(async (_file: string, args: string[]) => {
    argv.push(args);
    const json = (o: unknown) => ({ stdout: JSON.stringify(o), stderr: "" });
    if (args[0] === "repo" && args[1] === "view") {
      return json({ defaultBranchRef: { name: opts.defaultBranch ?? "main" } });
    }
    if (args[0] === "api" && args.indexOf("--method") === -1) {
      // GET contents.
      if (opts.contentsNull) return { stdout: "", stderr: "" };
      const content = Buffer.from(SPEC(opts.fileStatus ?? "ready"), "utf8").toString("base64");
      return json({ content, encoding: "base64", sha: opts.sha ?? "sha-abc" });
    }
    if (args[0] === "api" && args.indexOf("--method") !== -1) {
      puts.push(args);
      if (opts.putStderr !== undefined) throw Object.assign(new Error("gh failed"), { stderr: opts.putStderr });
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  return { run, argv, puts };
}

const DEPS = (run: ExecFileFn) => ({
  runGh: run,
  gitRemoteUrl: async () => "https://github.com/acme/widget.git",
  log: () => undefined,
});

const PARAMS = {
  specRepoPath: "/repo/widget",
  specPath: "/repo/widget/docs/specs/rate-limit.md",
  expectedFrom: "ready" as const,
  to: "in-progress" as const,
};

describe("writeSpecStatusRemote", () => {
  it("ready→in-progress: reads the blob then PUTs the flipped file with the read sha", async () => {
    const gh = fakeGh({ fileStatus: "ready", sha: "sha-xyz" });
    const res = await writeSpecStatusRemote(DEPS(gh.run), PARAMS);
    expect(res).toEqual({ ok: true, from: "ready", to: "in-progress" });
    // The PUT targets the repo-relative path on the default branch, carrying the sha.
    expect(gh.puts).toHaveLength(1);
    const put = gh.puts[0];
    expect(put.join(" ")).toContain("repos/acme/widget/contents/docs/specs/rate-limit.md");
    expect(put).toContain("sha=sha-xyz");
    expect(put).toContain("branch=main");
    // The committed content decodes to the in-progress spec.
    const contentArg = put.find((a) => a.startsWith("content="))!.slice("content=".length);
    expect(Buffer.from(contentArg, "base64").toString("utf8")).toBe(SPEC("in-progress"));
    // Commit message carries no AI mention.
    const msg = put.find((a) => a.startsWith("message="))!;
    expect(msg).toMatch(/status ready -> in-progress/);
    expect(msg.toLowerCase()).not.toMatch(/claude|anthropic|co-authored/);
  });

  it("status-mismatch (remote already moved) → no PUT, typed no-op", async () => {
    const gh = fakeGh({ fileStatus: "in-progress" }); // human/other tick already flipped
    const res = await writeSpecStatusRemote(DEPS(gh.run), PARAMS);
    expect(res).toEqual({ ok: false, reason: "unchanged" });
    expect(gh.puts).toHaveLength(0);
  });

  it("sha-conflict on PUT (concurrent write) → best-effort no-op, never throws", async () => {
    const gh = fakeGh({ fileStatus: "ready", putStderr: "HTTP 409: sha does not match" });
    const res = await writeSpecStatusRemote(DEPS(gh.run), PARAMS);
    expect(res).toEqual({ ok: false, reason: "sha-conflict" });
  });

  it("degrades safely when gh cannot read the file / origin is not github", async () => {
    const gh = fakeGh({ contentsNull: true });
    expect(await writeSpecStatusRemote(DEPS(gh.run), PARAMS)).toEqual({ ok: false, reason: "read-failed" });

    const badOrigin = { runGh: gh.run, gitRemoteUrl: async () => null, log: () => undefined };
    expect(await writeSpecStatusRemote(badOrigin, PARAMS)).toEqual({ ok: false, reason: "bad-origin" });
  });
});

// ─── reconcileSpecStatusOnPrMerge (code-PR → done hook) ────────────────────────

describe("reconcileSpecStatusOnPrMerge", () => {
  const specLoop = {
    state: "converged",
    prRef: "https://github.com/acme/widget/pull/9",
    triggerProvenance: { spec: { specPath: "/repo/widget/docs/specs/rate-limit.md" } },
  };

  it("MERGED code PR flips the spec in-progress → done", async () => {
    const gh = fakeGh({ fileStatus: "in-progress" });
    const res = await reconcileSpecStatusOnPrMerge(DEPS(gh.run), specLoop, "MERGED", "/repo/widget");
    expect(res).toEqual({ ok: true, from: "in-progress", to: "done" });
    expect(gh.puts).toHaveLength(1);
    expect(gh.puts[0].join(" ")).toContain("status in-progress -> done");
  });

  it("a non-merged PR never auto-dones the spec (no write)", async () => {
    const gh = fakeGh({ fileStatus: "in-progress" });
    expect(await reconcileSpecStatusOnPrMerge(DEPS(gh.run), specLoop, "OPEN", "/repo/widget")).toEqual({
      ok: false,
      reason: "pr-not-merged",
    });
    expect(gh.puts).toHaveLength(0);
  });

  it("ignores non-spec-fired loops / loops without a code PR", async () => {
    const gh = fakeGh({ fileStatus: "in-progress" });
    expect(
      await reconcileSpecStatusOnPrMerge(DEPS(gh.run), { ...specLoop, prRef: null }, "MERGED", "/repo/widget"),
    ).toEqual({ ok: false, reason: "no-pr-ref" });
    expect(
      await reconcileSpecStatusOnPrMerge(DEPS(gh.run), { ...specLoop, triggerProvenance: null }, "MERGED", "/repo/widget"),
    ).toEqual({ ok: false, reason: "not-spec-fired" });
  });
});
