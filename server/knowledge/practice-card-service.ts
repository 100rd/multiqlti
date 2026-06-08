/**
 * Practice-card service core for the Active Knowledge Base.
 *
 * Pure, side-effect-free pieces (content hash, review-state machine, supersession)
 * are exported separately so they can be unit-tested without storage or network.
 * Projection helpers take injected embed/insert/delete functions so the route
 * layer wires the real VectorStore + EmbeddingProvider, and tests inject mocks.
 *
 * Security note: the content hash is ALWAYS computed server-side from the card's
 * semantic fields — a client-supplied hash is never trusted.
 */
import { createHash } from "node:crypto";
import type {
  PracticeCardRow,
  PracticeCardReviewState,
  PracticeCardAppliesTo,
} from "@shared/schema";

// ─── Typed error ─────────────────────────────────────────────────────────────

/** Thrown when an illegal review-state transition or self-supersession occurs. */
export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

// ─── Content hash (canonical, stable key order) ──────────────────────────────

export interface ContentHashInput {
  statement: string;
  rationale: string;
  appliesTo: PracticeCardAppliesTo;
}

/** Recursively sort object keys so logically equal objects serialize identically. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = canonicalize(obj[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * sha256 over canonicalized(statement + rationale + appliesTo) with stable key
 * order. Server-computed; the client's hash is ignored.
 */
export function computeContentHash(input: ContentHashInput): string {
  const canonical = JSON.stringify({
    statement: input.statement,
    rationale: input.rationale,
    appliesTo: canonicalize(input.appliesTo),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ─── Review-state machine (pure) ─────────────────────────────────────────────

export type VerifyVerdict = "pass" | "fail" | "needs_changes";
export type ReviewDecision = "accept" | "reject";

export type TransitionAction =
  | { kind: "verify"; verdict: VerifyVerdict }
  | { kind: "review"; decision: ReviewDecision };

export interface TransitionResult {
  reviewState: PracticeCardReviewState;
  /** Only true for an accept — the single path that sets status='active'. */
  setActive: boolean;
}

/**
 * Compute the next review state for an action, throwing on any illegal move.
 * Legal: pending_verification -> (verify) -> pending_review | rejected
 *        pending_review       -> (review) -> accepted (active) | rejected
 */
export function transitionReviewState(
  current: PracticeCardReviewState,
  action: TransitionAction,
): TransitionResult {
  if (action.kind === "verify") {
    if (current !== "pending_verification") {
      throw new InvalidTransitionError(`Cannot verify a card in state '${current}'`);
    }
    if (action.verdict === "pass") {
      return { reviewState: "pending_review", setActive: false };
    }
    return { reviewState: "rejected", setActive: false };
  }

  // review
  if (current !== "pending_review") {
    throw new InvalidTransitionError(`Cannot review a card in state '${current}'`);
  }
  if (action.decision === "accept") {
    return { reviewState: "accepted", setActive: true };
  }
  return { reviewState: "rejected", setActive: false };
}

// ─── Supersession (pure) ─────────────────────────────────────────────────────

export interface SupersededUpdate {
  id: string;
  status: "superseded";
  supersededBy: string[];
}

export interface SupersessionPlan {
  acceptedSupersedes: string[];
  supersededUpdates: SupersededUpdate[];
}

/**
 * Build the reciprocal supersession plan for an accepted card. The accepted card
 * records `supersedes`; each superseded card is marked status='superseded' with a
 * `supersededBy` back-reference. Self-supersession is rejected.
 */
export function applySupersession(acceptedCardId: string, supersedes: string[]): SupersessionPlan {
  const unique = Array.from(new Set(supersedes));
  if (unique.includes(acceptedCardId)) {
    throw new InvalidTransitionError("A card cannot supersede itself");
  }
  return {
    acceptedSupersedes: unique,
    supersededUpdates: unique.map((id) => ({
      id,
      status: "superseded" as const,
      supersededBy: [acceptedCardId],
    })),
  };
}

// ─── Projection into memory_chunks ───────────────────────────────────────────

export interface ProjectDeps {
  embed: (text: string) => Promise<number[]>;
  insertChunks: (rows: Array<Record<string, unknown>>) => Promise<unknown[]>;
  dimensions: number;
  model: string;
  provider: string;
}

/** The searchable text projection for a card. */
export function cardProjectionText(card: Pick<PracticeCardRow, "statement" | "rationale">): string {
  return `${card.statement}\n\n${card.rationale}`;
}

/**
 * Project a card into a single practice_card memory chunk (embed + insert).
 * The chunk is a derived index; the card row stays authoritative.
 */
export async function projectToChunk(card: PracticeCardRow, deps: ProjectDeps): Promise<void> {
  const text = cardProjectionText(card);
  const embedding = await deps.embed(text);
  await deps.insertChunks([
    {
      workspaceId: card.workspaceId,
      sourceType: "practice_card",
      sourceId: card.id,
      chunkText: text,
      embedding,
      metadata: {
        topic: card.topic,
        confidence: card.confidence,
        reviewState: card.reviewState,
        dim: deps.dimensions,
        model: deps.model,
        provider: deps.provider,
      },
    },
  ]);
}

export interface DropProjectionDeps {
  deleteBySource: (workspaceId: string, sourceType: "practice_card", sourceId: string) => Promise<number>;
}

/** Remove a card's search projection (used on reject). */
export async function dropProjection(
  card: Pick<PracticeCardRow, "workspaceId" | "id">,
  deps: DropProjectionDeps,
): Promise<number> {
  return deps.deleteBySource(card.workspaceId, "practice_card", card.id);
}
