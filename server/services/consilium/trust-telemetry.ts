/**
 * trust-telemetry.ts — Stage 8 / "Stage D" (design §9): TRUST TELEMETRY.
 *
 * The §7 "observation process" made concrete. This is the data on which
 * "trust the planner under observation" is periodically re-decided. It ONLY
 * aggregates what the execution traces + loop rows ALREADY persist — no new
 * schema, no FSM, no writes. Pure and read-only.
 *
 * What it answers for an operator:
 *   1. GROUNDING RATIO — the share of acceptance criteria verified by a
 *      MECHANICAL method (`test-run` / `web-evidence` / `live-deploy-smoke`)
 *      versus `judge` versus `none`/`manual-ops`. This is THE metric of how
 *      grounded convergence actually is (design §5 honesty note): `judge`
 *      re-admits model subjectivity through the back door, so the mechanical
 *      share measures how much of "green" is ground truth vs a model's opinion.
 *   2. PLANNER TRACK RECORD — how often the engineer OVERRIDES the planner's
 *      proposed archetype (the §7 signal for whether to keep trusting it), the
 *      archetype distribution, and the per-skill green-rate.
 *   3. CRITERIA QUALITY — weak-criterion rate (Stage 7), manual-ops surfaced,
 *      timeout / NOT-ADJUDICATED rate, and final-verification regression rate
 *      (Stage 5 — a criterion that passed at implement time but not at final
 *      re-verify).
 *
 * SECURITY / SAFETY: every input field is UNTRUSTED persisted data (model text,
 * possibly malformed pre-Stage snapshots). This module reads NUMBERS and ENUMS
 * only — it never renders, executes, or sinks any string. All arrays are
 * defensively guarded (a malformed trace contributes 0, never throws) and every
 * ratio is division-by-zero safe (`ratio(n, 0) === 0`).
 */
import type {
  Archetype,
  ArchetypeSource,
  ExecutionTrace,
  ExecutionCriterion,
} from "@shared/types";

// ─── Input shape (a slim, DB-agnostic projection so the aggregator is PURE) ────
//
// The route maps `ConsiliumLoopRow` + `ConsiliumLoopRoundRow[]` into these; tests
// build them directly. `openActionPoints` carries the `weakCriterion` flag (it
// lives on ActionPoint, not on the trace criterion) — typed loose on purpose so a
// pre-Stage-C row without the field is simply counted as not-weak.

export interface TelemetryRoundInput {
  createdAt: string | Date;
  executionTrace: ExecutionTrace | null | undefined;
  /** ActionPoint[] — only `weakCriterion` and `acceptanceCriterion` are read. */
  openActionPoints:
    | ReadonlyArray<{ weakCriterion?: boolean; acceptanceCriterion?: string }>
    | null
    | undefined;
}

export interface TelemetryLoopInput {
  archetype: Archetype | null | undefined;
  archetypeSource: ArchetypeSource | null | undefined;
  createdAt: string | Date;
  rounds: ReadonlyArray<TelemetryRoundInput>;
}

// ─── Output shape (the wire contract the FE renders) ───────────────────────────

export interface GroundingTrendPoint {
  /** ISO week bucket, e.g. "2026-W27". */
  period: string;
  totalCriteria: number;
  mechanical: number;
  groundingRatio: number;
}

export interface SkillGreenRate {
  skill: string;
  total: number;
  green: number;
  greenRate: number;
}

export interface TrustTelemetry {
  /** How much history this snapshot covers (already bounded by the route). */
  window: { loops: number; rounds: number; roundsWithTrace: number };

  grounding: {
    totalCriteria: number;
    mechanical: number;
    judged: number;
    /** `none` + `manual-ops` — not a ground-truth check of convergence. */
    unverified: number;
    /** mechanical / totalCriteria (0 when no criteria). THE grounding metric. */
    groundingRatio: number;
    /** judged / totalCriteria. */
    judgedRatio: number;
    /** Raw counts per verification method (audit / drill-down). */
    byMethod: Record<ExecutionCriterion["method"], number>;
    /** Grounding ratio bucketed by ISO week, oldest→newest (the §5 "trend"). */
    trend: GroundingTrendPoint[];
  };

  planner: {
    /** Loops that carry a decided archetype (archetype != null). */
    archetypeDecided: number;
    proposed: number;
    overridden: number;
    /** overridden / archetypeDecided (0 when none decided). The §7 trust signal. */
    overrideRate: number;
    archetypeDistribution: Record<string, number>;
    /** Green-rate per skill from the trace skill leaves, most-run first. */
    skillGreenRate: SkillGreenRate[];
  };

