/**
 * News-service core for the Morning News Board.
 *
 * Pure, side-effect-free pieces (content hash, dedup helper, feedback state
 * machine) live here so they can be unit-tested without storage or network,
 * mirroring `knowledge/practice-card-service.ts`.
 *
 * Security note: the content hash is ALWAYS computed server-side from the item's
 * semantic fields (title + summary + sourceUri) — a client-supplied hash is
 * never trusted (server-computed dedup key).
 */
import { createHash } from "node:crypto";
import type { NewsFeedback, NewsReadState } from "@shared/schema";

// ─── Content hash (canonical, length-prefixed) ───────────────────────────────

export interface ContentHashInput {
  title: string;
  summary: string;
  /** Optional; absent and "" hash identically. */
  sourceUri?: string;
}

/**
 * sha256 over a canonical, length-prefixed serialization of the semantic fields.
 * Length-prefixing prevents field-boundary collisions (e.g. "ab"+"c" vs "a"+"bc").
 * Server-computed; the client's hash is ignored.
 */
export function computeContentHash(input: ContentHashInput): string {
  const fields = [input.title, input.summary, input.sourceUri ?? ""];
  const canonical = fields.map((f) => `${f.length}:${f}`).join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ─── Dedup helper ─────────────────────────────────────────────────────────────

/** True iff `hash` has already been seen in `seen`. Pure read; does not mutate. */
export function isDuplicate(hash: string, seen: ReadonlySet<string>): boolean {
  return seen.has(hash);
}

// ─── Feedback state machine (pure, immutable) ────────────────────────────────

export type FeedbackAction = "read" | "up" | "down" | "hidden";

export interface FeedbackState {
  readState: NewsReadState;
  feedback: NewsFeedback;
}

/**
 * Apply a feedback action, returning a NEW state (never mutates the input).
 *   - read   → readState='read' (feedback unchanged)
 *   - up     → feedback='up' (clears a prior down/hidden)
 *   - down   → feedback='down'
 *   - hidden → feedback='hidden' (suppresses the item)
 */
export function applyFeedback(
  current: Readonly<FeedbackState>,
  action: FeedbackAction,
): FeedbackState {
  if (action === "read") {
    return { ...current, readState: "read" };
  }
  return { ...current, feedback: action };
}
