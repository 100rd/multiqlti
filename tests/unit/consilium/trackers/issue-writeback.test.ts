/**
 * issue-writeback.test.ts — the idempotent, best-effort pickup / need-criteria
 * comments. FAKE `gh` by argv. Covers: first post writes once; a prior marker
 * short-circuits (no comment call); a gh failure never throws.
 */
import { describe, it, expect, vi } from "vitest";
import {
  postPickupComment,
  postNeedCriteriaComment,
  PICKUP_MARKER,
  NEED_CRITERIA_MARKER,
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
