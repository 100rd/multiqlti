/**
 * loop-status.ts — a PLAIN-ENGLISH explanation for every consilium-loop state.
 *
 * #466 gave a CANCELLED loop an amber callout that rendered its `error` (the
 * "who / when / why" of the cancellation). But every OTHER state on the loop
 * detail page showed no words at all — an operator who hit `stopped_cap` had no
 * idea what it meant or why the loop was sitting there. This helper generalizes
 * that idea: for ANY state it returns a `{ title, tone, detail }` that says what
 * the state means AND, where relevant, WHY — grounded in the loop's OWN numbers
 * (round / maxRounds / the open remainder / open P0), never hardcoded.
 *
 * Pure and client-safe (no drizzle, no React): the loop detail page, the loop
 * list, and unit tests all share ONE implementation. Type-only imports keep the
 * server schema (and its drizzle runtime) out of the client bundle.
 *
 * SECURITY: `error` is loop/user-authored INERT text — passed straight through
 * as data for the caller to render as inert React text (never a sink). Every
 * other string here is a fixed, code-authored template; only COUNTS (never model
 * prose) are interpolated from `openRemainder` / `openP0`.
 */
import type { ConsiliumLoopState } from "./schema.js";
import { P0_PRIORITY, type OpenRemainder } from "./types.js";

/** Visual/semantic tone for the status callout. */
export type LoopStatusTone = "neutral" | "good" | "warning" | "bad";

/** A plain-English explanation of one loop state. */
export interface LoopStatusExplanation {
  /** Short human title (e.g. "Stopped at the round limit"). */
  title: string;
  /** Semantic tone → colour: good=green, warning=amber, bad=red, neutral=muted. */
  tone: LoopStatusTone;
  /** One or two sentences: what the state means and, where relevant, WHY. */
  detail: string;
}

/**
 * The minimal loop shape `explainLoopState` reads. Both the detail row and the
 * list item are structurally assignable to it, so callers pass their loop as-is.
 */
export interface LoopStatusInput {
  state: ConsiliumLoopState;
  round: number;
  maxRounds: number;
  openP0?: number | null;
  openRemainder?: OpenRemainder | null;
  /** INERT loop/user-authored text (cancellation note or last-round error). */
  error?: string | null;
  prRef?: string | null;
  /**
   * Optional live dev progress (the `developing` state): the active action-point
   * index/total. Structurally compatible with the client `DevProgress`.
   */
  devProgress?: {
    actionPointIndex?: number | null;
    actionPointTotal?: number | null;
  } | null;
}

/** The round to SHOW: a not-yet-ticked loop reports round 0 → read it as round 1. */
function displayRound(round: number): number {
  return round > 0 ? round : 1;
}

/**
 * A full, P0-FIRST breakdown of an open remainder — e.g. `"3 items open (1 P0,
 * 2 P1)"`. Ordered P0 → P1 → … → P? so the highest-severity tier leads. Returns
 * `null` when there is nothing to summarize (so callers can fall back to the raw
 * `openP0` count or omit the clause entirely).
 */
function summarizeAllOpen(
  remainder: OpenRemainder | null | undefined,
): { total: number; breakdown: string } | null {
  if (!remainder || remainder.total <= 0) return null;
  // P0 sorts FIRST (0), then P1, P2, …; an un-numbered "P?" sorts LAST.
  const tier = (label: string): number => {
    const n = Number.parseInt(label.replace(/^P/i, ""), 10);
    return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
  };
  const entries = Object.entries(remainder.byPriority)
    .filter(([, count]) => count > 0)
    .sort((a, b) => tier(a[0]) - tier(b[0]) || a[0].localeCompare(b[0]));
  if (entries.length === 0) return null;
  return {
    total: remainder.total,
    breakdown: entries.map(([priority, count]) => `${count} ${priority}`).join(", "),
  };
}

