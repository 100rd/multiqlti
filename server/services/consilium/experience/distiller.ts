/**
 * distiller.ts — DREAM-1: the PURE distillation of a terminal consilium loop's raw
 * trail into verification-GROUNDED Experience item candidates.
 * Spec: docs/design/experience-plane-dream.md §2 (reads) / §3 (schema) / §6 (grounding).
 *
 * This module is PURE and DB-agnostic: it takes the already-persisted loop row + its
 * rounds (the observer fetches them read-only) and returns item candidates. It NEVER
 * touches the loop controller, the DB, git, or any I/O — the observer owns persistence.
 * That keeps the grounding logic unit-testable in isolation and guarantees the distiller
 * can NEVER mutate or block a running loop (§4 safe-degrade).
 *
 * THE GROUNDING RULE (the crux, §1/§3/§6) — `confidence` is a function of HOW the claim
 * was verified by a signal INDEPENDENT of the coder, NEVER of the coder's self-report:
 *
 *   verified ⇐  (a) a MECHANICAL criterion (test-run OR web-evidence) that RAN and PASSED
 *                   and did not regress / time out          → outcome `independent-pass`; OR
 *               (b) the loop reached the `converged` terminal (the multi-agent review panel
 *                   / single-verifier / human-merge gate independently agreed all P0 closed),
 *                   for a passed criterion of that loop      → outcome `loop-converged`.
 *   refuted  ⇐  a MECHANICAL criterion that RAN and FAILED (the coder believed it worked,
 *                   our verification refuted it)             → outcome `independent-fail`; OR
 *               a criterion that PASSED at implement time but FAILED the final whole-suite
 *                   re-verification (a late-AP regression)   → outcome `regressed`.
 *   observed ⇐  neither: a `judge`/`manual-ops` criterion (an OPINION, not a ground-truth
 *                   check) in a non-converged loop, or a NOT-ADJUDICATED criterion
 *                   (ran=false / timedOut / toolMissing)     → outcome `unverified`.
 *
 * A `judge` criterion is NEVER `verified` on its own say-so — only the loop's own
 * convergence (an independent terminal gate) can lift it, and even then via the
 * `loop-converged` outcome, never via the judge's verdict. A coder's `status:completed`
 * self-report with no passing mechanical criterion and no convergence → never `verified`.
 * This makes "an item marked `verified` from a coder self-report" impossible by construction.
 */
import type { ConsiliumLoopRow, InsertExperienceItem } from "@shared/schema";
import type {
  ExperienceConfidence,
  ExperienceEvidence,
  ExperienceVerification,
  ExecutionCriterion,
  ExecutionTrace,
} from "@shared/types";
import { CONSILIUM_LOOP_TERMINAL_STATES } from "@shared/schema";

/**
 * The slim, DB-agnostic projection of a `ConsiliumLoopRoundRow` the distiller reads
 * (mirrors trust-telemetry's `TelemetryRoundInput` discipline so the grader is PURE and
 * tests can build inputs directly). Only these three fields are consumed.
 */
export interface DistilledRoundInput {
  round: number;
  executionTrace: ExecutionTrace | null | undefined;
  /** A git ref/commit for the round, used as the evidence `diffRef` (null when absent). */
  headCommit: string | null;
}

const TERMINAL = new Set<string>(CONSILIUM_LOOP_TERMINAL_STATES);

/** Mechanical (ground-truth) methods — a real test run or cited web evidence (§5). */
const MECHANICAL_METHODS = new Set<ExecutionCriterion["method"]>(["test-run", "web-evidence"]);

// ── Adversarial bounds (a huge trace must NEVER OOM the distiller) ──────────────
/** Max rounds scanned per loop (a loop is capped at maxRounds=6, but bound anyway). */
const MAX_ROUNDS = 12;
/** Max workers scanned per round. */
const MAX_WORKERS_PER_ROUND = 100;
/** Max criteria scanned per worker. */
const MAX_CRITERIA_PER_WORKER = 50;
/** Max DISTINCT items emitted per loop (duplicates collapse; see mergeCandidate). */
const MAX_ITEMS_PER_LOOP = 50;
/** Clamp for any distilled/model-derived string (claim, AP title). */
const MAX_TEXT = 400;

/** Confidence strength ordering — a stronger signal supersedes a weaker one on merge. */
const CONFIDENCE_RANK: Record<ExperienceConfidence, number> = {
  verified: 3,
  refuted: 2,
  observed: 1,
};

