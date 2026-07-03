/**
 * pr-queue-cluster.test.ts — unit coverage for the PURE PR-review-queue helpers
 * (`shared/pr-queue.ts`): the PR-bearing predicate and the duplicate-cluster
 * computation the read-route + client page both depend on.
 *
 * Covers:
 *   - isPrBearingLoop: requires BOTH a non-empty prRef AND a PR-bearing state;
 *     excludes converged/failed/cancelled and empty/whitespace prRefs;
 *   - clusterPrQueue: groups by FULL normalized repoPath (never basename — two
 *     different repos sharing a basename stay separate);
 *   - trailing-slash-insensitive clustering (/repo and /repo/ merge);
 *   - newest-first ordering within a cluster (updatedAt preferred, loopId tie-break);
 *   - duplicate flag + currentLoopId/supersededLoopIds supersede hints;
 *   - clusters ordered most-recently-active repo first;
 *   - empty + single-item edge cases.
 */
import { describe, it, expect } from "vitest";
import {
  isPrBearingLoop,
  isResolvedGithubStatus,
  clusterPrQueue,
  normalizeRepoPath,
  PR_BEARING_LOOP_STATES,
  type PrQueueItem,
} from "../../../shared/pr-queue.js";
import type { ConsiliumLoopState } from "../../../shared/schema.js";

