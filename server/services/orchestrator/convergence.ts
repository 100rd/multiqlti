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
import { P0_PRIORITY } from "@shared/types";
import type { ActionPoint, ConvergenceVerdict } from "@shared/types";

const actionPointSchema = z.object({
  title: z.string(),
  priority: z.string().optional(),
  effort: z.string().optional(),
  rationale: z.string().optional(),
  tradeoff: z.string().optional(),
  // Stage 1 (design §3.B): an OPTIONAL per-AP verifiable "When … Then …" DoD.
  // Optional ⇒ an unmodified judge still yields a valid verdict (back-compat).
  acceptanceCriterion: z.string().optional(),
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
