/**
 * consolidator.ts — DREAM-3: the PURE consolidation of accumulated Experience items.
 * Spec: docs/design/experience-plane-dream.md §4 (scheduled/consolidating),
 * §6 (freshness/decay/self-correction/contradiction), §9 (DREAM-3).
 *
 * This module is PURE and DB-agnostic (like the DREAM-1 distiller and the DREAM-2
 * reader): it takes an already-read, bounded batch of `ExperienceItemRow`s and returns a
 * `ConsolidationPlan` (updates + deletes) for the observer to apply. It performs NO I/O,
 * touches NO loop controller, NO state graph, NO SKILL.md — so it can NEVER block, race,
 * or mutate a running loop or DREAM-1's writes (§4/§5 safe-degrade). The observer owns
 * persistence; keeping the merge/decay/contradiction logic pure makes it unit-testable
 * and guarantees the pass is deterministic and idempotent.
 *
 * WHAT IT DOES, per (projectId, scope, normalized-claim) GROUP (§4/§6):
 *
 *   1. DEDUP / MERGE — items in the SAME group collapse into ONE survivor: evidence is
 *      UNIONED (never lost), the STRONGEST verification is kept (verified > refuted >
 *      observed by grounding rank — a grounded verdict always beats a bare `observed`),
 *      relatedComponents + provenance.sourceLoops are UNIONED, freshness.lastConfirmedAt
 *      takes the MAX. The non-survivor members are DELETED. A merge can NEVER lose
 *      evidence and NEVER flips a grounded verdict to a weaker one.
 *
 *   2. DECAY (§6 self-correction) — a `verified` survivor unconfirmed for longer than
 *      `staleVerifiedDays` is demoted to `observed` and WRITTEN BACK (the durable version
 *      of DREAM-2's read-time down-weight — the store self-corrects, not just the read).
 *      Recorded in `consolidation.decayedFrom` for audit. A demoted item is NEVER
 *      silently re-upgraded; only a FRESH grounded duplicate (a real re-verification)
 *      lifts it back on a later pass (that duplicate merges in as `verified`, fresh).
 *
 *   3. CONTRADICTION (§6) — when a group holds BOTH a `verified` and a `refuted` grounded
 *      outcome on the same scope+claim, the two are NOT collapsed: a positive survivor
 *      (verified/observed) and a negative survivor (refuted) are BOTH KEPT and cross-
 *      flagged as a conflict, so the planner sees "worked here / failed there" and the
 *      fresher-verified one leads. Never a silent overwrite.
 *
 *   4. successDelta (§3 R2 / §6) — recomputed from the AVAILABLE reuse signal: when the
 *      same (scope, claim) recurred across >= 2 INDEPENDENT loops with grounded outcomes,
 *      `successDelta` = (nVerified − nRefuted) / (nVerified + nRefuted) ∈ [−1, 1] — the
 *      measured net effect of the pattern being reused. A single occurrence has no reuse,
 *      so `successDelta` stays null. (The FULL reuse-attribution — linking DREAM-2's
 *      plan-time injection of item X to the LATER loop's independent outcome — needs a
 *      persisted injection→outcome edge that DREAM-2 only LOGS today; that stronger signal
 *      is a documented boundary, see the observer header.)
 *
 * IDEMPOTENCY (the anti-thrash guarantee, §4): re-running the pass on an already-
 * consolidated batch produces NO updates and NO deletes — every group is already a single
 * survivor (or the two stable contradiction survivors), and an update is emitted ONLY when
 * a field would actually change. The pass converges and then holds steady.
 */
import type { ExperienceItemRow } from "@shared/schema";
import type {
  ExperienceConfidence,
  ExperienceConsolidation,
  ExperienceEvidence,
  ExperienceProvenance,
  ExperienceVerification,
} from "@shared/types";

// ── Adversarial bounds (a large store must NEVER OOM the pass) ──────────────────
/** Hard cap on items processed in one pass (the observer also caps the read). */
const MAX_ITEMS = 5_000;
/** Max evidence links kept on a merged survivor (union is bounded — never unbounded growth). */
const MAX_EVIDENCE = 16;
/** Max source loops kept on a merged survivor's provenance. */
const MAX_SOURCE_LOOPS = 32;
/** Max relatedComponents kept on a merged survivor. */
const MAX_RELATED = 32;
/** Clamp for the inert conflict note. */
const MAX_NOTE = 200;

const MS_PER_DAY = 86_400_000;

