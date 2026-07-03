/**
 * Unit tests for the consilium REVIEW-step activity model (frontend). Like
 * task-iterations-logic.test.ts these exercise the PURE helpers behind the Loop
 * detail "Current round (live)" section without a DOM renderer — they import
 * from @/components/task-groups/review-activity (no React).
 *
 * Covers: role classification from task names, status mapping, live elapsed, the
 * NO-PROGRESS stall rule (and its anti-false-positive guarantees on a slow-but-
 * working panel + on a fresh loop heartbeat), and the one-line summary.
 */
import { describe, it, expect } from "vitest";
import {
  classifyParticipantRole,
  computeReviewActivity,
  participantHeading,
  formatElapsed,
  noActivityMinutes,
  DEFAULT_STALL_THRESHOLD_MS,
  type ReviewExecutionInput,
} from "@/components/task-groups/review-activity";

const T0 = Date.parse("2026-07-03T10:00:00.000Z");
const MIN = 60_000;

function exec(overrides: Partial<ReviewExecutionInput> = {}): ReviewExecutionInput {
  // NB: use `in` checks for the nullable timestamps so an EXPLICIT `null` (a
  // queued row that has not started) is preserved rather than collapsed by `??`.
  return {
    id: overrides.id ?? "e1",
    taskName: overrides.taskName ?? "Opus primary",
    status: overrides.status ?? "running",
    modelSlug: overrides.modelSlug ?? "claude-opus",
    startedAt: "startedAt" in overrides ? overrides.startedAt : new Date(T0).toISOString(),
    completedAt: "completedAt" in overrides ? overrides.completedAt : null,
    output: overrides.output,
    summary: overrides.summary ?? null,
    errorMessage: overrides.errorMessage ?? null,
  };
}

describe("classifyParticipantRole", () => {
  it("classifies a primary debater and parses the seat", () => {
    const r = classifyParticipantRole("Opus primary");
    expect(r.kind).toBe("primary");
    expect(r.seat).toBe("Opus");
    expect(r.label).toBe("primary debater");
  });

  it("classifies a rebuttal with its target", () => {
    const r = classifyParticipantRole("Gemini rebuts Opus");
    expect(r.kind).toBe("rebuttal");
    expect(r.seat).toBe("Gemini");
    expect(r.label).toBe("rebuts Opus");
  });

  it("classifies the judge", () => {
    const r = classifyParticipantRole("Judge verdict");
    expect(r.kind).toBe("judge");
    expect(r.seat).toBeNull();
    expect(r.label).toBe("judge");
  });

  it("falls back to a generic participant for unknown names", () => {
    expect(classifyParticipantRole("something else").kind).toBe("participant");
    expect(classifyParticipantRole(null).kind).toBe("participant");
    expect(classifyParticipantRole("").kind).toBe("participant");
  });
});

describe("participantHeading", () => {
  it("builds seat + role headings and a bare Judge heading", () => {
    const act = computeReviewActivity(
      [
        exec({ id: "a", taskName: "Opus primary" }),
        exec({ id: "b", taskName: "Gemini rebuts Opus", modelSlug: "gemini-3-1-pro-high" }),
        exec({ id: "c", taskName: "Judge verdict", modelSlug: "claude-opus", status: "queued", startedAt: null }),
      ],
      { now: T0 + MIN },
    );
    const byId = Object.fromEntries(act.participants.map((p) => [p.id, participantHeading(p)]));
    expect(byId.a).toBe("Opus — primary debater");
    expect(byId.b).toBe("Gemini — rebuts Opus");
    expect(byId.c).toBe("Judge");
  });
});

describe("computeReviewActivity — status mapping + elapsed", () => {
  it("maps pending/blocked/ready to queued and computes no elapsed", () => {
    const act = computeReviewActivity(
      [exec({ status: "pending", startedAt: null }), exec({ id: "e2", status: "ready", startedAt: null })],
      { now: T0 + MIN },
    );
    expect(act.participants.every((p) => p.status === "queued")).toBe(true);
    expect(act.participants.every((p) => p.elapsedMs === null)).toBe(true);
  });

  it("computes live elapsed for a running row from startedAt→now", () => {
    const act = computeReviewActivity([exec({ status: "running" })], { now: T0 + 90 * 1000 });
    expect(act.participants[0].status).toBe("running");
    expect(act.participants[0].elapsedMs).toBe(90 * 1000);
  });

  it("computes fixed elapsed for a completed row from startedAt→completedAt", () => {
    const act = computeReviewActivity(
      [
        exec({
          status: "completed",
          completedAt: new Date(T0 + 3 * MIN).toISOString(),
          output: "the verdict",
        }),
      ],
      { now: T0 + 10 * MIN },
    );
    expect(act.participants[0].status).toBe("completed");
    expect(act.participants[0].elapsedMs).toBe(3 * MIN);
    expect(act.participants[0].hasOutput).toBe(true);
  });
});

