/**
 * loop-status.test.ts — unit coverage for `explainLoopState`
 * (`shared/loop-status.ts`): the plain-English "what & why" for EVERY consilium
 * loop state, generalizing #466's cancel-reason callout.
 *
 * Covers, for each state, the title / tone / detail — and that the WHY numbers
 * (round, maxRounds, the open remainder, open P0) are interpolated from the
 * loop's OWN fields, never hardcoded. Special focus on:
 *   - stopped_cap WITH a remainder (the state the operator hit blind)
 *   - stopped_cap as a single-round ASSESSMENT (context-aware, success tone)
 *   - converged (clean vs. with a non-P0 remainder)
 *   - failed / cancelled reusing the loop's `error` (#466 behaviour, not regressed)
 *   - a safe neutral default so the callout NEVER renders blank
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  explainLoopState,
  type LoopStatusInput,
} from "../../../shared/loop-status.js";
import { CONSILIUM_LOOP_STATES } from "../../../shared/schema.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../../..");

function loop(over: Partial<LoopStatusInput> = {}): LoopStatusInput {
  return {
    state: "pending",
    round: 1,
    maxRounds: 6,
    openP0: null,
    openRemainder: null,
    error: null,
    prRef: null,
    devProgress: null,
    ...over,
  };
}

describe("explainLoopState — every state is non-blank", () => {
  it("returns a non-empty title + detail for every declared FSM state", () => {
    for (const state of CONSILIUM_LOOP_STATES) {
      const out = explainLoopState(loop({ state }));
      expect(out.title.length, `title for ${state}`).toBeGreaterThan(0);
      expect(out.detail.length, `detail for ${state}`).toBeGreaterThan(0);
      expect(["neutral", "good", "warning", "bad"]).toContain(out.tone);
    }
  });

  it("falls through to a safe neutral default for an unknown/future state (never blank)", () => {
    const out = explainLoopState(loop({ state: "frozen" as LoopStatusInput["state"] }));
    expect(out.tone).toBe("neutral");
    expect(out.title).toBe("Frozen");
    expect(out.detail).toContain("frozen");
  });
});

describe("explainLoopState — non-terminal states (what's happening now)", () => {
  it("pending → neutral, says it hasn't started", () => {
    const out = explainLoopState(loop({ state: "pending" }));
    expect(out.tone).toBe("neutral");
    expect(out.detail).toMatch(/hasn't started/i);
  });

  it("building_context → interpolates the round window (round 0 reads as round 1)", () => {
    const out = explainLoopState(loop({ state: "building_context", round: 0, maxRounds: 6 }));
    expect(out.tone).toBe("neutral");
    expect(out.title).toBe("Building context");
    expect(out.detail).toContain("round 1 of up to 6");
  });

  it("reviewing → interpolates the current round / maxRounds", () => {
    const out = explainLoopState(loop({ state: "reviewing", round: 3, maxRounds: 8 }));
    expect(out.tone).toBe("neutral");
    expect(out.detail).toContain("round 3 of up to 8");
  });

  it("deciding → interpolates the round being tallied", () => {
    const out = explainLoopState(loop({ state: "deciding", round: 4 }));
    expect(out.detail).toContain("round 4");
    expect(out.detail).toMatch(/acceptance criterion/i);
  });

  it("developing → shows the live AP k/N when devProgress carries it", () => {
    const out = explainLoopState(
      loop({ state: "developing", devProgress: { actionPointIndex: 2, actionPointTotal: 5 } }),
    );
    expect(out.tone).toBe("neutral");
    expect(out.detail).toContain("AP 2/5");
  });

  it("developing → omits the AP counter when progress is absent", () => {
    const out = explainLoopState(loop({ state: "developing", devProgress: null }));
    expect(out.detail).not.toContain("AP ");
    expect(out.detail).toMatch(/implementing the action points/i);
  });

  it("awaiting_merge → points at the open Draft PR when prRef is set", () => {
    const out = explainLoopState(loop({ state: "awaiting_merge", prRef: "https://x/pr/1" }));
    expect(out.tone).toBe("neutral");
    expect(out.detail).toMatch(/draft pr is open/i);
  });

  it("awaiting_merge → explains the no-PR gate when prRef is absent", () => {
    const out = explainLoopState(loop({ state: "awaiting_merge", prRef: null }));
    expect(out.detail).toMatch(/no pr/i);
  });
});

describe("explainLoopState — converged", () => {
  it("clean convergence → good tone, 'the loop is done', no remainder note", () => {
    const out = explainLoopState(loop({ state: "converged", openRemainder: null }));
    expect(out.tone).toBe("good");
    expect(out.title).toBe("Converged");
    expect(out.detail).toMatch(/every acceptance criterion was confirmed/i);
    expect(out.detail).not.toMatch(/lower-priority/i);
  });

  it("converged WITH a non-P0 remainder → notes the leftover items (tier-ordered)", () => {
    const out = explainLoopState(
      loop({ state: "converged", openRemainder: { total: 3, byPriority: { P2: 1, P1: 2 } } }),
    );
    expect(out.tone).toBe("good");
    expect(out.detail).toContain("3 lower-priority items (2 P1, 1 P2)");
  });

  it("converged with a P0-ONLY remainder → no non-P0 note (nothing lower-priority to show)", () => {
    const out = explainLoopState(
      loop({ state: "converged", openRemainder: { total: 1, byPriority: { P0: 1 } } }),
    );
    expect(out.detail).not.toMatch(/lower-priority/i);
  });
});

describe("explainLoopState — stopped_cap", () => {
  it("multi-round cap WITH a remainder → warning + the round limit + the open breakdown", () => {
    const out = explainLoopState(
      loop({
        state: "stopped_cap",
        maxRounds: 6,
        openP0: 1,
        openRemainder: { total: 3, byPriority: { P0: 1, P1: 2 } },
      }),
    );
    expect(out.tone).toBe("warning");
    expect(out.title).toBe("Stopped at the round limit");
    expect(out.detail).toContain("max 6");
    // P0-first full breakdown, grounded in the loop's own remainder.
    expect(out.detail).toContain("3 items remain open (1 P0, 2 P1)");
    expect(out.detail).toMatch(/raise the round limit|develop the remainder/i);
  });

  it("multi-round cap with only openP0 (no remainder) → falls back to the P0 count", () => {
    const out = explainLoopState(
      loop({ state: "stopped_cap", maxRounds: 4, openP0: 2, openRemainder: null }),
    );
    expect(out.tone).toBe("warning");
    expect(out.detail).toContain("2 P0 items remain open");
  });

  it("multi-round cap with no open info → a neutral phrasing (never blank)", () => {
    const out = explainLoopState(
      loop({ state: "stopped_cap", maxRounds: 6, openP0: null, openRemainder: null }),
    );
    expect(out.detail).toContain("some items may still be open");
  });

  it("single-round loop (maxRounds === 1) → an ASSESSMENT: good tone, 'Completed — review'", () => {
    const out = explainLoopState(loop({ state: "stopped_cap", maxRounds: 1, openP0: 1 }));
    expect(out.tone).toBe("good");
    expect(out.title).toBe("Completed — review");
    expect(out.detail).toMatch(/assessment/i);
  });

  it("singular grammar: exactly one open item reads 'remains'", () => {
    const out = explainLoopState(
      loop({ state: "stopped_cap", maxRounds: 6, openRemainder: { total: 1, byPriority: { P1: 1 } } }),
    );
    expect(out.detail).toContain("1 item remains open (1 P1)");
  });
});

describe("explainLoopState — escalated", () => {
  it("warning + 'stopped improving' + the still-open P0 count", () => {
    const out = explainLoopState(loop({ state: "escalated", openP0: 3 }));
    expect(out.tone).toBe("warning");
    expect(out.title).toBe("Escalated");
    expect(out.detail).toMatch(/stopped improving/i);
    expect(out.detail).toContain("3 P0 items open");
  });

  it("singular P0 grammar", () => {
    const out = explainLoopState(loop({ state: "escalated", openP0: 1 }));
    expect(out.detail).toContain("1 P0 item open");
  });

  it("omits the P0 clause when none are open", () => {
    const out = explainLoopState(loop({ state: "escalated", openP0: 0 }));
    expect(out.detail).not.toMatch(/P0 item/);
  });
});

describe("explainLoopState — failed / cancelled reuse the loop error (#466, not regressed)", () => {
  it("failed → bad tone, detail IS the loop error", () => {
    const out = explainLoopState(loop({ state: "failed", error: "worker crashed at step 3" }));
    expect(out.tone).toBe("bad");
    expect(out.title).toBe("Failed");
    expect(out.detail).toBe("worker crashed at step 3");
  });

  it("failed with no error → a safe fallback (still non-blank)", () => {
    const out = explainLoopState(loop({ state: "failed", error: null }));
    expect(out.tone).toBe("bad");
    expect(out.detail).toMatch(/unrecoverable error/i);
  });

  it("cancelled → neutral (NOT a failure), detail IS the cancellation note", () => {
    const note = "Cancelled by alice at 2026-07-01T00:00:00Z — superseded";
    const out = explainLoopState(loop({ state: "cancelled", error: note }));
    expect(out.tone).toBe("neutral");
    expect(out.title).toBe("Cancelled");
    expect(out.detail).toBe(note);
  });

  it("cancelled with no reason → a safe fallback (still non-blank)", () => {
    const out = explainLoopState(loop({ state: "cancelled", error: null }));
    expect(out.tone).toBe("neutral");
    expect(out.detail).toMatch(/cancelled by an operator/i);
  });
});

// The repo has no @testing-library/react; UI rendering is asserted at the source
// level (see pipeline-ux.test.ts). This guards that the callout is wired into the
// page body UNCONDITIONALLY — so it renders for a non-terminal state too, not just
// terminal ones (the whole point of generalizing #466).
describe("ConsiliumLoopDetail — status callout is rendered for every state", () => {
  const source = readFileSync(
    resolve(PROJECT_ROOT, "client/src/pages/ConsiliumLoopDetail.tsx"),
    "utf8",
  );

  it("renders <LoopStatusCallout loop={loop} /> in the page body", () => {
    expect(source).toContain("<LoopStatusCallout loop={loop} />");
  });

  it("does not gate the callout behind a terminal-only condition", () => {
    // The callout call must not sit inside a `terminal && (…)` / `isTerminal…` guard.
    const idx = source.indexOf("<LoopStatusCallout loop={loop} />");
    expect(idx).toBeGreaterThan(-1);
    const preceding = source.slice(Math.max(0, idx - 200), idx);
    expect(preceding).not.toMatch(/terminal\s*&&\s*\($/);
  });

  it("uses the shared explainLoopState helper (single source of truth)", () => {
    expect(source).toContain("explainLoopState(loop)");
  });
});
