/**
 * github-trigger-dispatch.test.ts — the github_event → consilium-review seam
 * (maybeLaunchGitHubReview in server/services/consilium/trigger-dispatch.ts).
 *
 * The factory is INJECTED (`createReview`) so we assert the dispatch decision +
 * the event→params mapping + the §4 rails (dedup, kill-switch-via-null-reviewDeps,
 * provenance) without a DB / Express / ALS:
 *   - a pull_request(opened) envelope → factory called once with diff-pr-review on
 *     the PR head (ref=head sha, baselineCommit=base sha) + the PR label interpolated.
 *   - dedup: a non-terminal loop for the same repo → skipped-dedup, factory NOT called.
 *   - reviewDeps null (subsystem/kill-switch off) → skipped, factory NOT called.
 *   - an unsupported event (issues) → noop-event, factory NOT called.
 *   - no repoPath in the loop template → skipped.
 *   - provenance carries the human eventSummary (PR #N: title) for the passport.
 */
import { describe, it, expect, vi } from "vitest";
import type { TriggerRow, ConsiliumLoopRow } from "@shared/schema";
import {
  maybeLaunchGitHubReview,
  type ConsiliumTriggerDispatchDeps,
} from "../../../server/services/consilium/trigger-dispatch.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function makeTrigger(over: Partial<TriggerRow> = {}, action: unknown = { kind: "consilium_review", preset: "diff-pr-review", repoPath: "/allowed/omnius" }): TriggerRow {
  return {
    id: "gh-1",
    projectId: "proj-1",
    pipelineId: null,
    type: "github_event",
    config: { repository: "owner/repo", events: ["pull_request", "push"], action },
    ...over,
  } as unknown as TriggerRow;
}

function envelope(event: string, ghPayload: unknown, delivery = "deliv-1") {
  return { event, delivery, payload: ghPayload };
}

function prPayload(over: Record<string, unknown> = {}) {
  return {
    action: "opened",
    number: 42,
    pull_request: { title: "Add limiter", head: { sha: HEAD }, base: { sha: BASE } },
    repository: { full_name: "owner/repo", default_branch: "main" },
    ...over,
  };
}

function makeDeps(over: Partial<ConsiliumTriggerDispatchDeps> = {}) {
  const createReview = vi
    .fn()
    .mockResolvedValue({ id: "loop-1", repoPath: "/allowed/omnius", state: "reviewing" } as ConsiliumLoopRow);
  const runInProject = vi.fn().mockImplementation((_pid: string, fn: () => Promise<unknown>) => fn());
  const log = vi.fn();
  const getLoops = vi.fn().mockResolvedValue([] as ConsiliumLoopRow[]);
  const resolveOwnerId = vi.fn().mockResolvedValue("owner-1");
  // WRITE-on-fire: the success-branch counter write (lastFiredAt + firedCount).
  const recordFire = vi.fn().mockResolvedValue(undefined);
  const deps: ConsiliumTriggerDispatchDeps = {
    reviewDeps: { storage: { getLoops } } as unknown as ConsiliumTriggerDispatchDeps["reviewDeps"],
    createReview,
    runInProject,
    resolveOwnerId,
    recordFire,
    log,
    ...over,
  };
  return { deps, createReview, runInProject, log, getLoops, resolveOwnerId, recordFire };
}

