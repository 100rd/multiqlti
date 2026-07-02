/**
 * readConvergence — derive a machine-readable convergence verdict from a judge
 * task's output. Pure (no storage, no I/O, no `any`); the consilium loop FSM
 * calls it on a persisted judge `execution.output` to decide deterministically
 * instead of parsing prose.
 *
 * Trust-then-derive contract:
 *   1. If a well-typed `output.convergence` object is present, TRUST it.
 *   2. Otherwise DERIVE from `action_points` — convergence ⟺ zero open P0s.
 *      This makes the signal work against an unmodified judge that only emits
 *      `action_points` (the Omniscience v3 group relies on this).
 *
 * Conservative default (no parseable verdict): we only report `converged: true`
 * when we POSITIVELY observe zero P0 action points. When the input is malformed
 * or carries no recognizable verdict at all, we return
 * `{ converged: false, openP0: 0, openActionPoints: [] }` — "not converged
 * unless we positively see zero P0s". This is the safe default for the loop:
 * an unreadable verdict must not silently end the loop as if it had converged.
 */
import { z } from "zod";
import { P0_PRIORITY, JUDGE_PROPOSABLE_METHODS } from "@shared/types";
import type { ActionPoint, ConvergenceVerdict, Archetype, VerificationMethod } from "@shared/types";

const actionPointSchema = z.object({
  title: z.string(),
  priority: z.string().optional(),
  effort: z.string().optional(),
  rationale: z.string().optional(),
  tradeoff: z.string().optional(),
  // Stage 1 (design §3.B): an OPTIONAL per-AP verifiable "When … Then …" DoD.
  // Optional ⇒ an unmodified judge still yields a valid verdict (back-compat).
  acceptanceCriterion: z.string().optional(),
  // Stage B (design §5 "Stage 6"): the OPTIONAL judge-proposed verification method.
  // ENUM-CLAMPED to the judge-proposable subset; `.catch(undefined)` DROPS an invalid
  // value to absent (the planner fills the archetype default) rather than failing the
  // WHOLE action point parse — a prompt-injected method can never smuggle a value past
  // the enum or drop a legitimate action point. Absent ⇒ back-compat.
  verificationMethod: z.enum(JUDGE_PROPOSABLE_METHODS).optional().catch(undefined),
});

/** The trusted `output.convergence` object, when the judge emits one. */
const convergenceSchema = z.object({
  converged: z.boolean(),
  open_p0: z.number().int().nonnegative().optional(),
  open_action_points: z.array(actionPointSchema).optional(),
});

/** Loosely typed judge output: only the fields we read, all optional. */
const judgeShapeSchema = z.object({
  output: z.unknown().optional(),
  convergence: z.unknown().optional(),
  action_points: z.unknown().optional(),
});

/** The conservative verdict used when nothing parseable is present. */
const NOT_CONVERGED: ConvergenceVerdict = {
  converged: false,
  openP0: 0,
  openActionPoints: [],
};

// ─── Output bounds (Security L-2) ──────────────────────────────────────────
// A malicious or malfunctioning judge could emit a huge list of action points
// or megabyte-long string fields, bloating the DB row and the DEV handoff
// payload. Cap the count and truncate each string field defensively.
const MAX_ACTION_POINTS = 50;
const MAX_TITLE_LEN = 500;
const MAX_FIELD_LEN = 1000;
// Stage 1: the per-AP acceptance criterion is UNTRUSTED model text — clamp it the
// same way as the other free-text fields so a huge criterion can't bloat the row.
const MAX_CRITERION_LEN = 1000;

/** Truncate a string to `max` chars; pass through `undefined`. */
function clampStr(v: string | undefined, max: number): string | undefined {
  if (v === undefined) return undefined;
  return v.length > max ? v.slice(0, max) : v;
}

