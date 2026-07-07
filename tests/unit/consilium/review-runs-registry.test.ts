/**
 * review-runs-registry.test.ts — Phase 2 (direct review runner), Round 1 unit
 * coverage for the `reviewRuns` registry ONLY. Same risk class as Phase 1's
 * `sdlcRuns` (BUG-1 — a background job outliving a naive time-only grace check
 * re-dispatches a duplicate). Mirrors the `sdlcRuns` suite in
 * `tests/unit/consilium/loop-fsm.test.ts`, adapted per team-lead + Architect
 * sign-off (2026-07-07):
 *
 *   - Round 1 (B3) is FULLY ISOLATED — no `tick()`/FSM wiring yet (that's B4,
 *     Round 2). These tests call the registry methods (`dispatchReview`,
 *     `settleReviewRun`) DIRECTLY, exactly like `loop-fsm.test.ts`'s
 *     "IDEMPOTENT SETTLE (c)" test calls `settleSdlcRun` directly instead of
 *     going through `tick()`.
 *   - `deps.runReview?` (mirrors `runSdlc?`/`runResearch?`) — CONFIRMED.
 *   - `round.participants` shape is `RoundParticipant { name: string; model:
 *     string; role: "primary" | "rebuttal"; text: string }[] | null` —
 *     CONFIRMED (Backend B1 = Frontend F1-A, one shared type in
 *     shared/types.ts once it lands — task #19). NOT `CompositionRole`.
 *   - MARKER: a runner-path round keeps `currentIterationNumber` NULL always
 *     (mirrors `devGroupId` staying null for `developing`) — dispatch must
 *     NEVER set it to `loop.round` or anything else. This file asserts that.
 *   - Redrive (`claimRedrive` winner-only) and the cross-instance single-flight
 *     case are INTEGRATION-level (real atomic-DB CAS, same as Phase 1's
 *     sdlcRuns cross-instance tests) — NOT in this file. Tick-wiring end-to-end
 *     (kill-switch parity, straddle) is Round 2 (B4) — also not in this file.
 *
 * `dispatchReview`/`settleReviewRun` are still UNCONFIRMED exact names (team-
 * lead used them descriptively; Backend's actual code may differ slightly) —
 * every access goes through an `as unknown as {...}` cast, so a rename is a
 * one-place edit. Expect this file to be RED (or need a mechanical rename)
 * until Backend's B3 lands; that's the point — it's the target contract,
 * written before the implementation (TDD).
 */
import { describe, it, expect, vi } from "vitest";
import { ConsiliumLoopController } from "../../../server/services/consilium/consilium-loop-controller.js";
import type { ConsiliumLoopRow } from "@shared/schema";
import type { ActionPoint } from "@shared/types";

/** Confirmed shape (Architect, 2026-07-07) — Backend B1 col / Frontend F1-A render type. */
interface RoundParticipant {
  name: string;
  model: string;
  role: "primary" | "rebuttal";
  text: string;
}

/** Best-guess RoundVerdict-shaped result the runner produces per round. */
interface ReviewRunResult {
  converged: boolean;
  openP0: number;
  openActionPoints: ActionPoint[];
  verdict: { verdict: string; pros: string[]; cons: string[]; actionPoints: ActionPoint[] } | null;
  participants: RoundParticipant[] | null;
  error?: string;
}

/** Best-guess registry entry shape, mirroring `SdlcRun`. */
interface ReviewRun {
  round: number;
  done: boolean;
  result?: ReviewRunResult;
}

function makeLoop(over: Partial<ConsiliumLoopRow>): ConsiliumLoopRow {
  return {
    id: "loop1",
    groupId: "grp1",
    state: "reviewing",
    round: 1,
    maxRounds: 6,
    repoPath: process.cwd(),
    lastReviewedCommit: null,
    // MARKER (Architect, confirmed): the runner path keeps this NULL always —
    // mirrors devGroupId staying null for `developing`. Never set to loop.round.
    currentIterationNumber: null,
    devGroupId: null,
    prRef: null,
    headCommitAtReview: null,
    openP0: null,
    error: null,
    createdBy: "user1",
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    ...over,
  } as ConsiliumLoopRow;
}