/**
 * Grounding rank for MERGE (which verification a single survivor keeps). A grounded
 * verdict (verified/refuted) always beats a bare `observed`; between the two grounded
 * verdicts `verified` leads — but a group holding BOTH is a CONTRADICTION (handled
 * separately, never collapsed by this rank).
 */
const MERGE_RANK: Record<ExperienceConfidence, number> = {
  verified: 3,
  refuted: 2,
  observed: 1,
};

export interface ConsolidateOptions {
  /** The consolidation pass id (one per sweep) — stamped into `consolidation`. */
  dreamRunId: string;
  /**
   * A `verified` item unconfirmed for longer than this (days) is demoted to `observed`
   * (§6). MUST match DREAM-2's `read.staleVerifiedDays` so the durable decay agrees with
   * the read-time down-weight.
   */
  staleVerifiedDays: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Optional override of the per-pass item cap (defaults to MAX_ITEMS). */
  maxItems?: number;
}

/** A single field-level update to apply to a SURVIVING item (never a full overwrite). */
export interface ExperienceItemPatch {
  claim?: string;
  evidence?: ExperienceEvidence[];
  verification?: ExperienceVerification;
  confidence?: ExperienceConfidence;
  successDelta?: number | null;
  provenance?: ExperienceProvenance;
  freshness?: ExperienceItemRow["freshness"];
  relatedComponents?: string[];
  consolidation?: ExperienceConsolidation;
}

export interface ExperienceItemUpdate {
  id: string;
  patch: ExperienceItemPatch;
}

export interface ConsolidationPlan {
  /** Field-level updates for surviving items (merge results / decay / successDelta / flags). */
  updates: ExperienceItemUpdate[];
  /** Ids of merged-away DUPLICATES to delete (their evidence already folded into a survivor). */
  deletes: string[];
  /** Observability counters (logged by the observer). */
  stats: {
    scanned: number;
    groups: number;
    merged: number; // survivors that absorbed >= 1 duplicate
    deleted: number;
    decayed: number; // survivors demoted verified → observed
    conflicts: number; // contradiction groups (both survivors kept)
    successDeltaSet: number;
  };
}

/**
 * Normalize a claim to its OUTCOME-INDEPENDENT criterion identity — the load-bearing
 * grouping key (§4 dedup / §6 contradiction). The DREAM-1 distiller embeds the outcome
 * verb IN the claim text (`... the criterion "X" was VERIFIED/REFUTED/OBSERVED ...`), so a
 * verified and a refuted item about the SAME criterion have DIFFERENT claim strings. If we
 * grouped on the raw claim, those two would never meet and a CONTRADICTION could never be
 * detected. So we cut the claim at the outcome clause (` was `) and keep the prefix — the
 * stable "on <repo>, the criterion <title>" identity that is the SAME across all three
 * outcomes. Same criterion, opposite outcome ⇒ same key ⇒ contradiction fires; two
 * DIFFERENT criteria keep different titles ⇒ different keys ⇒ never wrongly merged.
 *
 * Falls back to the full normalized claim when there is no ` was ` clause — still a safe,
 * exact-match dedup, just without outcome-blind contradiction on that (non-distiller) shape.
 */
