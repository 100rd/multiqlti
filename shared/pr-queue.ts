/**
 * pr-queue.ts — pure, dependency-free helpers for the PR REVIEW QUEUE (design:
 * "what Draft PR is waiting for my review, and which are duplicate runs?").
 *
 * A consilium loop that develops opens a Draft PR and records its URL on
 * `consilium_loops.pr_ref`. Multiple loops can run against the SAME repoPath over
 * time, each opening its own Draft PR — so the same repo accrues several open
 * loop-PRs, newer runs SUPERSEDING older ones. This module holds the two pure
 * pieces both the server read-route and the client page share:
 *
 *   1. `isPrBearingLoop`  — the PR-bearing predicate (a loop worth queueing).
 *   2. `clusterPrQueue`   — group a flat item list by repo into duplicate CLUSTERS
 *                           with a newest-first order + supersede hints.
 *
 * DELIBERATELY STATE-BASED, NOT GITHUB-LIVE: the queue reflects the loop's FSM
 * STATE, never a live GitHub PR fetch. `awaiting_merge` is exactly the open-Draft-PR
 * review gate (merge-approval sends the loop back to `building_context`, so a loop
 * sitting in `awaiting_merge` genuinely has an un-merged Draft PR). `stopped_cap` /
 * `escalated` are terminal-with-verdict runs that may carry a Draft PR opened but
 * never merge-approved. We EXCLUDE `converged` (a converged/merged outcome),
 * `failed` and `cancelled` (aborted — any PR is abandoned, not "awaiting review").
 * Because we do not poll GitHub, a PR merged/closed directly on GitHub (bypassing
 * the merge-approved gate) can still appear until the loop's state advances — the
 * UI says so.
 *
 * SECURITY: pure data shaping. `repoPath`, `prRef`, `verdictSummary`, and
 * `triggerProvenance` are inert strings here; the rendering layer treats every
 * model/human-authored field as inert React text and opens `prRef` with
 * rel="noopener noreferrer".
 */
import type { ConsiliumLoopState } from "./schema.js";
import type { Archetype, OpenRemainder } from "./types.js";

/**
 * The loop states a Draft PR can be "waiting for review" in. Ordered by review
 * urgency (the active merge gate first). See the module doc for why the terminal
 * `converged`/`failed`/`cancelled` states are excluded.
 */
export const PR_BEARING_LOOP_STATES = [
  "awaiting_merge",
  "developing",
  "stopped_cap",
  "escalated",
] as const satisfies readonly ConsiliumLoopState[];

const PR_BEARING_SET: ReadonlySet<string> = new Set(PR_BEARING_LOOP_STATES);

/** The minimal loop shape the PR-bearing predicate reads (server row OR client item). */
export interface PrBearingLoopLike {
  prRef: string | null | undefined;
  state: ConsiliumLoopState;
}

/**
 * True when a loop belongs in the PR review queue: it carries a non-empty `prRef`
 * AND its state is one where that Draft PR is genuinely un-merged/awaiting review.
 * Both conditions are required — a `developing` loop has no `prRef` until the
 * develop→awaiting_merge transition, so the guard filters it out naturally.
 */
export function isPrBearingLoop(loop: PrBearingLoopLike): boolean {
  return (
    typeof loop.prRef === "string" &&
    loop.prRef.trim().length > 0 &&
    PR_BEARING_SET.has(loop.state)
  );
}

/**
 * One PR-bearing loop, shaped for the queue wire (GET /api/pr-queue). A flat list
 * of these is returned by the server; the client clusters it with
 * {@link clusterPrQueue}. All timestamps are ISO strings on the wire.
 */