const goodResult = (over: Partial<ReviewRunResult> = {}): ReviewRunResult => ({
  converged: false,
  openP0: 1,
  openActionPoints: [{ title: "fix null check", priority: "P0" }],
  verdict: {
    verdict: "one blocking issue",
    pros: ["clean tests"],
    cons: ["missing check"],
    actionPoints: [{ title: "fix null check", priority: "P0" }],
  },
  participants: [
    { name: "Opus", model: "claude-opus", role: "primary", text: "primary1 findings" },
    { name: "Gemini", model: "gemini-3.1-pro", role: "primary", text: "primary2 findings" },
  ],
  ...over,
});

/** Minimal controller — Round-1 registry methods don't need storage/orchestrator
 *  (mirrors the exact minimalism of loop-fsm.test.ts's "IDEMPOTENT SETTLE" test). */
function makeController(runReview?: (loop: ConsiliumLoopRow) => Promise<ReviewRunResult>) {
  return new ConsiliumLoopController({
    storage: {} as never,
    taskOrchestrator: {} as never,
    config: (() => ({ pipeline: { consiliumLoop: { enabled: true, directReview: { enabled: true } } } })) as never,
    runReview,
  } as never);
}

/** Reach into the not-yet-existing registry/dispatch/settle internals. */
function internalsOf(controller: ConsiliumLoopController) {
  return controller as unknown as {
    reviewRuns: Map<string, ReviewRun>;
    dispatchReview(loop: ConsiliumLoopRow): void;
    settleReviewRun(loopId: string, run: ReviewRun, result: ReviewRunResult): void;
  };
}

describe("dispatchReview — registers the run SYNCHRONOUSLY, before runReview resolves", () => {
  it("reviewRuns carries {round, done:false} immediately after the (sync, fire-and-forget) call", () => {
    const loop = makeLoop({ round: 1 });
    let releaseRunReview: (r: ReviewRunResult) => void = () => {};
    const runReview = vi.fn(
      () => new Promise<ReviewRunResult>((resolve) => { releaseRunReview = resolve; }),
    );
    const controller = makeController(runReview);
    const c = internalsOf(controller);

    c.dispatchReview(loop); // NOT awaited — mirrors dispatchSdlc's fire-and-forget shape

    expect(c.reviewRuns.get(loop.id)).toEqual({ round: 1, done: false });
    expect(runReview).toHaveBeenCalledTimes(1);
    releaseRunReview(goodResult()); // let the dangling promise settle so the test exits cleanly
  });

  it("never sets currentIterationNumber — the runner-path marker stays null (mirrors devGroupId for developing)", () => {
    const loop = makeLoop({ round: 1, currentIterationNumber: null });
    const runReview = vi.fn(async () => goodResult());
    const controller = makeController(runReview);
    const c = internalsOf(controller);

    c.dispatchReview(loop);

    // dispatchReview must not mutate the loop object it was handed, and the
    // registry entry itself carries no iteration-number field at all — the
    // ONLY marker of an in-flight runner-path round is the reviewRuns entry.
    expect(loop.currentIterationNumber).toBeNull();
    expect(c.reviewRuns.get(loop.id)).not.toHaveProperty("iterationNumber");
  });
});

describe("dispatchReview -> settle lifecycle — in-flight, then settled with the runReview result", () => {
  it("the registry entry is done:false while runReview is pending, then done:true with .result once it resolves", async () => {
    const loop = makeLoop({ round: 1 });
    let releaseRunReview: (r: ReviewRunResult) => void = () => {};
    const runReview = vi.fn(
      () => new Promise<ReviewRunResult>((resolve) => { releaseRunReview = resolve; }),
    );
    const controller = makeController(runReview);
    const c = internalsOf(controller);

    c.dispatchReview(loop);
    expect(c.reviewRuns.get(loop.id)?.done).toBe(false); // in-flight

    const result = goodResult();
    releaseRunReview(result);
    await Promise.resolve().then(() => Promise.resolve()); // flush the .then() settle handler

    const settled = c.reviewRuns.get(loop.id);
    expect(settled?.done).toBe(true);
    expect(settled?.result).toEqual(result);
  });
});