function normalizeClaim(claim: string): string {
  const lowered = (typeof claim === "string" ? claim : "").toLowerCase();
  const cut = lowered.indexOf(" was ");
  const identity = cut >= 0 ? lowered.slice(0, cut) : lowered;
  return identity
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[.,;:!?"'`()[\]{}\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Group key: project + scope + outcome-independent claim identity. projectId is INCLUDED
 *  so two projects with a same-basename repo NEVER cross-merge (isolation, §5). Joined
 *  with a space delimiter that cannot survive inside a normalized identity (no collisions). */
function groupKey(item: ExperienceItemRow): string {
  const s = item.scope;
  const repo = s?.repo ?? "";
  const arch = s?.archetype ?? "";
  const klass = s?.criterionClass ?? "";
  return [item.projectId ?? "", repo, arch, klass, normalizeClaim(item.claim)].join(" ");
}

/** ms-safe parse of an ISO stamp; unparseable ⇒ 0 (maximally stale) for a MAX comparison. */
function parseIso(s: string | null | undefined): number {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** Age in days since an item's `lastConfirmedAt`; unparseable ⇒ +Infinity (maximally stale). */
function ageDays(item: ExperienceItemRow, now: number): number {
  const t = parseIso(item.freshness?.lastConfirmedAt);
  if (t === 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now - t) / MS_PER_DAY);
}

/** Dedup an evidence list by (loopId, round, diffRef), preserving order, bounded. */
function unionEvidence(items: readonly ExperienceItemRow[]): ExperienceEvidence[] {
  const seen = new Set<string>();
  const out: ExperienceEvidence[] = [];
  for (const it of items) {
    const list = Array.isArray(it.evidence) ? it.evidence : [];
    for (const ev of list) {
      if (!ev) continue;
      const k = `${ev.loopId}${ev.round}${ev.diffRef ?? ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(ev);
      if (out.length >= MAX_EVIDENCE) return out;
    }
  }
  return out;
}

/** Union + sort + bound a string list (relatedComponents / sourceLoops) for a stable survivor. */
function unionStrings(lists: Array<readonly string[] | undefined | null>, cap: number): string[] {
  const set = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const s of list) if (typeof s === "string" && s.length > 0) set.add(s);
  }
  return Array.from(set).sort().slice(0, cap);
}

/** Deterministic survivor pick within a partition: strongest confidence, then freshest, then lowest id. */
function pickSurvivor(members: readonly ExperienceItemRow[], now: number): ExperienceItemRow {
  return [...members].sort((a, b) => {
    const r = MERGE_RANK[b.confidence] - MERGE_RANK[a.confidence];
    if (r !== 0) return r;
    const fa = ageDays(a, now);
    const fb = ageDays(b, now);
    if (fa !== fb) return fa - fb; // fresher (smaller age) first
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

/** The strongest confidence present in a set of members (never returns a contradiction). */
function strongestConfidence(members: readonly ExperienceItemRow[]): ExperienceConfidence {
  let best: ExperienceConfidence = "observed";
  for (const m of members) {
    if (MERGE_RANK[m.confidence] > MERGE_RANK[best]) best = m.confidence;
  }
  return best;
}

/**
 * The reuse signal (§3 R2 / §6): net measured effect of a pattern that RECURRED across
 * INDEPENDENT loops. Returns a value in [−1, 1], or null when there is no reuse (fewer
 * than 2 grounded occurrences across distinct loops). Verified occurrences count +1,
 * refuted −1; observed is not a ground-truth outcome and does not count.
 */
function reuseSuccessDelta(members: readonly ExperienceItemRow[]): number | null {
  const verifiedLoops = new Set<string>();
  const refutedLoops = new Set<string>();
  for (const m of members) {
    const loops =
      Array.isArray(m.provenance?.sourceLoops) && m.provenance.sourceLoops.length > 0
        ? m.provenance.sourceLoops
        : [m.sourceLoopId];
    for (const lid of loops) {
      if (typeof lid !== "string" || lid.length === 0) continue;
      if (m.confidence === "verified") verifiedLoops.add(lid);
      else if (m.confidence === "refuted") refutedLoops.add(lid);
    }
  }
  // A loop that both verified AND refuted the pattern (across items) is itself a
  // contradiction at the source; count it on neither side to avoid double-weighting.
  for (const lid of Array.from(verifiedLoops)) {
    if (refutedLoops.has(lid)) {
      verifiedLoops.delete(lid);
      refutedLoops.delete(lid);
    }
  }
  const nV = verifiedLoops.size;
  const nR = refutedLoops.size;
  const total = nV + nR;
  if (total < 2) return null; // no reuse across independent loops ⇒ no measured effect.
  return (nV - nR) / total;
}

/** Round a delta to a stable precision so equal signals compare equal (idempotency). */
function roundDelta(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

interface BuiltSurvivor {
  patch: ExperienceItemPatch;
  /** True if this survivor absorbed >= 1 duplicate (for stats.merged). */
  mergedFrom: number;
  /** True if decay demoted it this pass (for stats.decayed). */
  decayed: boolean;
}

/**
 * Build the merged/decayed patch for ONE survivor from its partition `members`. `conflict`
 * cross-links the opposing contradiction survivor (or null). Applies decay to a stale
 * `verified` survivor. Sets `successDelta` from the whole GROUP's reuse signal.
 */
function buildSurvivor(
  survivor: ExperienceItemRow,
  members: readonly ExperienceItemRow[],
  groupMembers: readonly ExperienceItemRow[],
  opts: ConsolidateOptions,
  now: number,
  nowIso: string,
  conflict: ExperienceConsolidation["conflict"],
): BuiltSurvivor {
  const evidence = unionEvidence(members);
  const relatedComponents = unionStrings(members.map((m) => m.relatedComponents), MAX_RELATED);
  const sourceLoops = unionStrings(
    members.map((m) => (m.provenance?.sourceLoops?.length ? m.provenance.sourceLoops : [m.sourceLoopId])),
    MAX_SOURCE_LOOPS,
  );
  const lastConfirmedAt = members
    .map((m) => m.freshness?.lastConfirmedAt)
    .filter((s): s is string => typeof s === "string" && parseIso(s) > 0)
    .sort((a, b) => parseIso(b) - parseIso(a))[0] ?? survivor.freshness.lastConfirmedAt;

  // Kept verification = the strongest grounded member's verification (never a weaker one).
  let confidence = strongestConfidence(members);
  const kept = pickSurvivor(members.filter((m) => m.confidence === confidence), now);
  const verification: ExperienceVerification = kept.verification;

  // DECAY (§6): a stale `verified` survivor is demoted to `observed`, written back.
  let decayedFrom: ExperienceConfidence | null = null;
  const mergedAge = Math.max(0, (now - parseIso(lastConfirmedAt)) / MS_PER_DAY);
  if (confidence === "verified" && mergedAge > opts.staleVerifiedDays) {
    decayedFrom = "verified";
    confidence = "observed";
  }

  // successDelta is (re)computed ONLY when this pass actually MERGES >= 2 distinct items
  // (i.e. the pattern recurred across independent loops THIS pass — the reuse signal is
  // measured from the members' own grounded verdicts, each a distinct loop in the common
  // DREAM-1 case). For a lone survivor we DO NOT recompute — a merged survivor collapses
  // several loops under one confidence, so re-deriving from its unioned sourceLoops would
  // mis-attribute (and thrash idempotency); its successDelta was measured correctly at its
  // merge and is preserved. `undefined` ⇒ the field is omitted from the patch (kept as-is).
  // (This narrower recurrence proxy is the documented reuse-attribution boundary — the
  // stronger DREAM-2 injection→outcome edge is not persisted yet; see the observer header.)
  const successDelta: number | null | undefined =
    groupMembers.length > 1 ? reuseSuccessDelta(groupMembers) : undefined;

  const provenance: ExperienceProvenance = {
    createdAt: survivor.provenance?.createdAt ?? nowIso,
    dreamRunId: survivor.provenance?.dreamRunId ?? opts.dreamRunId,
    sourceLoops,
  };

  const consolidation: ExperienceConsolidation = {
    lastConsolidatedAt: nowIso,
    dreamRunId: opts.dreamRunId,
    mergedLoopCount: sourceLoops.length,
    conflict: conflict ?? null,
    decayedFrom,
  };

  const patch: ExperienceItemPatch = {
    evidence,
    relatedComponents,
    verification,
    confidence,
    provenance,
    freshness: { ...survivor.freshness, lastConfirmedAt },
    consolidation,
  };
  if (successDelta !== undefined) patch.successDelta = successDelta;

  return {
    patch,
    mergedFrom: members.length - 1,
    decayed: decayedFrom != null,
  };
}

/** Would applying `patch` actually CHANGE `item`? If not, we emit no update (anti-thrash). */
function patchChangesItem(item: ExperienceItemRow, patch: ExperienceItemPatch): boolean {
  if (patch.confidence !== undefined && patch.confidence !== item.confidence) return true;
  if (patch.successDelta !== undefined && roundDeltaEq(patch.successDelta, item.successDelta) === false) return true;
  if (patch.evidence !== undefined && patch.evidence.length !== (item.evidence?.length ?? 0)) return true;
  if (
    patch.relatedComponents !== undefined &&
    patch.relatedComponents.length !== (item.relatedComponents?.length ?? 0)
  ) {
    return true;
  }
  if (
    patch.freshness !== undefined &&
    patch.freshness.lastConfirmedAt !== item.freshness?.lastConfirmedAt
  ) {
    return true;
  }
  if (patch.provenance !== undefined) {
    const before = item.provenance?.sourceLoops?.length ?? 0;
    if (patch.provenance.sourceLoops.length !== before) return true;
  }
  // Conflict flag newly set / changed (a first-time contradiction stamp is a real change).
  const beforeConflict = item.consolidation?.conflict ?? null;
  const afterConflict = patch.consolidation?.conflict ?? null;
  if ((beforeConflict?.withItemId ?? null) !== (afterConflict?.withItemId ?? null)) return true;
  // NOTE: a first-ever consolidation stamp is deliberately NOT a change by itself — a
  // singleton with no merge/decay/conflict/successDelta work is left untouched (no mass
  // rewrite on first enable; the pass only writes items it actually consolidated).
  return false;
}

/** Delta equality at the stored precision (both null ⇒ equal). */
function roundDeltaEq(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return roundDelta(a) === roundDelta(b);
}

/**
 * Consolidate a bounded batch of Experience items into a plan of updates + deletes.
 * PURE — the input array is never mutated. Deterministic + idempotent.
 */
export function consolidate(
  items: readonly ExperienceItemRow[],
  opts: ConsolidateOptions,
): ConsolidationPlan {
  const now = (opts.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const cap = Math.max(0, Math.floor(opts.maxItems ?? MAX_ITEMS));
  const scanned = Math.min(items.length, cap);
  const batch = items.slice(0, cap);

  const groups = new Map<string, ExperienceItemRow[]>();
  for (const it of batch) {
    if (!it || !it.scope || typeof it.scope.repo !== "string") continue;
    const key = groupKey(it);
    const g = groups.get(key);
    if (g) g.push(it);
    else groups.set(key, [it]);
  }

  const plan: ConsolidationPlan = {
    updates: [],
    deletes: [],
    stats: { scanned, groups: groups.size, merged: 0, deleted: 0, decayed: 0, conflicts: 0, successDeltaSet: 0 },
  };

  const pushUpdate = (item: ExperienceItemRow, built: BuiltSurvivor): void => {
    if (!patchChangesItem(item, built.patch)) {
      // Idempotent no-op: only a first-time conflict stamp forces an update below.
      return;
    }
    plan.updates.push({ id: item.id, patch: built.patch });
    if (built.mergedFrom > 0) plan.stats.merged += 1;
    if (built.decayed) plan.stats.decayed += 1;
    if (built.patch.successDelta != null) plan.stats.successDeltaSet += 1;
  };

  for (const members of groups.values()) {
    const hasVerified = members.some((m) => m.confidence === "verified");
    const hasRefuted = members.some((m) => m.confidence === "refuted");

    if (hasVerified && hasRefuted) {
      // ── CONTRADICTION (§6): keep BOTH sides, cross-flag, fresher-verified leads. ──
      // Positive partition = verified ∪ observed (observed is weak-positive, not a
      // contradiction); negative partition = refuted. Each collapses to one survivor.
      const positive = members.filter((m) => m.confidence !== "refuted");
      const negative = members.filter((m) => m.confidence === "refuted");
      const posSurvivor = pickSurvivor(positive, nowMs);
      const negSurvivor = pickSurvivor(negative, nowMs);
      plan.stats.conflicts += 1;

      const posConflict: ExperienceConsolidation["conflict"] = {
        withItemId: negSurvivor.id,
        opposingConfidence: "refuted",
        note: clampNote("Contradiction: this pattern was REFUTED elsewhere on the same scope — verify before trusting."),
      };
      const negConflict: ExperienceConsolidation["conflict"] = {
        withItemId: posSurvivor.id,
        opposingConfidence: "verified",
        note: clampNote("Contradiction: this pattern was VERIFIED elsewhere on the same scope — the fresher-verified one leads."),
      };

      const posBuilt = buildSurvivor(posSurvivor, positive, members, opts, nowMs, nowIso, posConflict);
      const negBuilt = buildSurvivor(negSurvivor, negative, members, opts, nowMs, nowIso, negConflict);

      // BOTH survivors kept + cross-flagged. pushUpdate emits on the FIRST pass (the
      // conflict cross-link is new) and then holds steady (stable contradiction ⇒ no
      // re-write), so the conflict flag is durable + the pass stays idempotent.
      pushUpdate(posSurvivor, posBuilt);
      pushUpdate(negSurvivor, negBuilt);

      // Delete only the NON-survivor duplicates within each partition (both survivors kept).
      for (const m of positive) if (m.id !== posSurvivor.id) plan.deletes.push(m.id);
      for (const m of negative) if (m.id !== negSurvivor.id) plan.deletes.push(m.id);
      continue;
    }

    // ── NO CONTRADICTION: collapse the whole group into ONE survivor. ──
    const survivor = pickSurvivor(members, nowMs);
    const built = buildSurvivor(survivor, members, members, opts, nowMs, nowIso, null);
    pushUpdate(survivor, built);
    for (const m of members) if (m.id !== survivor.id) plan.deletes.push(m.id);
  }

  plan.stats.deleted = plan.deletes.length;
  return plan;
}

/** Clamp + neutralise the inert conflict note. */
function clampNote(s: string): string {
  const cleaned = s.replace(/\s+/g, " ").trim();
  return cleaned.length > MAX_NOTE ? cleaned.slice(0, MAX_NOTE) : cleaned;
}