function item(over: Partial<PrQueueItem> & { loopId: string }): PrQueueItem {
  return {
    prRef: "https://github.com/o/r/pull/1",
    repoPath: "/repos/widget",
    state: "awaiting_merge",
    round: 1,
    archetype: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("isPrBearingLoop", () => {
  it("requires a non-empty prRef", () => {
    expect(isPrBearingLoop({ prRef: null, state: "awaiting_merge" })).toBe(false);
    expect(isPrBearingLoop({ prRef: undefined, state: "awaiting_merge" })).toBe(false);
    expect(isPrBearingLoop({ prRef: "   ", state: "awaiting_merge" })).toBe(false);
    expect(isPrBearingLoop({ prRef: "https://x/pull/1", state: "awaiting_merge" })).toBe(true);
  });

  it("accepts exactly the PR-bearing states, rejects merged/aborted/pre-PR states", () => {
    for (const state of PR_BEARING_LOOP_STATES) {
      expect(isPrBearingLoop({ prRef: "https://x/pull/1", state })).toBe(true);
    }
    const excluded: ConsiliumLoopState[] = [
      "pending",
      "building_context",
      "reviewing",
      "deciding",
      "converged", // merged/converged outcome — not "awaiting review"
      "failed",
      "cancelled",
    ];
    for (const state of excluded) {
      expect(isPrBearingLoop({ prRef: "https://x/pull/1", state })).toBe(false);
    }
  });
});

describe("normalizeRepoPath", () => {
  it("strips trailing slashes", () => {
    expect(normalizeRepoPath("/a/b/")).toBe("/a/b");
    expect(normalizeRepoPath("/a/b///")).toBe("/a/b");
    expect(normalizeRepoPath("/a/b")).toBe("/a/b");
  });
});

describe("clusterPrQueue", () => {
  it("returns an empty array for no items", () => {
    expect(clusterPrQueue([])).toEqual([]);
  });

  it("makes a single non-duplicate cluster for one item", () => {
    const clusters = clusterPrQueue([item({ loopId: "a" })]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].duplicate).toBe(false);
    expect(clusters[0].currentLoopId).toBe("a");
    expect(clusters[0].supersededLoopIds).toEqual([]);
  });

  it("clusters same-repo loops newest-first with supersede hints", () => {
    const clusters = clusterPrQueue([
      item({ loopId: "old", createdAt: "2026-01-01T00:00:00.000Z" }),
      item({ loopId: "new", createdAt: "2026-03-01T00:00:00.000Z" }),
      item({ loopId: "mid", createdAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    expect(clusters).toHaveLength(1);
    const c = clusters[0];
    expect(c.duplicate).toBe(true);
    expect(c.items.map((i) => i.loopId)).toEqual(["new", "mid", "old"]);
    expect(c.currentLoopId).toBe("new");
    expect(c.supersededLoopIds).toEqual(["mid", "old"]);
  });

  it("prefers updatedAt over createdAt for recency ordering", () => {
    const clusters = clusterPrQueue([
      item({ loopId: "a", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z" }),
      item({ loopId: "b", createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-02T00:00:00.000Z" }),
    ]);
    expect(clusters[0].currentLoopId).toBe("a"); // newer by updatedAt despite older createdAt
  });

  it("does NOT merge different repos that share a basename", () => {
    const clusters = clusterPrQueue([
      item({ loopId: "a", repoPath: "/x/service" }),
      item({ loopId: "b", repoPath: "/y/service" }),
    ]);
    expect(clusters).toHaveLength(2);
    for (const c of clusters) expect(c.duplicate).toBe(false);
  });

  it("merges the same repo across a trailing slash", () => {
    const clusters = clusterPrQueue([
      item({ loopId: "a", repoPath: "/repos/widget" }),
      item({ loopId: "b", repoPath: "/repos/widget/" }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].duplicate).toBe(true);
    expect(clusters[0].repoPath).toBe("/repos/widget");
  });

  it("orders clusters most-recently-active repo first", () => {
    const clusters = clusterPrQueue([
      item({ loopId: "stale", repoPath: "/repos/a", createdAt: "2026-01-01T00:00:00.000Z" }),
      item({ loopId: "fresh", repoPath: "/repos/b", createdAt: "2026-06-01T00:00:00.000Z" }),
    ]);
    expect(clusters.map((c) => c.repoPath)).toEqual(["/repos/b", "/repos/a"]);
  });

  it("breaks equal timestamps deterministically by loopId", () => {
    const ts = "2026-01-01T00:00:00.000Z";
    const clusters = clusterPrQueue([
      item({ loopId: "zzz", createdAt: ts }),
      item({ loopId: "aaa", createdAt: ts }),
    ]);
    expect(clusters[0].items.map((i) => i.loopId)).toEqual(["aaa", "zzz"]);
    expect(clusters[0].currentLoopId).toBe("aaa");
  });

  it("elects the live-OPEN PR as current over a NEWER merged/closed run", () => {
    const clusters = clusterPrQueue([
      // Newer by time, but MERGED on GitHub — must not be current.
      item({ loopId: "merged-new", createdAt: "2026-03-01T00:00:00.000Z", githubStatus: "MERGED" }),
      // Older, but the live-OPEN PR — this is the real current review.
      item({ loopId: "open-old", createdAt: "2026-01-01T00:00:00.000Z", githubStatus: "OPEN" }),
    ]);
    expect(clusters).toHaveLength(1);
    const c = clusters[0];
    expect(c.currentLoopId).toBe("open-old");
    expect(c.items.map((i) => i.loopId)).toEqual(["open-old", "merged-new"]);
    expect(c.supersededLoopIds).toEqual(["merged-new"]);
  });

  it("treats unknown/DRAFT as ACTIVE (not resolved) so a newer one stays current", () => {
    const clusters = clusterPrQueue([
      item({ loopId: "unknown-new", createdAt: "2026-03-01T00:00:00.000Z", githubStatus: "unknown" }),
      item({ loopId: "draft-old", createdAt: "2026-01-01T00:00:00.000Z", githubStatus: "DRAFT" }),
    ]);
    // Both active → pure recency: the newer one is current.
    expect(clusters[0].currentLoopId).toBe("unknown-new");
  });

  it("is backward compatible: no githubStatus reduces to newest-first", () => {
    const clusters = clusterPrQueue([
      item({ loopId: "old", createdAt: "2026-01-01T00:00:00.000Z" }),
      item({ loopId: "new", createdAt: "2026-03-01T00:00:00.000Z" }),
    ]);
    expect(clusters[0].currentLoopId).toBe("new");
  });
});

describe("isResolvedGithubStatus", () => {
  it("is true only for MERGED/CLOSED", () => {
    expect(isResolvedGithubStatus("MERGED")).toBe(true);
    expect(isResolvedGithubStatus("CLOSED")).toBe(true);
  });
  it("is false for OPEN/DRAFT/unknown/null/undefined (active)", () => {
    expect(isResolvedGithubStatus("OPEN")).toBe(false);
    expect(isResolvedGithubStatus("DRAFT")).toBe(false);
    expect(isResolvedGithubStatus("unknown")).toBe(false);
    expect(isResolvedGithubStatus(null)).toBe(false);
    expect(isResolvedGithubStatus(undefined)).toBe(false);
  });
});