export interface PrQueueItem {
  loopId: string;
  /** The Draft PR URL/ref (guaranteed non-empty — the route only emits PR-bearing loops). */
  prRef: string;
  repoPath: string;
  state: ConsiliumLoopState;
  round: number;
  archetype: Archetype | null;
  /** Loop creation time, ISO-8601. Drives the newest-first / supersede ordering. */
  createdAt: string;
  /** Loop last-update time, ISO-8601 — a better recency signal than createdAt when present. */
  updatedAt?: string | null;
  /** Compact verdict/test summary from the loop's latest round (inert text; may be clamped). */
  verdictSummary?: string | null;
  /** Count-by-priority of the last round's still-open action points, when non-empty. */
  openRemainder?: OpenRemainder | null;
  /**
   * How this loop was launched (e.g. a file-change trigger), when known. The current
   * loop schema carries no trigger→loop link, so the server leaves this undefined; the
   * field is part of the contract for forward-compat and the UI renders it only when present.
   */
  triggerProvenance?: string | null;
}

/**
 * A duplicate cluster: every queued PR-bearing loop that targets the SAME repo,
 * newest first. `duplicate` is true when more than one loop-PR is open for the repo
 * — the "N open PRs for this repo" case. The newest item is the LIKELY-CURRENT one;
 * the older ones are SUPERSEDE CANDIDATES (surfaced, never auto-closed).
 */
export interface PrQueueCluster {
  /** Normalized (trailing-slash-insensitive) repo path — the exact cluster key. */
  repoPath: string;
  /** Items for this repo, newest first (createdAt/updatedAt desc, loopId tie-break). */
  items: PrQueueItem[];
  /** True when the repo has more than one open loop-PR (a duplicate-run situation). */
  duplicate: boolean;
  /** The newest item's loopId — the run most likely to be the current one. */
  currentLoopId: string;
  /** The older items' loopIds — candidates a human may choose to close. */
  supersededLoopIds: string[];
}

/**
 * Trailing-slash-insensitive repo key so `/repo` and `/repo/` cluster together.
 * We cluster on the FULL path (never the basename): `/a/service` and `/b/service`
 * are DIFFERENT repos and MUST NOT be merged into one duplicate cluster.
 */
export function normalizeRepoPath(p: string): string {
  return p.replace(/\/+$/, "");
}

/** Epoch-ms recency: prefer updatedAt, fall back to createdAt; unparseable → 0. */
function recencyOf(item: PrQueueItem): number {
  const raw = item.updatedAt ?? item.createdAt;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Newest first; deterministic loopId tie-break so equal timestamps sort stably. */
function byNewest(a: PrQueueItem, b: PrQueueItem): number {
  const d = recencyOf(b) - recencyOf(a);
  if (d !== 0) return d;
  return a.loopId < b.loopId ? -1 : a.loopId > b.loopId ? 1 : 0;
}

/**
 * Group a flat PR-queue list into per-repo duplicate CLUSTERS.
 *
 * Rules:
 *   • cluster key = normalized full repoPath (different repos never merge);
 *   • within a cluster, items are newest first (recency, loopId tie-break);
 *   • `duplicate` = items.length > 1; `currentLoopId` = newest; the rest are
 *     `supersededLoopIds` (older loop-PRs on the same repo — close candidates);
 *   • clusters themselves are ordered most-recently-active repo first.
 *
 * Pure and total: an empty input yields an empty array; a single item yields one
 * non-duplicate cluster with no superseded ids.
 */
export function clusterPrQueue(items: PrQueueItem[]): PrQueueCluster[] {
  const byRepo = new Map<string, PrQueueItem[]>();
  for (const item of items) {
    const key = normalizeRepoPath(item.repoPath);
    const arr = byRepo.get(key);
    if (arr) arr.push(item);
    else byRepo.set(key, [item]);
  }

  const clusters: PrQueueCluster[] = [];
  for (const [repoPath, arr] of byRepo) {
    const sorted = [...arr].sort(byNewest);
    clusters.push({
      repoPath,
      items: sorted,
      duplicate: sorted.length > 1,
      currentLoopId: sorted[0].loopId,
      supersededLoopIds: sorted.slice(1).map((i) => i.loopId),
    });
  }

  // Most-recently-active repo first, so the freshest work floats to the top.
  clusters.sort((a, b) => recencyOf(b.items[0]) - recencyOf(a.items[0]));
  return clusters;
}
