/**
 * role-track-record.test.ts — ROLE-4 (standing-role.md §8, ADR-0002 success-delta).
 *
 * The PURE track-record computation + the "proven → graduate" signal. Asserts that:
 *   - the record is computed from GROUND TRUTH (loop terminal states + role-scoped
 *     experience confidence) and counts converged / failed / active + verified / refuted;
 *   - `graduationReadiness` reflects MEASURED outcomes — `proven` ONLY above the floors,
 *     and NEVER from a self-report (there is no user-settable proven);
 *   - the role bind is FAIL-CLOSED: another role's loops/items never inflate this role;
 *   - the computation MUTATES NOTHING (a read never alters the input rows).
 */
import { describe, it, expect } from "vitest";
import {
  computeRoleTrackRecord,
  computeGraduationReadiness,
  computeRoleGraduation,
  PROVEN_MIN_TERMINAL_LOOPS,
  MIN_TERMINAL_LOOPS_FOR_SIGNAL,
  type TrackRecordLoop,
  type TrackRecordItem,
} from "../../../server/services/consilium/role-track-record.js";
import type { ConsiliumLoopState, ExperienceConfidence } from "@shared/schema";

const ROLE = "role-A";

function loop(state: ConsiliumLoopState, roleId: string | null = ROLE): TrackRecordLoop {
  return { state, triggerProvenance: roleId ? { role: { roleId } } : null };
}

function item(confidence: ExperienceConfidence, roleId: string | null = ROLE): TrackRecordItem {
  return {
    confidence,
    scope: { repo: "r", archetype: null, criterionClass: "test-run", ...(roleId ? { role: roleId } : {}) },
  };
}

/** Build N converged loops + M verified items so a role clears every `proven` floor. */
function provenInputs() {
  const loops = [
    ...Array.from({ length: 5 }, () => loop("converged")),
    loop("stopped_cap"), // one non-converged terminal → rate 5/6 ≈ 83% (≥ 70%)
  ];
  const items = [item("verified"), item("verified"), item("verified")];
  return { loops, items };
}

describe("computeRoleTrackRecord", () => {
  it("counts converged / non-converged terminal / active loops from ground-truth state", () => {
    const loops = [
      loop("converged"),
      loop("converged"),
      loop("stopped_cap"),
      loop("failed"),
      loop("escalated"),
      loop("cancelled"),
      loop("reviewing"), // non-terminal → active
      loop("pending"), // non-terminal → active
    ];
    const tr = computeRoleTrackRecord(ROLE, loops, []);
    expect(tr.convergedLoops).toBe(2);
    expect(tr.failedLoops).toBe(4); // stopped_cap + failed + escalated + cancelled
    expect(tr.activeLoops).toBe(2);
    expect(tr.terminalLoops).toBe(6);
    expect(tr.wokenLoops).toBe(8);
    expect(tr.convergenceRate).toBeCloseTo(2 / 6, 5);
  });

  it("counts verified / refuted / observed from role-scoped experience items", () => {
    const items = [item("verified"), item("verified"), item("refuted"), item("observed")];
    const tr = computeRoleTrackRecord(ROLE, [], items);
    expect(tr.verifiedPatterns).toBe(2);
    expect(tr.refutedPatterns).toBe(1);
    expect(tr.observedPatterns).toBe(1);
  });

  it("FAIL-CLOSED role bind: another role's loops + items are NOT counted", () => {
    const loops = [loop("converged"), loop("converged", "role-B"), loop("failed", null)];
    const items = [item("verified"), item("verified", "role-B"), item("verified", null)]; // role-B + role-agnostic
    const tr = computeRoleTrackRecord(ROLE, loops, items);
    expect(tr.convergedLoops).toBe(1); // only role-A's
    expect(tr.wokenLoops).toBe(1);
    expect(tr.verifiedPatterns).toBe(1); // only the scope.role === role-A item
  });

  it("convergenceRate is null when no loop has settled (all active)", () => {
    const tr = computeRoleTrackRecord(ROLE, [loop("reviewing"), loop("pending")], []);
    expect(tr.terminalLoops).toBe(0);
    expect(tr.convergenceRate).toBeNull();
  });

  it("does NOT mutate the input rows (a read is read-only)", () => {
    const loops = [loop("converged")];
    const items = [item("verified")];
    const snapLoop = JSON.stringify(loops);
    const snapItem = JSON.stringify(items);
    computeRoleTrackRecord(ROLE, loops, items);
    expect(JSON.stringify(loops)).toBe(snapLoop);
    expect(JSON.stringify(items)).toBe(snapItem);
  });
});

describe("computeGraduationReadiness", () => {
  it("proven ONLY when every measured floor is cleared", () => {
    const { loops, items } = provenInputs();
    const g = computeRoleGraduation(ROLE, loops, items);
    expect(g.status).toBe("proven");
    expect(g.summary).toMatch(/proven$/);
    expect(g.summary).toMatch(/83% converged/);
    expect(g.trackRecord.verifiedPatterns).toBe(3);
  });

  it("insufficient-evidence below the settled-loop floor (a fluke is not a record)", () => {
    const loops = Array.from({ length: MIN_TERMINAL_LOOPS_FOR_SIGNAL - 1 }, () => loop("converged"));
    const g = computeRoleGraduation(ROLE, loops, [item("verified")]);
    expect(g.status).toBe("insufficient-evidence");
    expect(g.rationale.join(" ")).toMatch(/settled loop/);
  });

  it("needs-more-evidence when convergence rate is below the floor", () => {
    // 6 settled loops but only 2 converged → 33% < 70%.
    const loops = [
      loop("converged"),
      loop("converged"),
      loop("failed"),
      loop("failed"),
      loop("stopped_cap"),
      loop("failed"),
    ];
    const g = computeRoleGraduation(ROLE, loops, [item("verified"), item("verified")]);
    expect(g.status).toBe("needs-more-evidence");
    expect(g.rationale.join(" ")).toMatch(/convergence rate/);
  });

  it("needs-more-evidence when there is no independently-verified pattern", () => {
    const loops = Array.from({ length: PROVEN_MIN_TERMINAL_LOOPS }, () => loop("converged"));
    const g = computeRoleGraduation(ROLE, loops, [item("observed"), item("observed")]);
    expect(g.status).toBe("needs-more-evidence");
    expect(g.rationale.join(" ")).toMatch(/verified pattern/);
  });

  it("NOT proven when refuted patterns outnumber verified (not net-positive learning)", () => {
    const loops = Array.from({ length: PROVEN_MIN_TERMINAL_LOOPS }, () => loop("converged"));
    const items = [item("verified"), item("refuted"), item("refuted")];
    const g = computeRoleGraduation(ROLE, loops, items);
    expect(g.status).toBe("needs-more-evidence");
    expect(g.rationale.join(" ")).toMatch(/not net-positive/);
  });

  it("is a PURE function of the record — same record ⇒ same verdict (no self-report seam)", () => {
    const { loops, items } = provenInputs();
    const tr = computeRoleTrackRecord(ROLE, loops, items);
    expect(computeGraduationReadiness(tr)).toEqual(computeGraduationReadiness(tr));
  });
});
