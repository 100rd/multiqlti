/**
 * role-track-record.ts — ROLE-4 (standing-role.md §8): a Standing Role's MEASURED
 * track record + the "proven → graduate" signal. Spec: standing-role.md §8 (role
 * library / graduation), [[platform-canon]] ADR-0002 (the skills trust envelope:
 * unverified → verified → deprecated; graduation is a MEASURED success-delta, never a
 * self-report).
 *
 * THIS MODULE IS PURE + READ-ONLY (like distiller.ts / experience-reader.ts): it takes
 * already-read rows (a role's woken loops + its role-scoped Experience items) and
 * returns a computed record + verdict. It performs NO I/O and MUTATES NOTHING — a
 * track-record read can never alter a loop or an Experience item (the anti-Goodhart
 * point: the signal observes ground truth, it does not manufacture it).
 *
 * WHY OUTCOME-MEASURED (the whole ROLE-4 safety story): every input is GROUND TRUTH the
 * factory set independently of any agent's self-report —
 *   - a loop's terminal `state` (`converged` = the panel/verifier/merge gate closed it;
 *     `stopped_cap`/`failed`/`escalated`/`cancelled` = it did not), and
 *   - an Experience item's `confidence` (`verified` ⇐ an INDEPENDENT criterion passed;
 *     `refuted` ⇐ one failed — see experience-plane-dream.md §6).
 * There is NO field a user can set to "proven". `proven` is EARNED here or not at all.
 */
import type { ConsiliumLoopState } from "@shared/schema";
import { CONSILIUM_LOOP_TERMINAL_STATES } from "@shared/schema";
import type {
  ExperienceConfidence,
  ExperienceScope,
  GraduationReadiness,
  GraduationStatus,
  RoleTrackRecord,
} from "@shared/types";

/** The minimal loop shape the computation needs — a terminal state + role provenance. */
export interface TrackRecordLoop {
  state: ConsiliumLoopState;
  triggerProvenance?: { role?: { roleId: string } | null } | null;
}

/** The minimal Experience-item shape — a scope (for the role bind) + a confidence. */
export interface TrackRecordItem {
  scope: ExperienceScope;
  confidence: ExperienceConfidence;
}

// ── Graduation thresholds (ADR-0002 success-delta; tuned conservative on purpose) ──
// A role must have EARNED enough settled outcomes before ANY verdict beyond
// "insufficient-evidence" is meaningful — a single lucky loop is not a track record.
/** Below this many SETTLED (terminal) loops, there is not enough signal to judge. */
export const MIN_TERMINAL_LOOPS_FOR_SIGNAL = 3;
/** `proven` needs at least this many settled loops (a sustained beat, not a fluke). */
export const PROVEN_MIN_TERMINAL_LOOPS = 5;
/** `proven` needs a convergence rate at/above this (measured, not self-reported). */
export const PROVEN_MIN_CONVERGENCE_RATE = 0.7;
/** `proven` needs at least this many INDEPENDENTLY-verified role-scoped patterns. */
export const PROVEN_MIN_VERIFIED_PATTERNS = 1;

/** `converged` is the ONLY converged terminal; the rest are non-converged terminals. */
const TERMINAL: ReadonlySet<ConsiliumLoopState> = new Set(CONSILIUM_LOOP_TERMINAL_STATES);

/**
 * Compute a role's track record from its woken loops + role-scoped Experience items.
 * PURE: the caller pre-filters to this role's rows OR passes the roleId and lets this
 * fn filter (it filters defensively either way — an item/loop that does not bind to the
 * role is never counted). No I/O, no mutation.
 */
export function computeRoleTrackRecord(
  roleId: string,
  loops: readonly TrackRecordLoop[],
  items: readonly TrackRecordItem[],
): RoleTrackRecord {
  let convergedLoops = 0;
  let failedLoops = 0;
  let activeLoops = 0;

  for (const loop of loops) {
    // Defensive re-bind: only loops THIS role woke count (the caller may pass a superset).
    if (loop.triggerProvenance?.role?.roleId !== roleId) continue;
    if (loop.state === "converged") convergedLoops += 1;
    else if (TERMINAL.has(loop.state)) failedLoops += 1;
    else activeLoops += 1;
  }

  let verifiedPatterns = 0;
  let refutedPatterns = 0;
  let observedPatterns = 0;
  for (const item of items) {
    // FAIL-CLOSED role bind (ROLE-3 §6): ONLY items learned AS this role count toward
    // its record. A role-agnostic item (no `scope.role`) or another role's item never
    // inflates this role's readiness — the same boundary the reader enforces.
    if (item.scope?.role !== roleId) continue;
    if (item.confidence === "verified") verifiedPatterns += 1;
    else if (item.confidence === "refuted") refutedPatterns += 1;
    else observedPatterns += 1;
  }

  const wokenLoops = convergedLoops + failedLoops + activeLoops;
  const terminalLoops = convergedLoops + failedLoops;
  const convergenceRate = terminalLoops === 0 ? null : convergedLoops / terminalLoops;

  return {
    wokenLoops,
    convergedLoops,
    failedLoops,
    activeLoops,
    terminalLoops,
    convergenceRate,
    verifiedPatterns,
    refutedPatterns,
    observedPatterns,
  };
}

