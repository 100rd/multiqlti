/**
 * execution-trace.ts — Stage 4 (design §8, the observability tree): the SHARED
 * size-clamp + string-scrub for the unified {@link ExecutionTrace}.
 *
 * The trace is a phase → controller → worker → skill → criterion tree BOTH archetypes
 * emit (the coder path builds it from the executor's `ApOutcome[]`; the research path
 * builds it from the runner's steps + P0 `CriterionEvidence[]`), so the FE has ONE
 * tree renderer. This module is deliberately tiny and dependency-free (no worktree /
 * git / coder machinery) so BOTH `sdlc/executor.ts` and `research/research-runner.ts`
 * can import `clampTrace` WITHOUT dragging each other's module graph in.
 *
 * SECURITY (BINDING — the trace is UNTRUSTED model/skill text + tool NAMES):
 *   - Every string is control-stripped + collapsed + LENGTH-CLAMPED (inert React text,
 *     mirroring the report/testSummary wire). The tree is URL-FREE (no scheme sink).
 *   - `permissionsUsed` are tool NAMES ONLY (Edit/Write/Read | web_search). NO secret
 *     values, NO env, NO credentials, NEVER the Tavily key — the builders only ever
 *     hand this the coder's `allowedTools` / the literal `web_search`, and `scrub`
 *     additionally strips fs paths from the free-text `note`/`summary` fields.
 *   - COUNTS are bounded (workers / skills / criteria / permissions) so a pathological
 *     run can never persist an unbounded object.
 */
import type {
  Archetype,
  ExecutionTrace,
  ExecutionController,
  ExecutionWorker,
  ExecutionSkill,
  ExecutionCriterion,
} from "@shared/types";

// ─── Bounds (counts) ─────────────────────────────────────────────────────────
const MAX_WORKERS = 200; // one per action point / research step — generously bounded
const MAX_SKILLS_PER_WORKER = 20; // ordered skilled steps per AP (test-author, coder, …)
const MAX_CRITERIA_PER_WORKER = 40; // acceptance-criterion leaves per worker
const MAX_PERMISSIONS = 20; // tool names per skill

// ─── Bounds (per-field lengths) ──────────────────────────────────────────────
const LABEL_MAX = 200;
const TITLE_MAX = 200;
const PRIORITY_MAX = 16;
const SKILL_NAME_MAX = 80;
const PERMISSION_MAX = 60;
const CRITERION_MAX = 300;
const NOTE_MAX = 300;
const SUMMARY_MAX = 2_000;