/** The NON-P0 tier of a remainder (for the "converged, but…" note). */
function summarizeNonP0(
  remainder: OpenRemainder | null | undefined,
): { total: number; breakdown: string } | null {
  if (!remainder) return null;
  const tier = (label: string): number => {
    const n = Number.parseInt(label.replace(/^P/i, ""), 10);
    return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
  };
  const entries = Object.entries(remainder.byPriority)
    .filter(([priority, count]) => priority !== P0_PRIORITY && count > 0)
    .sort((a, b) => tier(a[0]) - tier(b[0]) || a[0].localeCompare(b[0]));
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total <= 0) return null;
  return { total, breakdown: entries.map(([p, c]) => `${c} ${p}`).join(", ") };
}

/**
 * Build the "N items remain open (…)" clause for a capped/escalated loop,
 * grounded in the loop's real numbers: prefer the full priority breakdown, fall
 * back to the raw open-P0 count, and finally to a neutral phrasing.
 */
function openWorkClause(loop: LoopStatusInput): string {
  const all = summarizeAllOpen(loop.openRemainder);
  if (all) {
    const one = all.total === 1;
    return `${all.total} item${one ? "" : "s"} remain${one ? "s" : ""} open (${all.breakdown})`;
  }
  const p0 = loop.openP0;
  if (typeof p0 === "number" && p0 > 0) {
    const one = p0 === 1;
    return `${p0} P0 item${one ? "" : "s"} remain${one ? "s" : ""} open`;
  }
  return "some items may still be open";
}

/**
 * The GENERIC failure text the controller stamps on `loop.error` when a review
 * run dies with no more specific message (`REVIEW_RUN_FAILED` in
 * consilium-loop-controller.ts). Detected here so `failed` can hand the
 * operator an ACTIONABLE explanation of what that opaque three words actually
 * means, instead of just echoing them back verbatim.
 */
const GENERIC_REVIEW_RUN_FAILED = "review run failed";

/** Appended to every `failed` explanation — the loop has no in-place resume. */
const RERUN_SUGGESTION = "Re-run to start a fresh loop with the same settings.";