describe("maybeLaunchGitHubReview", () => {
  it("pull_request(opened) → launches diff-pr-review on the PR head vs base", async () => {
    const { deps, createReview, runInProject, recordFire } = makeDeps();
    const trigger = makeTrigger();

    const result = await maybeLaunchGitHubReview(deps, trigger, envelope("pull_request", prPayload()));

    expect(result).toBe("launched");
    expect(runInProject).toHaveBeenCalledWith("proj-1", expect.any(Function));
    expect(createReview).toHaveBeenCalledTimes(1);
    // WRITE-on-fire also fires on the GITHUB path (shared seam) — the poller funnels
    // through the same `launchReviewWithDedup`, so a github fire records lastFiredAt.
    expect(recordFire).toHaveBeenCalledTimes(1);
    expect(recordFire.mock.calls[0][0]).toBe(trigger.id);
    expect(recordFire.mock.calls[0][1]).toBeInstanceOf(Date);
    const [, params] = createReview.mock.calls[0];
    expect(params.preset).toBe("diff-pr-review");
    expect(params.repoPath).toBe("/allowed/omnius");
    expect(params.ref).toBe(HEAD);
    expect(params.baselineCommit).toBe(BASE);
    expect(params.maxRounds).toBe(1); // review-only forced on the automated path
    expect(params.createdBy).toBe("owner-1"); // resolved project owner, not "system"
    // No operator instruction → the PR label rides objectiveExtra (fenced in factory).
    expect(params.objectiveExtra).toBe("PR #42: Add limiter");
    expect(params.engineerInstruction).toBeUndefined();
  });

  it("interpolates ${event} in the operator instruction with the PR label", async () => {
    const { deps, createReview } = makeDeps();
    const trigger = makeTrigger({}, {
      kind: "consilium_review",
      preset: "diff-pr-review",
      repoPath: "/allowed/omnius",
      engineerInstruction: "Review this PR: ${event}",
    });

    await maybeLaunchGitHubReview(deps, trigger, envelope("pull_request", prPayload()));
    const [, params] = createReview.mock.calls[0];
    expect(params.engineerInstruction).toBe("Review this PR: PR #42: Add limiter");
    expect(params.objectiveExtra).toBeUndefined();
  });

  it("records the human eventSummary in provenance (passport: PR #N)", async () => {
    const { deps, createReview } = makeDeps();
    await maybeLaunchGitHubReview(deps, makeTrigger(), envelope("pull_request", prPayload()));
    const [, params] = createReview.mock.calls[0];
    expect(params.triggerProvenance.triggerType).toBe("github_event");
    expect(params.triggerProvenance.eventSummary).toBe("PR #42: Add limiter");
    expect(params.triggerProvenance.eventDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("push to the default branch → post-merge diff review", async () => {
    const { deps, createReview } = makeDeps();
    const trigger = makeTrigger();
    const push = {
      ref: "refs/heads/main",
      before: BASE,
      after: HEAD,
      repository: { full_name: "owner/repo", default_branch: "main" },
    };
    const result = await maybeLaunchGitHubReview(deps, trigger, envelope("push", push));
    expect(result).toBe("launched");
    const [, params] = createReview.mock.calls[0];
    expect(params.preset).toBe("diff-pr-review");
    expect(params.ref).toBe(HEAD);
    expect(params.baselineCommit).toBe(BASE);
  });

  it("DEDUP: a non-terminal loop for the same repo → skipped-dedup, factory NOT called", async () => {
    const getLoops = vi.fn().mockResolvedValue([
      { id: "loop-active", repoPath: "/allowed/omnius", state: "reviewing" },
    ] as unknown as ConsiliumLoopRow[]);
    const { deps, createReview, log } = makeDeps({
      reviewDeps: { storage: { getLoops } } as unknown as ConsiliumTriggerDispatchDeps["reviewDeps"],
    });
    const result = await maybeLaunchGitHubReview(deps, makeTrigger(), envelope("pull_request", prPayload()));
    expect(result).toBe("skipped-dedup");
    expect(createReview).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/skipped-dedup.*loop-active/));
  });

  it("reviewDeps null (kill-switch/subsystem off) → skipped, factory NOT called", async () => {
    const { deps, createReview } = makeDeps({ reviewDeps: null });
    const result = await maybeLaunchGitHubReview(deps, makeTrigger(), envelope("pull_request", prPayload()));
    expect(result).toBe("skipped");
    expect(createReview).not.toHaveBeenCalled();
  });

  it("unsupported event (issues) → noop-event, factory NOT called, no error", async () => {
    const { deps, createReview, log } = makeDeps();
    const result = await maybeLaunchGitHubReview(deps, makeTrigger(), envelope("issues", { action: "opened" }));
    expect(result).toBe("noop-event");
    expect(createReview).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no-op for issues/));
  });

  it("loop template without a repoPath → skipped", async () => {
    const { deps, createReview } = makeDeps();
    const trigger = makeTrigger({}, { kind: "consilium_review", preset: "diff-pr-review" });
    const result = await maybeLaunchGitHubReview(deps, trigger, envelope("pull_request", prPayload()));
    expect(result).toBe("skipped");
    expect(createReview).not.toHaveBeenCalled();
  });

  it("a factory throw (allowlist rejection) is caught → failed", async () => {
    const createReview = vi.fn().mockRejectedValue(new Error("[repo-allowlist] outside every allowed repo root"));
    const { deps, log } = makeDeps({ createReview });
    const trigger = makeTrigger({}, { kind: "consilium_review", preset: "diff-pr-review", repoPath: "/evil" });
    const result = await maybeLaunchGitHubReview(deps, trigger, envelope("pull_request", prPayload()));
    expect(result).toBe("failed");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/rejected/));
  });
});