// Control-char class (strip newlines / control bytes). Built from char codes so no
// raw control bytes live in this source file.
const CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]+`, "g");

/**
 * Sanitize UNTRUSTED text for a SINGLE-LINE field: strip control chars / newlines,
 * collapse whitespace, clamp. Mirrors the executor's `sanitizeLine` (kept local so
 * this module stays dependency-free). Never a shell string — inert display text.
 */
function sanitizeLine(value: string, max: number): string {
  return (value ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Scrub fs layout from a free-text field (note / test-summary) before persisting:
 * replace path-like runs with `<path>`, collapse whitespace, clamp. Mirrors the
 * executor's `scrub` (defense-in-depth over the single-line sanitize).
 */
function scrub(value: string, max: number): string {
  return (value ?? "")
    .replace(/\/[^\s'"]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function clampSkill(s: ExecutionSkill): ExecutionSkill {
  return {
    skillName: sanitizeLine(s.skillName, SKILL_NAME_MAX),
    capability: s.capability, // fixed union (read-only | worktree-write | web-read)
    // NAMES ONLY — clamp each + bound the count; never values/secrets/env.
    permissionsUsed: s.permissionsUsed.slice(0, MAX_PERMISSIONS).map((p) => sanitizeLine(p, PERMISSION_MAX)),
    green: s.green === true,
  };
}

function clampCriterion(c: ExecutionCriterion): ExecutionCriterion {
  const out: ExecutionCriterion = {
    criterion: sanitizeLine(c.criterion, CRITERION_MAX),
    method: c.method, // fixed union (test-run | web-evidence | judge | none)
    ran: c.ran === true,
    passed: c.passed === true,
  };
  if (typeof c.fixIterations === "number" && Number.isFinite(c.fixIterations)) {
    out.fixIterations = Math.max(0, Math.trunc(c.fixIterations));
  }
  if (c.summary !== undefined) out.summary = scrub(c.summary, SUMMARY_MAX);
  // Stage A: additive final-state flag — carried through the clamp verbatim (boolean).
  if (typeof c.passedAtFinal === "boolean") out.passedAtFinal = c.passedAtFinal;
  // Timeout policy: additive NOT-ADJUDICATED flag — carried verbatim (boolean).
  if (typeof c.timedOut === "boolean") out.timedOut = c.timedOut;
  // Tool-not-found policy: additive NOT-ADJUDICATED (tooling) flag — carried verbatim.
  if (typeof c.toolMissing === "boolean") out.toolMissing = c.toolMissing;
  return out;
}

function clampWorker(w: ExecutionWorker): ExecutionWorker {
  const out: ExecutionWorker = {
    index: Number.isFinite(w.index) ? Math.trunc(w.index) : 0,
    priority: sanitizeLine(w.priority, PRIORITY_MAX),
    title: sanitizeLine(w.title, TITLE_MAX),
    status: w.status, // fixed union (completed | partial | failed)
    skills: w.skills.slice(0, MAX_SKILLS_PER_WORKER).map(clampSkill),
    criteria: w.criteria.slice(0, MAX_CRITERIA_PER_WORKER).map(clampCriterion),
  };
  if (w.note !== undefined) out.note = sanitizeLine(w.note, NOTE_MAX);
  return out;
}

/**
 * Clamp + scrub an assembled {@link ExecutionTrace} before it is persisted. Bounds
 * every collection count and every string length; strips control chars, paths, and
 * excess whitespace. Idempotent. The builders (executor / research-runner) call this
 * as the LAST step so the persisted jsonb is provably inert + size-bounded.
 */
export function clampTrace(trace: ExecutionTrace): ExecutionTrace {
  const c: ExecutionController = trace.controller;
  const controller: ExecutionController = {
    kind: c.kind, // fixed union (sdlc-executor | research-runner)
    label: sanitizeLine(c.label, LABEL_MAX),
    green: c.green === true,
    workers: c.workers.slice(0, MAX_WORKERS).map(clampWorker),
  };
  if (c.note !== undefined) controller.note = sanitizeLine(c.note, NOTE_MAX);
  return {
    schemaVersion: 1,
    archetype: trace.archetype ?? null,
    controller,
  };
}

// ─── Builders ────────────────────────────────────────────────────────────────
//
// Structural inputs (NOT the executor/research types) keep this module dependency-
// free — the coder path and the research path both build a trace here without
// importing each other's module graph.

/** The subset of the executor's `ApOutcome` the coder trace needs. */
export interface SdlcOutcomeLike {
  index: number;
  priority: string;
  title: string;
  status: "completed" | "partial" | "failed";
  note?: string;
  skills?: string[];
  verification?: {
    method: "test-run" | "judge" | "manual-ops";
    ran: boolean;
    passed: boolean;
    summary: string;
    fixIterations: number;
    criterion: string;
    /** Timeout policy: this AP's own verification run was killed by the wall-clock cap. */
    timedOut?: boolean;
    /** Tool-not-found policy: the command RAN but its own tool is missing (env gap). */
    toolMissing?: boolean;
  };
}

/**
 * Skill NAME → (capability, tool-name ceiling). Mirrors the catalog's baked-in
 * `selectSkillSet` defaults. Renders capability + permissions-used WITHOUT threading
 * the per-step binding through the whole result (design §2 "fallback"): faithful in
 * the common case; may slightly over-state permissions if a skills-table row NARROWED
 * the tools — acceptable for a display-only observability tree.
 */
const SKILL_CAPABILITY: Record<string, { capability: ExecutionSkill["capability"]; tools: string[] }> = {
  "test-author": { capability: "worktree-write", tools: ["Edit", "Write", "Read"] },
  coder: { capability: "worktree-write", tools: ["Edit", "Write", "Read"] },
  research: { capability: "web-read", tools: ["web_search"] },
  synthesize: { capability: "web-read", tools: ["web_search"] },
  verify: { capability: "web-read", tools: ["web_search"] },
};

function skillFromName(skillName: string, green: boolean): ExecutionSkill {
  const meta = SKILL_CAPABILITY[skillName] ?? { capability: "worktree-write" as const, tools: ["Edit", "Write", "Read"] };
  return { skillName, capability: meta.capability, permissionsUsed: [...meta.tools], green };
}

/**
 * Build the coder-path {@link ExecutionTrace} from the executor's per-AP outcomes.
 * Controller green = a PR was opened AND no P0 acceptance-criterion is unmet. Each
 * outcome → one worker; `skills` → skill nodes (green iff the worker did not fail);
 * `verification` → one criterion leaf. Clamped before it is returned.
 *
 * `finalPassed` (Stage A): when the FINAL-STATE re-verification ran, its whole-suite
 * pass/fail is stamped onto every `test-run` criterion as `passedAtFinal` (a single
 * suite run covers all criteria). undefined ⇒ final verification did not run ⇒ the
 * field is omitted (byte-for-byte the pre-Stage-A trace).
 *
 * `finalTimedOut` (timeout policy): when the FINAL whole-suite run was KILLED by the
 * wall-clock cap it was NOT adjudicated — so `passedAtFinal` is NOT stamped (there is
 * no pass/fail to record; `finalPassed` would be a misleading `false`/"regressed"), and
 * every criterion is marked `timedOut` instead. A per-AP run that itself timed out also
 * marks its own criterion `timedOut` (from `verification.timedOut`).
 */
export function buildSdlcTrace(
  archetype: Archetype | null,
  outcomes: readonly SdlcOutcomeLike[],
  result: { prRef: string | null; error?: string },
  finalPassed?: boolean,
  finalTimedOut?: boolean,
): ExecutionTrace {
  const unmetP0 = outcomes.some(
    (o) => o.priority.toUpperCase().startsWith("P0") && o.verification !== undefined && !o.verification.passed,
  );
  const workers: ExecutionWorker[] = outcomes.map((o) => {
    const stepGreen = o.status !== "failed";
    const skills: ExecutionSkill[] = (o.skills ?? []).map((n) => skillFromName(n, stepGreen));
    const criteria: ExecutionCriterion[] = o.verification
      ? [
          {
            criterion: o.verification.criterion,
            method: o.verification.method,
            ran: o.verification.ran,
            passed: o.verification.passed,
            fixIterations: o.verification.fixIterations,
            summary: o.verification.summary,
            // Stage A: stamp the final whole-suite result on the criterion — ONLY for
            // `test-run` criteria (Stage B: the final re-verification is a whole-SUITE test
            // run, irrelevant to `judge`/`manual-ops` leaves, so it is not stamped on them),
            // and UNLESS the final run itself TIMED OUT (unadjudicated: there is no pass/fail
            // to stamp, and `false` here would read as a bogus regression).
            ...(o.verification.method === "test-run" && finalPassed !== undefined && !finalTimedOut
              ? { passedAtFinal: finalPassed }
              : {}),
            // Timeout policy: NOT-ADJUDICATED iff this AP's own run timed out OR (for a
            // test-run criterion) the final whole-suite run timed out. A judge/manual-ops
            // leaf is never affected by the final SUITE timeout.
            ...(o.verification.timedOut || (o.verification.method === "test-run" && finalTimedOut)
              ? { timedOut: true }
              : {}),
            // Tool-not-found policy: NOT-ADJUDICATED (tooling) — the AP's command ran but
            // its own tool is missing (env gap). Carried through so the trace distinguishes
            // it from a bare not-run and from a regression (an env gap, never a red).
            ...(o.verification.toolMissing ? { toolMissing: true } : {}),
          },
        ]
      : [];
    const w: ExecutionWorker = { index: o.index, priority: o.priority, title: o.title, status: o.status, skills, criteria };
    if (o.note !== undefined) w.note = o.note;
    return w;
  });
  const controller: ExecutionController = {
    kind: "sdlc-executor",
    label: "SDLC executor (coder)",
    green: result.prRef !== null && !unmetP0,
    workers,
  };
  if (result.error !== undefined) controller.note = result.error;
  return clampTrace({ schemaVersion: 1, archetype, controller });
}

/** The subset of a research P0-criterion evidence the research trace needs. */
export interface ResearchEvidenceLike {
  criterion: string;
  cited: boolean;
}

/**
 * Build the research-path {@link ExecutionTrace}: three fixed step-workers (research,
 * synthesize, verify), each with its web-read skill; the verify worker carries a
 * web-evidence criterion leaf per P0 evidence. Controller green = report verdict
 * `green`. Clamped before it is returned.
 */
export function buildResearchTrace(
  archetype: Archetype | null,
  evidence: readonly ResearchEvidenceLike[],
  report: { verdict: "green" | "flagged" } | null,
  error?: string,
): ExecutionTrace {
  const stepGreen = report !== null;
  const worker = (index: number, title: string, criteria: ExecutionCriterion[]): ExecutionWorker => ({
    index,
    priority: "",
    title,
    status: stepGreen ? "completed" : "failed",
    skills: [skillFromName(title, stepGreen)],
    criteria,
  });
  const verifyCriteria: ExecutionCriterion[] = evidence.map((e) => ({
    criterion: e.criterion,
    method: "web-evidence",
    ran: true,
    passed: e.cited,
  }));
  const controller: ExecutionController = {
    kind: "research-runner",
    label: "Research runner (web-evidence)",
    green: report?.verdict === "green",
    workers: [worker(1, "research", []), worker(2, "synthesize", []), worker(3, "verify", verifyCriteria)],
  };
  if (error !== undefined) controller.note = error;
  return clampTrace({ schemaVersion: 1, archetype, controller });
}
