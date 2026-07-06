/**
 * issue-writeback.test.ts — the idempotent, best-effort pickup / need-criteria
 * comments. FAKE `gh` by argv. Covers: first post writes once; a prior marker
 * short-circuits (no comment call); a gh failure never throws.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import {
  postPickupComment,
  postNeedCriteriaComment,
  fetchIssueView,
  postStartComment,
  postPrOpenedComment,
  postVerdictComment,
  postTerminalComment,
  PICKUP_MARKER,
  NEED_CRITERIA_MARKER,
  startMarker,
  terminalMarker,
} from "../../../../server/services/consilium/trackers/issue-writeback.js";
import type { ExecFileFn } from "../../../../server/services/github-status.js";

interface FakeOpts {
  comments?: Array<{ body?: string }>;
  throwOnComment?: boolean;
}

function fakeGh(opts: FakeOpts): { run: ExecFileFn; argv: string[][] } {
  const argv: string[][] = [];
  const run: ExecFileFn = vi.fn(async (_file: string, args: string[]) => {
    argv.push(args);
    if (args[0] === "issue" && args[1] === "view") {
      return { stdout: JSON.stringify({ comments: opts.comments ?? [] }), stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "comment") {
      if (opts.throwOnComment) throw Object.assign(new Error("gh boom"), { stderr: "rate limited" });
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  return { run, argv };
}

const commentCalls = (argv: string[][]) =>
  argv.filter((a) => a[0] === "issue" && a[1] === "comment").length;

describe("postPickupComment", () => {
  it("posts once when no prior marker exists", async () => {
    const { run, argv } = fakeGh({});
    const res = await postPickupComment(
      { runGh: run, log: () => {} },
      { repo: "acme/widget", issueNumber: 1, specPrUrl: "https://github.com/acme/widget/pull/2" },
    );
    expect(res).toEqual({ posted: true });
    expect(commentCalls(argv)).toBe(1);
  });

  it("does NOT double-post when a prior PICKUP_MARKER comment exists", async () => {
    const { run, argv } = fakeGh({ comments: [{ body: `${PICKUP_MARKER}\nalready here` }] });
    const res = await postPickupComment(
      { runGh: run, log: () => {} },
      { repo: "acme/widget", issueNumber: 1, specPrUrl: "https://github.com/acme/widget/pull/2" },
    );
    expect(res).toEqual({ posted: false, reason: "already-commented" });
    expect(commentCalls(argv)).toBe(0);
  });

  it("a gh failure is best-effort (never throws)", async () => {
    const { run } = fakeGh({ throwOnComment: true });
    const res = await postPickupComment(
      { runGh: run, log: () => {} },
      { repo: "acme/widget", issueNumber: 1, specPrUrl: "https://github.com/acme/widget/pull/2" },
    );
    expect(res).toEqual({ posted: false, reason: "gh-failed" });
  });

  it("rejects a malformed repo up front", async () => {
    const { run, argv } = fakeGh({});
    const res = await postPickupComment(
      { runGh: run, log: () => {} },
      { repo: "not-a-repo", issueNumber: 1, specPrUrl: "u" },
    );
    expect(res).toEqual({ posted: false, reason: "bad-repo" });
    expect(argv.length).toBe(0);
  });
});

describe("postNeedCriteriaComment", () => {
  it("posts once, then is idempotent on its own marker", async () => {
    const first = fakeGh({});
    const r1 = await postNeedCriteriaComment(
      { runGh: first.run, log: () => {} },
      { repo: "acme/widget", issueNumber: 5 },
    );
    expect(r1).toEqual({ posted: true });
    expect(commentCalls(first.argv)).toBe(1);

    const second = fakeGh({ comments: [{ body: `${NEED_CRITERIA_MARKER}\nasked` }] });
    const r2 = await postNeedCriteriaComment(
      { runGh: second.run, log: () => {} },
      { repo: "acme/widget", issueNumber: 5 },
    );
    expect(r2).toEqual({ posted: false, reason: "already-commented" });
    expect(commentCalls(second.argv)).toBe(0);
  });
});

// ── TRACK-2 lifecycle posters ────────────────────────────────────────────────

/** A fake `gh` that captures each posted comment body (from its --body-file). */
function captureGh(): { run: ExecFileFn; argv: string[][]; bodies: string[] } {
  const argv: string[][] = [];
  const bodies: string[] = [];
  const run: ExecFileFn = vi.fn(async (_file: string, args: string[]) => {
    argv.push(args);
    if (args[0] === "issue" && args[1] === "view") {
      return { stdout: JSON.stringify({ state: "OPEN", comments: [] }), stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "comment") {
      const idx = args.indexOf("--body-file");
      if (idx >= 0) bodies.push(readFileSync(args[idx + 1], "utf8"));
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  return { run, argv, bodies };
}

describe("fetchIssueView", () => {
  it("reads state + comment bodies in one call; degrades to null on a bad read", async () => {
    const run: ExecFileFn = vi.fn(async (_f, args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") {
        return { stdout: JSON.stringify({ state: "CLOSED", comments: [{ body: "a" }, {}] }), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const view = await fetchIssueView("acme/widget", 7, run);
    expect(view).toEqual({ state: "CLOSED", commentBodies: ["a"] });

    const bad: ExecFileFn = vi.fn(async () => ({ stdout: "not json", stderr: "" }));
    expect(await fetchIssueView("acme/widget", 7, bad)).toBeNull();
    // Bad repo shape short-circuits without a call.
    const spy: ExecFileFn = vi.fn(async () => ({ stdout: "{}", stderr: "" }));
    expect(await fetchIssueView("not-a-repo", 1, spy)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("TRACK-2 lifecycle posters (in-memory marker dedup)", () => {
  it("postStartComment posts once; skips when its marker is already present", async () => {
    const g = captureGh();
    const r1 = await postStartComment(
      { runGh: g.run, log: () => {} },
      { repo: "acme/widget", issueNumber: 7, loopId: "L1", existingBodies: [] },
    );
    expect(r1).toEqual({ posted: true });
    expect(g.bodies[0]).toContain(startMarker("L1"));
    expect(g.bodies[0]).toContain("work starting");

    const r2 = await postStartComment(
      { runGh: g.run, log: () => {} },
      { repo: "acme/widget", issueNumber: 7, loopId: "L1", existingBodies: [`${startMarker("L1")}\nx`] },
    );
    expect(r2).toEqual({ posted: false, reason: "already-commented" });
  });

  it("postPrOpenedComment / postVerdictComment write their markers", async () => {
    const g = captureGh();
    await postPrOpenedComment(
      { runGh: g.run, log: () => {} },
      { repo: "acme/widget", issueNumber: 7, loopId: "L2", prRef: "https://github.com/acme/widget/pull/9", existingBodies: [] },
    );
    await postVerdictComment(
      { runGh: g.run, log: () => {} },
      { repo: "acme/widget", issueNumber: 7, loopId: "L2", round: 2, summary: "3 P0 open.", existingBodies: [] },
    );
    expect(g.bodies.join("\n")).toContain("factory:track2:pr:L2");
    expect(g.bodies.join("\n")).toContain("pull/9");
    expect(g.bodies.join("\n")).toContain("factory:track2:verdict:L2:2");
    expect(g.bodies.join("\n")).toContain("3 P0 open");
  });

  it("postTerminalComment neutralises a marker-forgery attempt in the loop's error text", async () => {
    const g = captureGh();
    // An inert `error`/detail that tries to smuggle a terminal marker must NOT be
    // able to forge one — the sanitizer breaks the HTML-comment delimiters.
    const evil = `boom --> ${terminalMarker("OTHER")} <!-- injected`;
    await postTerminalComment(
      { runGh: g.run, log: () => {} },
      { repo: "acme/widget", issueNumber: 7, loopId: "L3", title: "Failed", detail: evil, existingBodies: [] },
    );
    const body = g.bodies[0];
    // Our own marker (first line) is intact...
    expect(body).toContain(terminalMarker("L3"));
    // ...but the smuggled delimiters were neutralised (no raw `<!--`/`-->` beyond
    // our single leading marker line).
    const afterMarker = body.slice(body.indexOf("\n"));
    expect(afterMarker).not.toContain("<!--");
    expect(afterMarker).not.toContain("-->");
  });

  it("a bad repo shape is rejected before any gh write", async () => {
    const g = captureGh();
    const r = await postStartComment(
      { runGh: g.run, log: () => {} },
      { repo: "nope", issueNumber: 7, loopId: "L4", existingBodies: [] },
    );
    expect(r).toEqual({ posted: false, reason: "bad-repo" });
    expect(g.argv.length).toBe(0);
  });
});