export interface DistillOptions {
  /** The distiller pass id (one per observe cycle) — stamped into provenance. */
  dreamRunId: string;
  /** The loop's grounding ratio at distill time (trust telemetry), or null. */
  groundingRatioAtTime: number | null;
  /** Injectable clock (ISO strings) for deterministic tests. */
  now?: () => Date;
}

/** Clamp + neutralise a distilled string: control-strip, collapse ws, length-bound. */
function clampText(s: unknown): string {
  if (typeof s !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > MAX_TEXT ? cleaned.slice(0, MAX_TEXT) : cleaned;
}

/** Repo display name = the basename of the loop's repoPath (never the full FS path). */
function repoName(repoPath: string): string {
  const trimmed = (repoPath ?? "").replace(/\/+$/, "");
  const base = trimmed.split("/").filter(Boolean).pop() ?? trimmed;
  return clampText(base) || "unknown-repo";
}

/** The independent grounding of ONE criterion leaf, given the loop's terminal state. */
function gradeCriterion(
  c: ExecutionCriterion,
  loopConverged: boolean,
): { confidence: ExperienceConfidence; outcome: ExperienceVerification["outcome"] } {
  const mechanical = MECHANICAL_METHODS.has(c.method);
  const notAdjudicated = c.ran === false || c.timedOut === true || c.toolMissing === true;

  // A late-AP REGRESSION: passed at implement time but failed the final whole-suite
  // re-verify — an independent refutation regardless of the loop's own outcome.
  if (mechanical && c.passed === true && c.passedAtFinal === false && c.timedOut !== true) {
    return { confidence: "refuted", outcome: "regressed" };
  }
  // A mechanical criterion that RAN and PASSED (and did not regress / time out) — the
  // strongest, method-based independent confirmation. Valid even if the loop as a whole
  // did not converge (a real test passed for THIS criterion).
  if (mechanical && !notAdjudicated && c.passed === true) {
    return { confidence: "verified", outcome: "independent-pass" };
  }
  // A mechanical criterion that RAN and FAILED (adjudicated red) — the coder believed
  // it; our verification refuted it. A negative lesson, equally stored (§3).
  if (mechanical && !notAdjudicated && c.passed === false) {
    return { confidence: "refuted", outcome: "independent-fail" };
  }
  // Non-mechanical (judge/manual-ops/none) OR not-adjudicated: no ground-truth signal of
  // its own. Only the loop's OWN convergence (an independent terminal gate) can lift a
  // PASSED criterion to verified — never the judge's say-so.
  if (loopConverged && c.passed === true && !notAdjudicated) {
    return { confidence: "verified", outcome: "loop-converged" };
  }
  return { confidence: "observed", outcome: "unverified" };
}

interface Candidate {
  key: string; // dedup key: criterionClass + normalized claim
  confidence: ExperienceConfidence;
  outcome: ExperienceVerification["outcome"];
  method: ExecutionCriterion["method"];
  claim: string;
  evidence: ExperienceEvidence[];
}

/** Human-readable, verification-grounded claim (a distilled fact, not a bare repo-fact). */
function buildClaim(
  repo: string,
  apTitle: string,
  confidence: ExperienceConfidence,
  method: ExecutionCriterion["method"],
): string {
  const subject = apTitle ? `the criterion "${apTitle}"` : "an unnamed criterion";
  const how =
    confidence === "verified"
      ? `was VERIFIED (${method})`
      : confidence === "refuted"
        ? `was REFUTED (${method}) — the change did not close it`
        : `was OBSERVED only (${method}, no independent ground-truth check)`;
  return clampText(`On ${repo}, ${subject} ${how}.`);
}

/**
 * Distil a TERMINAL loop + its rounds into Experience item candidates (write-ready
 * InsertExperienceItem rows). Returns [] for a non-terminal loop (never distilled) or a
 * loop with no gradeable criteria. Idempotency (skip an already-distilled loop) is the
 * observer's job — this pure function always produces the same output for the same input.
 */
export function distillLoop(
  loop: ConsiliumLoopRow,
  rounds: readonly DistilledRoundInput[],
  opts: DistillOptions,
): InsertExperienceItem[] {
  // A RUNNING (non-terminal) loop is NEVER distilled (§4 — background, post-loop only).
  if (!TERMINAL.has(loop.state)) return [];

  const now = opts.now ?? (() => new Date());
  const createdAtIso = now().toISOString();
  const repo = repoName(loop.repoPath);
  const loopConverged = loop.state === "converged";
  const archetype = loop.archetype ?? null;

  // ── ROLE-3 (standing-role.md §3/§6/§8) — SCOPE experience by role ────────────
  // When THIS loop was ROLE-FIRED (ROLE-1 wake / ROLE-2 trigger records
  // `triggerProvenance.role`), stamp the role (+ its concern) onto every item's scope so
  // the item records "as THIS role on THIS concern, pattern X was verified". A non-role
  // loop leaves both ABSENT — its items are byte-identical to pre-ROLE-3 (repo-scoped).
  // We stamp only the server-generated IDs (never the role's human `name`), clamped inert
  // for defence-in-depth; a concern is stamped ONLY alongside a role (meaningless alone).
  const roleProv = loop.triggerProvenance?.role;
  const roleId = clampText(roleProv?.roleId) || null;
  const concernId = roleId ? clampText(roleProv?.concernId) || null : null;

  // Collapse duplicate (criterionClass + claim) leaves across rounds into ONE item,
  // keeping the STRONGEST confidence and accumulating (bounded) evidence links.
  const byKey = new Map<string, Candidate>();

  const boundedRounds = [...rounds]
    .sort((a, b) => a.round - b.round)
    .slice(0, MAX_ROUNDS);

  for (const round of boundedRounds) {
    const trace = round.executionTrace;
    if (!trace || !trace.controller || !Array.isArray(trace.controller.workers)) continue;
    const workers = trace.controller.workers.slice(0, MAX_WORKERS_PER_ROUND);
    for (const worker of workers) {
      if (!worker || !Array.isArray(worker.criteria)) continue;
      const apTitle = clampText(worker.title);
      const criteria = worker.criteria.slice(0, MAX_CRITERIA_PER_WORKER);
      for (const c of criteria) {
        if (!c || typeof c.method !== "string") continue;
        const { confidence, outcome } = gradeCriterion(c, loopConverged);
        const criterionClass = c.method;
        const claim = buildClaim(repo, apTitle, confidence, c.method);
        const key = `${criterionClass}::${claim}`;
        const diffRef =
          (typeof round.headCommit === "string" && round.headCommit) ||
          (typeof loop.prRef === "string" && loop.prRef) ||
          null;
        const evidence: ExperienceEvidence = {
          loopId: loop.id,
          round: round.round,
          apTitle,
          diffRef,
        };

        const existing = byKey.get(key);
        if (existing) {
          // Same claim seen again — supersede confidence if this leaf is stronger,
          // and append the evidence link (bounded to a few per item).
          if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[existing.confidence]) {
            existing.confidence = confidence;
            existing.outcome = outcome;
          }
          if (existing.evidence.length < 8) existing.evidence.push(evidence);
        } else {
          if (byKey.size >= MAX_ITEMS_PER_LOOP) continue; // hard cap — never OOM.
          byKey.set(key, {
            key,
            confidence,
            outcome,
            method: c.method,
            claim,
            evidence: [evidence],
          });
        }
      }
    }
  }

  const items: InsertExperienceItem[] = [];
  for (const cand of byKey.values()) {
    const verification: ExperienceVerification = {
      method: cand.method,
      outcome: cand.outcome,
      groundingRatioAtTime: opts.groundingRatioAtTime,
    };
    items.push({
      projectId: loop.projectId ?? null,
      scope: {
        repo,
        archetype,
        criterionClass: cand.method,
        // ROLE-3: additive — present ONLY for a role-fired loop (fail-closed on read).
        ...(roleId ? { role: roleId } : {}),
        ...(concernId ? { concern: concernId } : {}),
      },
      claim: cand.claim,
      evidence: cand.evidence,
      verification,
      confidence: cand.confidence,
      successDelta: null, // DREAM-3 fills this from measured reuse.
      provenance: {
        createdAt: createdAtIso,
        dreamRunId: opts.dreamRunId,
        sourceLoops: [loop.id],
      },
      freshness: {
        lastConfirmedAt: createdAtIso,
        // Descriptor only in DREAM-1; the decay/re-grounding machinery is DREAM-3 (§6).
        decayPolicy: "reuse:5",
      },
      relatedComponents: [],
      sourceLoopId: loop.id,
    });
  }
  return items;
}