  criteria: {
    totalActionPoints: number;
    weakCriteria: number;
    /** weakCriteria / totalActionPoints (Stage 7 criteria-QA rate). */
    weakRate: number;
    /** Criteria surfaced as `manual-ops` — a human action the loop can't close. */
    manualOpsSurfaced: number;
    /** Criteria whose verification run was SIGKILL'd (NOT-ADJUDICATED). */
    timedOut: number;
    /** timedOut / criteria that actually ran (0 when none ran). */
    timeoutRate: number;
    /** Criteria that carry a `passedAtFinal` (final re-verification ran). */
    finalVerified: number;
    /** passed at implement time but FAILED at final re-verify (a late-AP regression). */
    regressions: number;
    /** regressions / finalVerified (0 when no final verification ran). */
    regressionRate: number;
  };

  /** Operator-facing, numbers-first honesty framing (design §5 honesty note). */
  honesty: string;
}

// ─── Method buckets (design §5) ────────────────────────────────────────────────
//
// MECHANICAL = ground truth: a test run, a cited source, or a live smoke-test.
// `live-deploy-smoke` is not part of the persisted `ExecutionCriterion.method`
// union today, but it IS a mechanical method per §5 — included defensively so it
// counts as grounded the moment the infra archetype starts emitting it.
const MECHANICAL_METHODS = new Set(["test-run", "web-evidence", "live-deploy-smoke"]);

// ─── Pure helpers ──────────────────────────────────────────────────────────────