describe("degraded settle on a runner throw — dispatch never throws; the registry still settles", () => {
  it("a rejecting runReview settles the registry done:true with an error-carrying result, not an unhandled rejection", async () => {
    const loop = makeLoop({ round: 1 });
    const runReview = vi.fn(async () => {
      throw new Error("model gateway timed out");
    });
    const controller = makeController(runReview);
    const c = internalsOf(controller);

    expect(() => c.dispatchReview(loop)).not.toThrow();
    await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

    const settled = c.reviewRuns.get(loop.id);
    expect(settled?.done).toBe(true);
    expect(settled?.result?.error).toBeTruthy();
    // Degraded settle carries no verdict/participants to render (mirrors the
    // no-PR degraded DevCloseoutResult shape on an SDLC close-out throw).
    expect(settled?.result?.verdict ?? null).toBeNull();
    expect(settled?.result?.participants ?? null).toBeNull();
  });
});

describe("settleReviewRun — idempotent settle never clobbers a completed result", () => {
  it("a late/duplicate settle for the SAME round must not downgrade an already-done good result", () => {
    // Mirrors loop-fsm.test.ts's "IDEMPOTENT SETTLE (c)" test for sdlcRuns
    // (settleSdlcRun) verbatim, calling the settle method directly (no dispatch).
    const controller = makeController();
    const c = internalsOf(controller);

    const good: ReviewRun = { round: 1, done: false };
    c.reviewRuns.set("loop1", good);
    c.settleReviewRun("loop1", good, goodResult());
    expect(c.reviewRuns.get("loop1")?.result?.participants).toEqual(goodResult().participants);

    // A late/duplicate settle for the SAME round arrives with a DEGRADED result
    // (e.g. a redrive that lost the race but still resolved with an error).
    const late: ReviewRun = { round: 1, done: false };
    c.settleReviewRun("loop1", late, { ...goodResult(), participants: null, verdict: null, error: "redrive lost the race" });

    // The good, already-settled result is preserved — the late settle must not
    // clobber it (mirrors settleSdlcRun's null-prRef-can't-clobber-a-good-PR guard).
    expect(c.reviewRuns.get("loop1")?.result?.participants).toEqual(goodResult().participants);
  });
});

/**
 * DEFERRED (per team-lead/Architect sign-off, 2026-07-07) — not in this file:
 *
 *   - Redrive single-dispatch + cross-instance single-flight: INTEGRATION-level.
 *     Architect clarified (2026-07-07): `claimRedrive` is ALREADY state-
 *     parameterized and the OLD reviewing redrive already calls it
 *     (consilium-loop-controller.ts:1414, `claimRedrive(loop.id, "reviewing",
 *     grace)`) — there is NO new reviewing-mode carve-out on the claim itself.
 *     What B4 adds is a REGISTRY GATE in front of it, mirroring the
 *     `developing`/`sdlcRuns` branch in `redriveStranded`: a `reviewRuns` entry
 *     for `loop.round` ⇒ in-flight, skip (no claim attempt); registry EMPTY
 *     past grace ⇒ fall through to `claimRedrive` as today. So the deferred
 *     cross-instance test is: two controllers, empty registry, past grace →
 *     exactly one `claimRedrive` wins → exactly one re-dispatch — same shape
 *     as Phase 1's developing cross-instance test, just gated by the reviewing
 *     registry check first. Belongs in a future
 *     tests/integration/consilium/review-runs-redrive.test.ts once
 *     review-runner.ts + the B4 tick-wiring exist to exercise end-to-end.
 *   - Kill-switch parity (directReview.enabled=false) and STRADDLE: Round 2
 *     (B4 wires the runner into tick()/deriveReviewEvent/resolveVerdict) — the
 *     existing loop-fsm.test.ts assertions already cover parity unmodified
 *     (readIterationVerdict injection is untouched by this change) and will be
 *     re-asserted once B4 lands.
 */