/** Render the convergence rate as a whole-percent string ("83%"), or "n/a" when unsettled. */
function pct(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 100)}%`;
}

/**
 * Derive the graduation signal from a measured record. PURE. The verdict is a pure
 * function of the counts — the SAME record always yields the SAME status, and no input
 * is self-reported. `proven` requires ALL of: a settled-loop floor, a convergence-rate
 * floor, a verified-pattern floor, AND net-positive learning (verified > refuted) — a
 * role that mostly refutes its own patterns has NOT proven its beat.
 */
export function computeGraduationReadiness(trackRecord: RoleTrackRecord): GraduationReadiness {
  const {
    wokenLoops,
    convergedLoops,
    terminalLoops,
    convergenceRate,
    verifiedPatterns,
    refutedPatterns,
  } = trackRecord;

  const rationale: string[] = [];
  let status: GraduationStatus;

  if (terminalLoops < MIN_TERMINAL_LOOPS_FOR_SIGNAL) {
    status = "insufficient-evidence";
    rationale.push(
      `only ${terminalLoops} settled loop(s) — need ≥ ${MIN_TERMINAL_LOOPS_FOR_SIGNAL} before a graduation verdict is meaningful`,
    );
    return {
      status,
      summary: summarise(wokenLoops, convergenceRate, verifiedPatterns, status),
      rationale,
      trackRecord,
    };
  }

  const meetsLoopFloor = terminalLoops >= PROVEN_MIN_TERMINAL_LOOPS;
  const meetsRate = convergenceRate !== null && convergenceRate >= PROVEN_MIN_CONVERGENCE_RATE;
  const meetsVerified = verifiedPatterns >= PROVEN_MIN_VERIFIED_PATTERNS;
  const netPositive = verifiedPatterns > refutedPatterns;

  if (meetsLoopFloor && meetsRate && meetsVerified && netPositive) {
    status = "proven";
    rationale.push(
      `${convergedLoops}/${terminalLoops} settled loops converged (${pct(convergenceRate)} ≥ ${Math.round(PROVEN_MIN_CONVERGENCE_RATE * 100)}%)`,
      `${verifiedPatterns} independently-verified pattern(s) vs ${refutedPatterns} refuted (net-positive)`,
      `${terminalLoops} settled loops ≥ ${PROVEN_MIN_TERMINAL_LOOPS} — a sustained beat, not a fluke`,
    );
  } else {
    status = "needs-more-evidence";
    if (!meetsLoopFloor) {
      rationale.push(`${terminalLoops} settled loops — need ≥ ${PROVEN_MIN_TERMINAL_LOOPS} for proven`);
    }
    if (!meetsRate) {
      rationale.push(
        `convergence rate ${pct(convergenceRate)} — need ≥ ${Math.round(PROVEN_MIN_CONVERGENCE_RATE * 100)}%`,
      );
    }
    if (!meetsVerified) {
      rationale.push(
        `${verifiedPatterns} verified pattern(s) — need ≥ ${PROVEN_MIN_VERIFIED_PATTERNS} independently-verified`,
      );
    }
    if (meetsVerified && !netPositive) {
      rationale.push(`${verifiedPatterns} verified vs ${refutedPatterns} refuted — not net-positive`);
    }
  }

  return {
    status,
    summary: summarise(wokenLoops, convergenceRate, verifiedPatterns, status),
    rationale,
    trackRecord,
  };
}

/** "N loops, X% converged, Y verified patterns — status". */
function summarise(
  wokenLoops: number,
  convergenceRate: number | null,
  verifiedPatterns: number,
  status: GraduationStatus,
): string {
  const loopWord = wokenLoops === 1 ? "loop" : "loops";
  const patWord = verifiedPatterns === 1 ? "pattern" : "patterns";
  return `${wokenLoops} ${loopWord}, ${pct(convergenceRate)} converged, ${verifiedPatterns} verified ${patWord} — ${status}`;
}

/** One-call convenience: compute the record AND the readiness verdict from raw rows. */
export function computeRoleGraduation(
  roleId: string,
  loops: readonly TrackRecordLoop[],
  items: readonly TrackRecordItem[],
): GraduationReadiness {
  return computeGraduationReadiness(computeRoleTrackRecord(roleId, loops, items));
}
