/**
 * wave-schedule.test.ts — the parallel-develop PLANNER (design §4).
 *
 * `buildWaveSchedule(aps)` turns the judge-declared `dependsOn` edges into topologically
 * sorted WAVES (levels) the executor runs concurrently. Load-bearing / adversarial:
 *   - independent APs ⇒ ONE wave (all parallelizable) — the default.
 *   - a linear chain A→B→C ⇒ three single-AP waves in order.
 *   - a diamond (D depends on B,C which depend on A) ⇒ waves [A] [B,C] [D].
 *   - refs to a NONEXISTENT AP are dropped (never a dangling edge / wedge).
 *   - a SELF dependency is dropped.
 *   - a CYCLE is BROKEN (the stuck APs become a final independent wave) — never a deadlock.
 *   - title-based refs resolve; numeric-string refs resolve.
 *   - every AP appears EXACTLY once; within a wave ORIGINAL order is preserved.
 */
import { describe, it, expect } from "vitest";
import { buildWaveSchedule } from "../../../server/services/orchestrator/convergence.js";
import type { ActionPoint } from "@shared/types";

/** Build an AP with a title = its label and optional deps. */
const ap = (title: string, dependsOn?: Array<number | string>): ActionPoint =>
  dependsOn ? { title, dependsOn } : { title };

/** Map a wave schedule to titles for terse assertions. */
const titles = (waves: ActionPoint[][]): string[][] => waves.map((w) => w.map((a) => a.title));

/** Collect warnings into an array (the injectable sink) instead of console. */
function capture(): { warn: (m: string) => void; msgs: string[] } {
  const msgs: string[] = [];
  return { warn: (m) => msgs.push(m), msgs };
}

describe("buildWaveSchedule — happy paths", () => {
  it("empty list ⇒ no waves", () => {
    expect(buildWaveSchedule([], () => {})).toEqual([]);
  });

  it("single AP ⇒ one wave of one", () => {
    expect(titles(buildWaveSchedule([ap("A")], () => {}))).toEqual([["A"]]);
  });

  it("all independent ⇒ ONE wave (fully parallel) in original order", () => {
    const waves = buildWaveSchedule([ap("A"), ap("B"), ap("C")], () => {});
    expect(titles(waves)).toEqual([["A", "B", "C"]]);
  });

  it("linear chain A→B→C (1-based numeric refs) ⇒ three ordered single-AP waves", () => {
    // B(#2) depends on A(#1); C(#3) depends on B(#2).
    const waves = buildWaveSchedule([ap("A"), ap("B", [1]), ap("C", [2])], () => {});
    expect(titles(waves)).toEqual([["A"], ["B"], ["C"]]);
  });

  it("diamond: [A] [B,C] [D] — D waits for both B and C which wait for A", () => {
    const waves = buildWaveSchedule(
      [ap("A"), ap("B", [1]), ap("C", [1]), ap("D", [2, 3])],
      () => {},
    );
    expect(titles(waves)).toEqual([["A"], ["B", "C"], ["D"]]);
  });

  it("resolves TITLE references (case-insensitive, trimmed)", () => {
    const waves = buildWaveSchedule([ap("Fix parser"), ap("Verify CI", ["  fix PARSER "])], () => {});
    expect(titles(waves)).toEqual([["Fix parser"], ["Verify CI"]]);
  });

  it("resolves NUMERIC-STRING references", () => {
    const waves = buildWaveSchedule([ap("A"), ap("B", ["1"])], () => {});
    expect(titles(waves)).toEqual([["A"], ["B"]]);
  });
});

describe("buildWaveSchedule — adversarial hardening", () => {
  it("drops a ref to a NONEXISTENT AP (out-of-range index) and warns", () => {
    const cap = capture();
    // B depends on #9 which doesn't exist ⇒ edge dropped ⇒ B is independent.
    const waves = buildWaveSchedule([ap("A"), ap("B", [9])], cap.warn);
    expect(titles(waves)).toEqual([["A", "B"]]);
    expect(cap.msgs.join(" ")).toMatch(/nonexistent/i);
  });

  it("drops an unknown TITLE ref and warns", () => {
    const cap = capture();
    const waves = buildWaveSchedule([ap("A"), ap("B", ["does not exist"])], cap.warn);
    expect(titles(waves)).toEqual([["A", "B"]]);
    expect(cap.msgs.join(" ")).toMatch(/nonexistent/i);
  });

  it("drops a SELF dependency and warns", () => {
    const cap = capture();
    // A(#1) depends on itself ⇒ edge dropped ⇒ A stays independent (wave 0 with B).
    const waves = buildWaveSchedule([ap("A", [1]), ap("B")], cap.warn);
    expect(titles(waves)).toEqual([["A", "B"]]);
    expect(cap.msgs.join(" ")).toMatch(/itself/i);
  });

  it("BREAKS a 2-cycle (A↔B) — never deadlocks; stuck APs become a final wave + warn", () => {
    const cap = capture();
    // A(#1) depends on B(#2); B(#2) depends on A(#1) ⇒ neither can start ⇒ cycle broken.
    const waves = buildWaveSchedule([ap("A", [2]), ap("B", [1])], cap.warn);
    // All APs still scheduled exactly once (as one broken-cycle wave).
    const flat = waves.flat().map((a) => a.title).sort();
    expect(flat).toEqual(["A", "B"]);
    expect(cap.msgs.join(" ")).toMatch(/cycle/i);
  });

  it("BREAKS a 3-cycle while still scheduling an independent AP normally first", () => {
    const cap = capture();
    // A independent; B→C→D→B is a cycle. B,C,D are broken into a final wave; A is wave 0.
    const waves = buildWaveSchedule(
      [ap("A"), ap("B", [4]), ap("C", [2]), ap("D", [3])],
      cap.warn,
    );
    expect(titles(waves)[0]).toEqual(["A"]); // independent AP scheduled first
    const flat = waves.flat().map((a) => a.title).sort();
    expect(flat).toEqual(["A", "B", "C", "D"]); // nothing lost
    expect(cap.msgs.join(" ")).toMatch(/cycle/i);
  });

  it("every AP appears exactly once across all waves (no dup, no drop)", () => {
    const aps = [ap("A"), ap("B", [1]), ap("C", [1, 2]), ap("D"), ap("E", [4])];
    const flat = buildWaveSchedule(aps, () => {}).flat();
    expect(flat).toHaveLength(aps.length);
    expect(new Set(flat.map((a) => a.title)).size).toBe(aps.length);
  });
});