/** Bound one action point's string fields to sane lengths. */
function boundActionPoint(p: ActionPoint): ActionPoint {
  return {
    title: clampStr(p.title, MAX_TITLE_LEN) ?? "",
    priority: clampStr(p.priority, MAX_FIELD_LEN),
    effort: clampStr(p.effort, MAX_FIELD_LEN),
    rationale: clampStr(p.rationale, MAX_FIELD_LEN),
    tradeoff: clampStr(p.tradeoff, MAX_FIELD_LEN),
    // Stage 1: this object is REBUILT from a fixed field list, so a field NOT
    // copied here is silently stripped on persist/read. Carry the criterion
    // through (clamped) so it survives the verdict round-trip + DEV handoff.
    acceptanceCriterion: clampStr(p.acceptanceCriterion, MAX_CRITERION_LEN),
    // Stage B: carry the (enum-clamped) verification method through the same rebuild so
    // it survives the verdict round-trip + DEV handoff. Already bounded to the fixed
    // union by the schema; a `undefined` is simply absent (planner default fills it).
    ...(p.verificationMethod !== undefined ? { verificationMethod: p.verificationMethod } : {}),
  };
}

/** Cap the list length and truncate each entry's fields. */
function boundActionPoints(points: ActionPoint[]): ActionPoint[] {
  return points.slice(0, MAX_ACTION_POINTS).map(boundActionPoint);
}

/**
 * Locate the inner object that carries `convergence` / `action_points`. Callers
 * may pass either the full judge result (`{ output: {...} }`) or just its
 * `output`, so we look one level down into `.output` as well.
 */
function pickJudgeBody(judgeOutput: unknown): Record<string, unknown> | null {
  const top = judgeShapeSchema.safeParse(judgeOutput);
  if (!top.success) return null;
  const inner = judgeShapeSchema.safeParse(top.data.output);
  // Prefer the level that actually carries the signal fields.
  const innerBody = inner.success ? (top.data.output as Record<string, unknown>) : null;
  if (innerBody && (innerBody.convergence !== undefined || innerBody.action_points !== undefined)) {
    return innerBody;
  }
  return judgeOutput && typeof judgeOutput === "object" && !Array.isArray(judgeOutput)
    ? (judgeOutput as Record<string, unknown>)
    : null;
}

/** Trust a well-typed `convergence` object, filling `openP0` from the list. */
function fromTrusted(convergence: unknown): ConvergenceVerdict | null {
  const parsed = convergenceSchema.safeParse(convergence);
  if (!parsed.success) return null;
  const openActionPoints = boundActionPoints(parsed.data.open_action_points ?? []);
  const openP0 = parsed.data.open_p0 ?? openActionPoints.length;
  return { converged: parsed.data.converged, openP0, openActionPoints };
}

/** Derive convergence from `action_points` — open P0s block convergence. */
function fromActionPoints(actionPoints: unknown): ConvergenceVerdict | null {
  const parsed = z.array(actionPointSchema).safeParse(actionPoints);
  if (!parsed.success) return null;
  const openActionPoints = boundActionPoints(
    parsed.data.filter((p) => p.priority === P0_PRIORITY),
  );
  return {
    converged: openActionPoints.length === 0,
    openP0: openActionPoints.length,
    openActionPoints,
  };
}

/**
 * Read a {@link ConvergenceVerdict} from arbitrary judge output. Never throws.
 */
export function readConvergence(judgeOutput: unknown): ConvergenceVerdict {
  const body = pickJudgeBody(judgeOutput);
  if (!body) return NOT_CONVERGED;

  const trusted = fromTrusted(body.convergence);
  if (trusted) return trusted;

  const derived = fromActionPoints(body.action_points);
  if (derived) return derived;

  // Neither a convergence object nor a parseable action_points array: treat as
  // "no parseable verdict" → conservatively NOT converged (see file header).
  return NOT_CONVERGED;
}