/** Division-by-zero-safe ratio (returns 0 for a 0 or negative denominator). */
function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/** Round to 4 decimals so the wire carries stable, compact numbers. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** ISO-8601 week key ("YYYY-Www"); a stable "unknown" bucket for bad dates. */
function isoWeek(input: string | Date): string {
  const d = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  if (Number.isNaN(d.getTime())) return "unknown";
  // ISO week: Thursday-anchored. Work in UTC to stay deterministic across hosts.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7; // Sun=0 → 7
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function toMillis(input: string | Date): number {
  const d = input instanceof Date ? input : new Date(input);
  const t = d.getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Every criterion leaf across a trace's controller → workers, guarded. */
function criteriaOf(trace: ExecutionTrace | null | undefined): ExecutionCriterion[] {
  const workers = trace?.controller?.workers;
  if (!Array.isArray(workers)) return [];
  const out: ExecutionCriterion[] = [];
  for (const w of workers) {
    if (w && Array.isArray(w.criteria)) {
      for (const c of w.criteria) if (c && typeof c.method === "string") out.push(c);
    }
  }
  return out;
}

// ─── The aggregator ────────────────────────────────────────────────────────────

/**
 * Aggregate trust telemetry from a bounded set of loops (+ their rounds). PURE:
 * same input → same output, no I/O, no throws on malformed data.
 */
export function computeTrustTelemetry(
  loops: ReadonlyArray<TelemetryLoopInput>,
): TrustTelemetry {
  const safeLoops = Array.isArray(loops) ? loops : [];

  // Grounding accumulators.
  const byMethod: Record<ExecutionCriterion["method"], number> = {
    "test-run": 0,
    "web-evidence": 0,
    judge: 0,
    "manual-ops": 0,
    none: 0,
  };
  let mechanical = 0;
  let judged = 0;
  let unverified = 0;
  let totalCriteria = 0;

  // Grounding trend (ISO week → totals).
  const trendBuckets = new Map<string, { total: number; mechanical: number }>();

  // Criteria-quality accumulators.
  let totalActionPoints = 0;
  let weakCriteria = 0;
  let manualOpsSurfaced = 0;
  let ranCount = 0;
  let timedOut = 0;
  let finalVerified = 0;
  let regressions = 0;

  // Skill green-rate accumulators.
  const skillAgg = new Map<string, { total: number; green: number }>();

  let roundCount = 0;
  let roundsWithTrace = 0;

  // Planner accumulators.
  let archetypeDecided = 0;
  let proposed = 0;
  let overridden = 0;
  const archetypeDistribution: Record<string, number> = {};

  for (const loop of safeLoops) {
    if (!loop) continue;

    // Planner track record (loop-level).
    if (loop.archetype) {
      archetypeDecided += 1;
      archetypeDistribution[loop.archetype] =
        (archetypeDistribution[loop.archetype] ?? 0) + 1;
      if (loop.archetypeSource === "override") overridden += 1;
      else proposed += 1; // `proposed` or null both mean "planner's pick stood"
    }

    const rounds = Array.isArray(loop.rounds) ? loop.rounds : [];
    for (const rnd of rounds) {
      if (!rnd) continue;
      roundCount += 1;

      // Criteria quality — action points (weakCriterion lives on the AP).
      const aps = Array.isArray(rnd.openActionPoints) ? rnd.openActionPoints : [];
      for (const ap of aps) {
        if (!ap) continue;
        totalActionPoints += 1;
        if (ap.weakCriterion === true) weakCriteria += 1;
      }

      const trace = rnd.executionTrace;
      const crits = criteriaOf(trace);
      if (trace && trace.controller) roundsWithTrace += 1;

      // Skill green-rate — walk the trace skill leaves.
      const workers = trace?.controller?.workers;
      if (Array.isArray(workers)) {
        for (const w of workers) {
          const skills = w && Array.isArray(w.skills) ? w.skills : [];
          for (const s of skills) {
            if (!s || typeof s.skillName !== "string") continue;
            const agg = skillAgg.get(s.skillName) ?? { total: 0, green: 0 };
            agg.total += 1;
            if (s.green === true) agg.green += 1;
            skillAgg.set(s.skillName, agg);
          }
        }
      }

      // Grounding + criteria-quality — the per-criterion leaves. A round with no
      // criteria contributes NO trend bucket (an empty week is noise, not a 0%).
      const wk = crits.length > 0 ? isoWeek(rnd.createdAt) : null;
      const bucket = wk !== null ? trendBuckets.get(wk) ?? { total: 0, mechanical: 0 } : null;
      for (const c of crits) {
        totalCriteria += 1;
        byMethod[c.method] = (byMethod[c.method] ?? 0) + 1;
        const isMechanical = MECHANICAL_METHODS.has(c.method);
        if (isMechanical) mechanical += 1;
        else if (c.method === "judge") judged += 1;
        else unverified += 1; // none | manual-ops

        if (c.method === "manual-ops") manualOpsSurfaced += 1;
        if (c.ran === true) ranCount += 1;
        if (c.timedOut === true) timedOut += 1;
        if (typeof c.passedAtFinal === "boolean") {
          finalVerified += 1;
          if (c.passed === true && c.passedAtFinal === false) regressions += 1;
        }

        if (bucket) {
          bucket.total += 1;
          if (isMechanical) bucket.mechanical += 1;
        }
      }
      if (wk !== null && bucket) trendBuckets.set(wk, bucket);
    }
  }

  const skillGreenRate: SkillGreenRate[] = Array.from(skillAgg.entries())
    .map(([skill, a]) => ({
      skill,
      total: a.total,
      green: a.green,
      greenRate: round4(ratio(a.green, a.total)),
    }))
    .sort((a, b) => b.total - a.total || a.skill.localeCompare(b.skill));

  const trend: GroundingTrendPoint[] = Array.from(trendBuckets.entries())
    .map(([period, b]) => ({
      period,
      totalCriteria: b.total,
      mechanical: b.mechanical,
      groundingRatio: round4(ratio(b.mechanical, b.total)),
    }))
    // Oldest → newest; "unknown" sinks to the end.
    .sort((a, b) => {
      if (a.period === "unknown") return 1;
      if (b.period === "unknown") return -1;
      return a.period.localeCompare(b.period);
    });

  const groundingRatio = round4(ratio(mechanical, totalCriteria));
  const judgedRatio = round4(ratio(judged, totalCriteria));

  return {
    window: { loops: safeLoops.length, rounds: roundCount, roundsWithTrace },
    grounding: {
      totalCriteria,
      mechanical,
      judged,
      unverified,
      groundingRatio,
      judgedRatio,
      byMethod,
      trend,
    },
    planner: {
      archetypeDecided,
      proposed,
      overridden,
      overrideRate: round4(ratio(overridden, archetypeDecided)),
      archetypeDistribution,
      skillGreenRate,
    },
    criteria: {
      totalActionPoints,
      weakCriteria,
      weakRate: round4(ratio(weakCriteria, totalActionPoints)),
      manualOpsSurfaced,
      timedOut,
      timeoutRate: round4(ratio(timedOut, ranCount)),
      finalVerified,
      regressions,
      regressionRate: round4(ratio(regressions, finalVerified)),
    },
    honesty: buildHonesty(totalCriteria, groundingRatio, judgedRatio),
  };
}

/** Numbers-first, honest one-liner (design §5). Empty data says so plainly. */
function buildHonesty(
  totalCriteria: number,
  groundingRatio: number,
  judgedRatio: number,
): string {
  if (totalCriteria === 0) {
    return "No verified acceptance criteria in this window yet — nothing to ground.";
  }
  const mechPct = Math.round(groundingRatio * 100);
  const judgePct = Math.round(judgedRatio * 100);
  const restPct = Math.max(0, 100 - mechPct - judgePct);
  return (
    `${mechPct}% of criteria in this window were mechanically verified` +
    ` (tests / cited evidence / live smoke); ${judgePct}% were judged by a model` +
    (restPct > 0 ? `; ${restPct}% were unverified or manual-ops.` : ".")
  );
}
