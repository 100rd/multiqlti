/**
 * github-event-map.test.ts — the PURE GitHub-event → review mapping
 * (server/services/consilium/github-event-map.ts). No I/O: asserts the
 * event→(preset, ref, baseline, label) decision + the no-op fencing.
 */
import { describe, it, expect } from "vitest";
import {
  mapGitHubEventToReview,
  sanitizeEventLabel,
} from "../../../server/services/consilium/github-event-map.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const AFTER = "c".repeat(40);
const BEFORE = "d".repeat(40);
const ZERO = "0".repeat(40);

function prPayload(over: Record<string, unknown> = {}, prOver: Record<string, unknown> = {}) {
  return {
    action: "opened",
    number: 42,
    pull_request: {
      title: "Add rate limiter",
      head: { sha: HEAD },
      base: { sha: BASE },
      ...prOver,
    },
    repository: { full_name: "owner/repo", default_branch: "main" },
    ...over,
  };
}

describe("mapGitHubEventToReview — pull_request", () => {
  it("opened → diff-pr-review on the PR head vs base, with a PR #N: title label", () => {
    const r = mapGitHubEventToReview("pull_request", prPayload());
    expect(r.kind).toBe("review");
    if (r.kind !== "review") return;
    expect(r.mapping.preset).toBe("diff-pr-review");
    expect(r.mapping.ref).toBe(HEAD);
    expect(r.mapping.baselineCommit).toBe(BASE);
    expect(r.mapping.eventLabel).toBe("PR #42: Add rate limiter");
  });

  it("synchronize and reopened also fire", () => {
    for (const action of ["synchronize", "reopened"]) {
      expect(mapGitHubEventToReview("pull_request", prPayload({ action })).kind).toBe("review");
    }
  });

  it("closed / edited / labeled → no-op (not reviewable)", () => {
    for (const action of ["closed", "edited", "labeled"]) {
      const r = mapGitHubEventToReview("pull_request", prPayload({ action }));
      expect(r.kind).toBe("noop");
    }
  });

  it("no-op when the head sha is missing or not a commit id", () => {
    expect(mapGitHubEventToReview("pull_request", prPayload({}, { head: {} })).kind).toBe("noop");
    expect(
      mapGitHubEventToReview("pull_request", prPayload({}, { head: { sha: "not-a-sha" } })).kind,
    ).toBe("noop");
    // An all-zero sha is rejected too (no real commit).
    expect(
      mapGitHubEventToReview("pull_request", prPayload({}, { head: { sha: ZERO } })).kind,
    ).toBe("noop");
  });

  it("no-op when the base sha is missing (no diff baseline)", () => {
    expect(mapGitHubEventToReview("pull_request", prPayload({}, { base: {} })).kind).toBe("noop");
  });

  it("UNTRUSTED PR title is single-line control-stripped in the label", () => {
    const r = mapGitHubEventToReview(
      "pull_request",
      prPayload({}, { title: "line1\nline2\tINJECT ${event}" }),
    );
    if (r.kind !== "review") throw new Error("expected review");
    expect(r.mapping.eventLabel).toBe("PR #42: line1 line2 INJECT ${event}");
    expect(r.mapping.eventLabel).not.toContain("\n");
    expect(r.mapping.eventLabel).not.toContain("\t");
  });
});

describe("mapGitHubEventToReview — push", () => {
  function push(over: Record<string, unknown> = {}) {
    return {
      ref: "refs/heads/main",
      before: BEFORE,
      after: AFTER,
      repository: { full_name: "owner/repo", default_branch: "main" },
      ...over,
    };
  }

  it("push to the default branch → post-merge diff review (before..after)", () => {
    const r = mapGitHubEventToReview("push", push());
    expect(r.kind).toBe("review");
    if (r.kind !== "review") return;
    expect(r.mapping.preset).toBe("diff-pr-review");
    expect(r.mapping.baselineCommit).toBe(BEFORE);
    expect(r.mapping.ref).toBe(AFTER);
    expect(r.mapping.eventLabel).toBe(`post-merge push to main (${AFTER.slice(0, 7)})`);
  });

  it("push to a NON-default branch → no-op", () => {
    const r = mapGitHubEventToReview("push", push({ ref: "refs/heads/feature/x" }));
    expect(r.kind).toBe("noop");
  });

  it("branch-create push (before all-zero) → sdlc-cross-review at the new tip", () => {
    const r = mapGitHubEventToReview("push", push({ before: ZERO }));
    expect(r.kind).toBe("review");
    if (r.kind !== "review") return;
    expect(r.mapping.preset).toBe("sdlc-cross-review");
    expect(r.mapping.ref).toBe(AFTER);
    expect(r.mapping.baselineCommit).toBeUndefined();
  });

  it("no-op when after is not a commit id", () => {
    expect(mapGitHubEventToReview("push", push({ after: "nope" })).kind).toBe("noop");
  });
});

describe("mapGitHubEventToReview — unmapped events", () => {
  it("ping / issues / release → no-op with a reason (accepted, never an error)", () => {
    for (const ev of ["ping", "issues", "release", "workflow_run", ""]) {
      const r = mapGitHubEventToReview(ev, {});
      expect(r.kind).toBe("noop");
      if (r.kind === "noop") expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("sanitizeEventLabel", () => {
  it("strips control chars, collapses whitespace, clamps length", () => {
    expect(sanitizeEventLabel("  a\n\tb   c  ")).toBe("a b c");
    expect(sanitizeEventLabel("x".repeat(500)).length).toBe(200);
  });
});