/**
 * Extract the FULL `action_points` list from a judge output (ALL priorities, not
 * just open P0s), bounded with the SAME caps as {@link readConvergence}
 * (`MAX_ACTION_POINTS` count + per-field clamps). Used by the human-triggered
 * execute-sdlc path: a maintainer who clicks "execute this verdict" wants EVERY
 * action point the judge flagged implemented, whereas the loop's developing phase
 * (`readConvergence().openActionPoints`) intentionally narrows to the still-open
 * P0s. Returns `[]` for a missing/unparseable verdict (the route maps that to a
 * 400 "no action points to execute"). Never throws.
 *
 * SECURITY: this is the SERVER-READ verdict — the request body's action_points (if
 * any) are NEVER consulted. The returned text is UNTRUSTED model output; the SDLC
 * executor sanitizes/clamps it again before it reaches a commit/PR body (never a
 * shell string), and the Draft-PR human gate is the real containment.
 */
export function extractActionPoints(judgeOutput: unknown): ActionPoint[] {
  const body = pickJudgeBody(judgeOutput);
  if (!body) return [];
  const parsed = z.array(actionPointSchema).safeParse(body.action_points);
  if (!parsed.success) return [];
  return boundActionPoints(parsed.data);
}

/**
 * Stage B (design §5 "Stage 6") — the PLANNER's per-criterion method ASSIGNMENT. The
 * judge PROPOSES a method per action point (carried through {@link extractActionPoints}
 * / {@link readConvergence}); this fills every ABSENT method from the loop's ARCHETYPE
 * DEFAULT so each criterion has a ground-truth check the executor can route on:
 *   - `repo-assessment` (or null/unknown archetype) → `test-run` (the code default).
 *   - `research` → `web-evidence` (cited sources — assigned here, never judge-proposed).
 *   - `infra` → `test-run` (the code/deploy default until a `live-deploy-smoke` method
 *     is wired; §5 lists it as future — kept conservative rather than inventing a route).
 *
 * A judge-proposed method is ALREADY enum-clamped by {@link actionPointSchema}, so this
 * only fills gaps — it never overrides a valid proposal. PURE (no I/O); the planner
 * persists the result and the SDLC executor routes on it. Returns a NEW array (the inputs
 * are not mutated). When `perCriterionMethod` is OFF the callers never invoke this, so the
 * develop path is byte-for-byte unchanged.
 */
export function archetypeDefaultMethod(archetype: Archetype | null): VerificationMethod {
  return archetype === "research" ? "web-evidence" : "test-run";
}

export function normalizeActionPointMethods(
  actionPoints: readonly ActionPoint[],
  archetype: Archetype | null,
): ActionPoint[] {
  const fallback = archetypeDefaultMethod(archetype);
  return actionPoints.map((ap) =>
    ap.verificationMethod !== undefined ? ap : { ...ap, verificationMethod: fallback },
  );
}

// ─── Stage C (design §9 "Stage 7") — acceptance-criterion QA ─────────────────
// A MECHANICAL, no-LLM lint over each AP's `acceptanceCriterion`. Acceptance
// criteria are judge-generated and OPTIONAL; nothing validated their quality, so
// a vacuous DoD let the implement phase converge to green on the wrong target
// (Goodhart). This flags a WEAK criterion and demotes its AP to `judge` so it can
// never count as "tests green" on a criterion no test actually pins.
//
// DESIGN BIAS — false-negatives are PREFERRED over false-positives. Demoting a GOOD
// criterion to `judge` (a false positive) is the harmful error (it needlessly hands a
// mechanically-checkable criterion to a subjective model), so every rule below is
// deliberately conservative: only a criterion that is CLEARLY weak trips it. No NLP.

/** A short stoplist of PURELY-ABSTRACT words — a criterion made of only these (plus
 *  structural glue) names no concrete, observable signal. Lower-case, matched whole-token. */
const ABSTRACT_WORDS = new Set<string>([
  "works", "work", "working", "correct", "correctly", "proper", "properly",
  "good", "fine", "ok", "okay", "valid", "validly", "successful", "successfully",
  "success", "done", "complete", "completed", "passes", "pass", "passing",
  "handled", "handles", "handle", "better", "improved", "improve", "clean",
  "cleanly", "robust", "reliable", "reliably", "as", "expected",
]);