describe("computeReviewActivity — the no-progress stall rule", () => {
  it("flags a running row as stalled once the round is quiet past the threshold", () => {
    // Only one execution, started 6 min ago, still running, no other activity.
    const act = computeReviewActivity([exec({ status: "running" })], {
      now: T0 + 6 * MIN,
    });
    const p = act.participants[0];
    expect(p.stalled).toBe(true);
    expect(p.status).toBe("stalled");
    expect(p.noProgressMs).toBe(6 * MIN);
  });

  it("does NOT stall before the threshold", () => {
    const act = computeReviewActivity([exec({ status: "running" })], { now: T0 + 4 * MIN });
    expect(act.participants[0].stalled).toBe(false);
    expect(act.participants[0].status).toBe("running");
  });

  it("does NOT false-positive a slow debater while a sibling recently completed", () => {
    // Judge started 6 min ago and is still running, BUT a debater completed 1 min
    // ago → the round HAS made progress recently → the judge is working, not stalled.
    const now = T0 + 6 * MIN;
    const act = computeReviewActivity(
      [
        exec({
          id: "debater",
          taskName: "Opus primary",
          status: "completed",
          startedAt: new Date(T0).toISOString(),
          completedAt: new Date(now - 1 * MIN).toISOString(),
          output: "done",
        }),
        exec({
          id: "judge",
          taskName: "Judge verdict",
          status: "running",
          startedAt: new Date(T0).toISOString(),
        }),
      ],
      { now },
    );
    const judge = act.participants.find((p) => p.id === "judge")!;
    expect(judge.stalled).toBe(false);
    expect(judge.status).toBe("running");
    // its own elapsed is still the honest 6 min
    expect(judge.elapsedMs).toBe(6 * MIN);
  });

  it("does NOT stall when the loop heartbeat is fresh even if the exec is old", () => {
    // Running 20 min, but the loop's updatedAt was bumped 30s ago (poller alive).
    const now = T0 + 20 * MIN;
    const act = computeReviewActivity(
      [exec({ status: "running", startedAt: new Date(T0).toISOString() })],
      { now, loopUpdatedAt: new Date(now - 30 * 1000).toISOString() },
    );
    expect(act.participants[0].stalled).toBe(false);
  });

  it("respects a custom stall threshold", () => {
    const act = computeReviewActivity([exec({ status: "running" })], {
      now: T0 + 3 * MIN,
      stallThresholdMs: 2 * MIN,
    });
    expect(act.participants[0].stalled).toBe(true);
  });

  it("never stalls a completed or queued row", () => {
    const now = T0 + 30 * MIN;
    const act = computeReviewActivity(
      [
        exec({ id: "c", status: "completed", completedAt: new Date(T0 + MIN).toISOString() }),
        exec({ id: "q", status: "pending", startedAt: null }),
      ],
      { now },
    );
    expect(act.participants.every((p) => p.stalled === false)).toBe(true);
  });

  it("defaults the threshold to 5 minutes", () => {
    expect(DEFAULT_STALL_THRESHOLD_MS).toBe(5 * MIN);
  });
});

describe("computeReviewActivity — ordering + one-line summary", () => {
  it("orders started rows by startedAt, queued rows last", () => {
    const act = computeReviewActivity(
      [
        exec({ id: "queued", status: "pending", startedAt: null }),
        exec({ id: "late", status: "completed", startedAt: new Date(T0 + 2 * MIN).toISOString(), completedAt: new Date(T0 + 3 * MIN).toISOString() }),
        exec({ id: "early", status: "completed", startedAt: new Date(T0).toISOString(), completedAt: new Date(T0 + MIN).toISOString() }),
      ],
      { now: T0 + 5 * MIN },
    );
    expect(act.participants.map((p) => p.id)).toEqual(["early", "late", "queued"]);
    expect(act.participants.map((p) => p.index)).toEqual([1, 2, 3]);
  });

  it("builds a self-explanatory one-line summary", () => {
    const now = T0 + 6 * MIN;
    const act = computeReviewActivity(
      [
        exec({ id: "d1", taskName: "Opus primary", status: "running" }),
        exec({ id: "d2", taskName: "Gemini primary", status: "running" }),
        exec({ id: "j", taskName: "Judge verdict", status: "pending", startedAt: null }),
      ],
      // Fresh loop heartbeat → the debaters read as running (not stalled).
      { now, roundLabel: 2, loopUpdatedAt: new Date(now - 10 * 1000).toISOString() },
    );
    expect(act.oneLine).toBe("Round 2 review — 2 debaters + judge · 2 running, 1 queued · elapsed 6m");
    expect(act.summary.debaterCount).toBe(2);
    expect(act.summary.hasJudge).toBe(true);
  });

  it("surfaces a stalled count in the one-liner", () => {
    const act = computeReviewActivity(
      [exec({ id: "d1", taskName: "Opus primary", status: "running" })],
      { now: T0 + 7 * MIN, roundLabel: 1 },
    );
    expect(act.oneLine).toContain("1 stalled");
  });
});

describe("formatElapsed + noActivityMinutes", () => {
  it("formats compact durations", () => {
    expect(formatElapsed(45 * 1000)).toBe("45s");
    expect(formatElapsed(6 * MIN)).toBe("6m");
    expect(formatElapsed(6 * MIN + 12 * 1000)).toBe("6m 12s");
    expect(formatElapsed(64 * MIN)).toBe("1h 4m");
    expect(formatElapsed(null)).toBe("—");
    expect(formatElapsed(-5)).toBe("—");
  });

  it("floors no-activity minutes with a floor of 1", () => {
    expect(noActivityMinutes(90 * 1000)).toBe(1);
    expect(noActivityMinutes(5 * MIN + 30 * 1000)).toBe(5);
    expect(noActivityMinutes(10 * 1000)).toBe(1);
  });
});
