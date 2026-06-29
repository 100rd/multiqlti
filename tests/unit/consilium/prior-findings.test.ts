/**
 * prior-findings.test.ts — Enh1 unit coverage for the round-history block.
 *
 * Covers the PURE `formatPriorFindings` (round > 1 inheritance) and its
 * round-trip through `buildDiffContext`'s new `priorFindings` param:
 *   - lists earlier rounds' open action points (title + priority) + P0 trend
 *   - rows with no action points degrade to their openP0 count
 *   - oldest-first whole-round truncation under a byte budget (+ omitted note)
 *   - header-only fallback, then null, when even one round will not fit
 *   - buildDiffContext appends the block AFTER the diff and byte-clamps it
 */
import { describe, it, expect, vi } from "vitest";
import { formatPriorFindings } from "../../../server/services/consilium/consilium-loop-controller.js";
import { buildDiffContext, type GitDiffClient } from "../../../server/services/consilium/diff-context.js";
import type { ConsiliumLoopRoundRow } from "@shared/schema";

const REPO = process.cwd();
const ALLOW = [REPO];
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

function fakeGit(overrides: Partial<GitDiffClient> = {}): GitDiffClient {
  return {
    revparse: vi.fn(async (args: string[]) => {
      const ref = args[args.length - 1];
      if (ref === "HEAD^{commit}") return HEAD_SHA + "\n";
      return ref.replace(/\^\{commit\}$/, "") + "\n";
    }),
    diff: vi.fn(async (args: string[]) =>
      args.includes("--stat") ? "stat" : "diff --git a/f b/f\n+x",
    ),
    ...overrides,
  };
}

function round(partial: Partial<ConsiliumLoopRoundRow> & { round: number }): ConsiliumLoopRoundRow {
  return {
    id: `r${partial.round}`,
    loopId: "loop-1",
    iterationNumber: partial.round,
    converged: false,
    openP0: 0,
    openActionPoints: [],
    baselineCommit: null,
    headCommit: null,
    testSummary: null,
    createdAt: new Date(),
    ...partial,
  } as ConsiliumLoopRoundRow;
}

describe("formatPriorFindings — assembly", () => {
  it("returns null with no rounds", () => {
    expect(formatPriorFindings([], 10_000)).toBeNull();
  });

  it("lists each round's action points (title + priority) and the P0 trend", () => {
    const rows = [
      round({
        round: 1,
        openP0: 2,
        openActionPoints: [
          { title: "Fix the race", priority: "P0" },
          { title: "Validate input", priority: "P0" },
          { title: "Add a metric", priority: "P2" },
        ],
      }),
      round({
        round: 2,
        openP0: 1,
        openActionPoints: [{ title: "Close the leak", priority: "P0" }],
      }),
    ];
    const out = formatPriorFindings(rows, 10_000);
    expect(out).not.toBeNull();
    expect(out).toContain("## Prior findings to verify (from earlier rounds)");
    expect(out).toContain("Open P0 trend across rounds: 2 -> 1");
    expect(out).toContain("### Round 1 (3 open, 2 P0)");
    expect(out).toContain("- [P0] Fix the race");
    expect(out).toContain("- [P2] Add a metric");
    expect(out).toContain("### Round 2 (1 open, 1 P0)");
    expect(out).toContain("- [P0] Close the leak");
    expect(out).toContain("VERIFY".toLowerCase()); // instruction present (lowercase 'verify')
  });

  it("degrades a round with no structured action points to its openP0 count", () => {
    const out = formatPriorFindings([round({ round: 1, openP0: 4, openActionPoints: null })], 10_000);
    expect(out).toContain("no structured action points recorded");
    expect(out).toContain("open P0: 4");
  });

  it("sorts rounds oldest-first regardless of input order", () => {
    const out = formatPriorFindings(
      [round({ round: 3, openP0: 0 }), round({ round: 1, openP0: 2 })],
      10_000,
    )!;
    expect(out.indexOf("### Round 1")).toBeLessThan(out.indexOf("### Round 3"));
    expect(out).toContain("Open P0 trend across rounds: 2 -> 0");
  });
});

describe("formatPriorFindings — oldest-first truncation under budget", () => {
  const big = (n: number, p: number) =>
    round({
      round: n,
      openP0: p,
      openActionPoints: Array.from({ length: 40 }, (_, i) => ({
        title: `round-${n}-item-${i}-${"x".repeat(60)}`,
        priority: "P0",
      })),
    });

  it("drops whole rounds oldest-first and notes the omission", () => {
    const out = formatPriorFindings([big(1, 5), big(2, 4), big(3, 3)], 4500)!;
    expect(out).not.toBeNull();
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(4500);
    expect(out).toContain("earlier round(s) omitted to fit the size budget");
    // newest round survives; oldest is dropped
    expect(out).toContain("round-3-item-0");
    expect(out).not.toContain("round-1-item-0");
  });

  it("falls back to a header-only block when not even the newest round fits", () => {
    const out = formatPriorFindings([big(1, 5), big(2, 4)], 600)!;
    expect(out).not.toBeNull();
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(600);
    expect(out).toContain("round(s) of detail omitted to fit the size budget");
    expect(out).toContain("Open P0 trend across rounds");
  });

  it("returns null when even the header will not fit the budget", () => {
    expect(formatPriorFindings([big(1, 5)], 50)).toBeNull();
  });
});

describe("buildDiffContext — priorFindings round-trip (Enh1)", () => {
  it("appends the prior-findings block AFTER the diff section on round > 1", async () => {
    const res = await buildDiffContext({
      repoPath: REPO,
      baselineCommit: BASE_SHA,
      objective: "Obj",
      allowedRepoPaths: ALLOW,
      maxDiffBytes: 10_000,
      priorFindings: "## Prior findings to verify (from earlier rounds)\n\n- [P0] Fix the race",
      gitClient: fakeGit(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input.indexOf("## Changes since last review")).toBeLessThan(
      res.input.indexOf("## Prior findings to verify"),
    );
    expect(res.input).toContain("- [P0] Fix the race");
  });

  it("byte-clamps an oversized prior-findings block and sets truncated", async () => {
    const huge = "## Prior findings to verify\n" + "Z".repeat(5000);
    const res = await buildDiffContext({
      repoPath: REPO,
      baselineCommit: BASE_SHA,
      objective: "Obj",
      allowedRepoPaths: ALLOW,
      maxDiffBytes: 1024,
      priorFindings: huge,
      gitClient: fakeGit(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.truncated).toBe(true);
    expect(res.input).toContain("prior findings truncated");
  });

  it("never injects prior findings on round 1 (null baseline)", async () => {
    const res = await buildDiffContext({
      repoPath: REPO,
      baselineCommit: null,
      objective: "Obj",
      allowedRepoPaths: ALLOW,
      maxDiffBytes: 10_000,
      priorFindings: "## Prior findings to verify\n- [P0] should NOT appear",
      gitClient: fakeGit(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).toBe("Obj");
    expect(res.input).not.toContain("Prior findings");
  });
});