/** Structural/stop words that carry no signal on their own (so "purely abstract"
 *  is judged over the CONTENT tokens, not the "when/then/the/is" glue). */
const STRUCTURAL_WORDS = new Set<string>([
  "when", "then", "the", "a", "an", "is", "are", "be", "and", "or", "it",
  "to", "of", "in", "on", "for", "with", "that", "this", "should", "must",
  "will", "shall", "at", "by",
]);

/** Minimum length a `test-run` criterion must reach to plausibly name a runnable
 *  observable. SIMPLE + documented (see file/§9 note) — not clever NLP. */
const MIN_TESTRUN_CRITERION_LEN = 40;

/**
 * Return `true` when `criterion` is WEAK for the given verification `method`. Rules
 * (each conservative — false-negatives preferred):
 *   (a) NON-EMPTY — absent or whitespace-only ⇒ weak.
 *   (b) SHAPE — must carry the documented "When … Then …" form; case-insensitive
 *       presence of a "when" followed later by a "then" is SUFFICIENT (we do not
 *       parse the clause — over-fitting would demote legitimate phrasings).
 *   (c) CONCRETE SIGNAL (test-run only) — a mechanically-checked criterion must name
 *       something runnable/observable: length > MIN_TESTRUN_CRITERION_LEN chars AND
 *       not composed PURELY of abstract filler ("works", "is correct", …). `judge` /
 *       `manual-ops` criteria are adjudicated by a model/human, so the length+signal
 *       floor does not apply to them.
 * PURE; never throws.
 */
export function isWeakCriterion(
  criterion: string | undefined,
  method: VerificationMethod | undefined,
): boolean {
  const c = (criterion ?? "").trim();
  // (a) non-empty
  if (c.length === 0) return true;
  // (b) "When … Then …" shape — a "when" with a LATER "then" (case-insensitive).
  const lower = c.toLowerCase();
  const whenIdx = lower.indexOf("when");
  const thenIdx = lower.indexOf("then");
  if (whenIdx === -1 || thenIdx === -1 || thenIdx <= whenIdx) return true;
  // (c) concrete, observable signal — enforced ONLY for the mechanical test-run method.
  if (method === "test-run") {
    if (c.length <= MIN_TESTRUN_CRITERION_LEN) return true;
    const contentTokens = lower
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0 && !STRUCTURAL_WORDS.has(t));
    // "purely abstract" ⇒ EVERY content token is an abstract filler word. Requiring
    // ALL tokens to be abstract keeps this rare (conservative / false-negative-biased).
    const hasConcrete = contentTokens.some((t) => !ABSTRACT_WORDS.has(t));
    if (!hasConcrete) return true;
  }
  return false;
}

/**
 * Stage C — flag weak criteria and DEMOTE them to `judge`. For each AP whose criterion
 * fails {@link isWeakCriterion} (evaluated against its CURRENT method, so a `test-run`
 * AP is held to the stricter concrete-signal bar): set `weakCriterion: true` and force
 * `verificationMethod: "judge"` — the Stage-B judge verifier then adjudicates it against
 * the diff (REFUTE-by-default) instead of a test harness rubber-stamping a vacuous DoD.
 * `manual-ops` is PRESERVED (an operational action outside the repo is never a test and
 * never green regardless). PURE — returns a NEW array, inputs unmutated; a passing AP is
 * returned UNCHANGED (no `weakCriterion` field ⇒ back-compat). Callers invoke this ONLY
 * when `planner.criteriaQa.enabled`, so with the switch off the AP list is byte-identical.
 */
export function applyCriteriaQa(actionPoints: readonly ActionPoint[]): ActionPoint[] {
  return actionPoints.map((ap) => {
    if (!isWeakCriterion(ap.acceptanceCriterion, ap.verificationMethod)) return ap;
    // manual-ops stays manual-ops; everything else (test-run / judge / absent) → judge.
    const method: VerificationMethod =
      ap.verificationMethod === "manual-ops" ? "manual-ops" : "judge";
    return { ...ap, weakCriterion: true, verificationMethod: method };
  });
}