/** Humanize a raw state token as a last-resort title (never render blank). */
function humanizeState(state: string): string {
  return state
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Explain ONE loop state in plain English. Total function over
 * `ConsiliumLoopState` — every state returns a non-empty title + detail, and an
 * unknown/future token falls through to a safe neutral default so the callout
 * NEVER renders blank (the whole point of this helper).
 */
export function explainLoopState(loop: LoopStatusInput): LoopStatusExplanation {
  const round = displayRound(loop.round);
  const { maxRounds } = loop;

  switch (loop.state) {
    case "pending":
      return {
        title: "Pending",
        tone: "neutral",
        detail:
          "This loop hasn't started yet — start it to run the first review round.",
      };

    case "building_context":
      return {
        title: "Building context",
        tone: "neutral",
        detail: `Gathering the repository context for round ${round} of up to ${maxRounds} before the reviewers debate.`,
      };

    case "reviewing":
      return {
        title: "Reviewing",
        tone: "neutral",
        detail: `The reviewers are debating the changes in round ${round} of up to ${maxRounds}.`,
      };

    case "deciding":
      return {
        title: "Deciding",
        tone: "neutral",
        detail: `Tallying the round ${round} verdict — deciding whether every acceptance criterion is met.`,
      };

    case "developing": {
      const idx = loop.devProgress?.actionPointIndex;
      const total = loop.devProgress?.actionPointTotal;
      const progress =
        typeof idx === "number" && typeof total === "number" && total > 0
          ? ` (AP ${idx}/${total})`
          : "";
      return {
        title: "Developing",
        tone: "neutral",
        detail: `Implementing the action points raised by the last review round${progress}.`,
      };
    }

    case "awaiting_merge":
      return {
        title: "Awaiting merge",
        tone: "neutral",
        detail: loop.prRef
          ? "A Draft PR is open and waiting for a human to review and merge it. Merge it (or approve to continue) to advance the loop."
          : "The developing round finished but produced no PR — approve to advance the loop against the current HEAD, or cancel it.",
      };

    case "converged": {
      const nonP0 = summarizeNonP0(loop.openRemainder);
      const base =
        "Converged — every acceptance criterion was confirmed, so the loop is done.";
      return {
        title: "Converged",
        tone: "good",
        detail: nonP0
          ? `${base} ${nonP0.total} lower-priority item${nonP0.total === 1 ? "" : "s"} (${nonP0.breakdown}) remain${nonP0.total === 1 ? "s" : ""} open by design — hand them off if you want them addressed.`
          : base,
      };
    }

    case "stopped_cap": {
      // Context-aware (mirrors loopStateLabel): a single-round loop is an
      // ASSESSMENT, not a remediation — reaching the cap is success, not a stall.
      if (maxRounds === 1) {
        return {
          title: "Completed — review",
          tone: "good",
          detail:
            "The single review round finished. This was an assessment (max rounds = 1), not a remediation loop, so it stops here.",
        };
      }
      return {
        title: "Stopped at the round limit",
        tone: "warning",
        detail: `Reached the round limit (max ${maxRounds}) without converging; ${openWorkClause(loop)}. Raise the round limit or develop the remainder to continue.`,
      };
    }

    case "escalated": {
      const p0 = loop.openP0;
      const p0Clause =
        typeof p0 === "number" && p0 > 0
          ? ` There ${p0 === 1 ? "is" : "are"} still ${p0} P0 item${p0 === 1 ? "" : "s"} open.`
          : "";
      return {
        title: "Escalated",
        tone: "warning",
        detail: `Escalated — the open-P0 count stopped improving across rounds, so the loop paused for a human to look.${p0Clause}`,
      };
    }

    case "failed": {
      // A `failed` loop has no in-place resume (unlike `throttled`, which
      // retries, or the verdict terminals, which develop) — a re-run cloning
      // the SAME config into a fresh loop is the only way forward, so every
      // branch below ends with that suggestion.
      if (!loop.error) {
        return {
          title: "Failed",
          tone: "bad",
          detail: `The last round failed with an unrecoverable error. See the round details below. ${RERUN_SUGGESTION}`,
        };
      }
      if (loop.error === GENERIC_REVIEW_RUN_FAILED) {
        // The generic controller-authored message names no specific cause —
        // explain what it actually covers instead of echoing three opaque words.
        return {
          title: "Failed",
          tone: "bad",
          detail: `The review run failed — a reviewer model errored or the run was interrupted (e.g. a restart mid-review). ${RERUN_SUGGESTION}`,
        };
      }
      // A specific error (#466-style): surface it verbatim, then the suggestion.
      return {
        title: "Failed",
        tone: "bad",
        detail: `${loop.error} — re-run to start a fresh loop.`,
      };
    }

    case "cancelled":
      return {
        title: "Cancelled",
        // Neutral, not red: a cancellation is an operator choice, NOT a failure
        // (mirrors #466's amber, "not a failure" treatment).
        tone: "neutral",
        // Reuse #466: the composed "Cancelled by <actor> at <ISO> — <reason>".
        detail: loop.error
          ? loop.error
          : "This loop was cancelled by an operator. No reason was recorded.",
      };

    case "stopped":
      return {
        title: "Finished",
        // A graceful operator finish ("satisfied / didn't want to continue"):
        // NOT an abort and NOT a failure — the loop kept whatever it produced.
        tone: "good",
        // The composed "Finished by <actor> at <ISO> — <reason>".
        detail: loop.error
          ? loop.error
          : "An operator finished this loop and kept what it produced.",
      };

    case "throttled":
      // Agent usage/rate limit hit during review/develop → NON-terminal RESTING
      // pause (not a failure). The operator retries when their quota resets.
      return {
        title: "Throttled",
        tone: "warning",
        detail: loop.error
          ? loop.error
          : "An agent usage/rate limit was reached — the loop is paused. Retry when your quota resets.",
      };

    default: {
      // Exhaustive over the current union; a future/unknown token still gets a
      // safe, non-blank explanation so the callout NEVER renders empty.
      const state: string = loop.state;
      return {
        title: humanizeState(state),
        tone: "neutral",
        detail: `The loop is in the "${state}" state.`,
      };
    }
  }
}
