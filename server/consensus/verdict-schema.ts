/**
 * /consensus verdict schemas — the trust boundary between an LLM's free text and
 * the engine's STRUCTURAL state.
 *
 * Fail direction is asymmetric and deliberate:
 *   - VOTER + BLIND + ADJUDICATION verdicts fail CLOSED. An unparseable / throwing
 *     / wrong-shape output is recorded as REQUEST_CHANGES with a bounded enum
 *     parseError — NEVER APPROVE (L-2). A poisoned or malformed model output can
 *     therefore never manufacture an approval.
 *   - the stability marker (debate) fails OPEN — but that lives in
 *     stability-judge.ts, not here.
 *
 * Adjudication dismissals (MF-3): closing an OPEN critical issue as "dismissed"
 * REQUIRES a non-empty, trimmed `dismissal_justification`. The zod `.refine`
 * rejects a blank/whitespace justification at the parse boundary; the ledger
 * (critical-issue-ledger.ts) independently fails CLOSED on a missing/blank
 * justification (defense-in-depth — the issue stays OPEN).
 */
import { z } from "zod";
import type { ConsensusVerdict } from "@shared/types";

/** Bounded text lengths so a verdict can never blow up storage / a prompt. */
const MAX_RATIONALE_LEN = 4_000;
const MAX_ISSUE_KEY_LEN = 200;
const MAX_ISSUE_SUMMARY_LEN = 1_000;
const MAX_JUSTIFICATION_LEN = 2_000;
const MAX_ISSUES = 50;

/** The three possible decision verdicts. */
export const VERDICT_VALUES = ["APPROVE", "REQUEST_CHANGES", "REJECT"] as const;

const VerdictEnum = z.enum(VERDICT_VALUES);

/** A single critical issue a voter raises against the decision/plan. */
export const CriticalIssueSchema = z
  .object({
    key: z.string().min(1).max(MAX_ISSUE_KEY_LEN),
    summary: z.string().min(1).max(MAX_ISSUE_SUMMARY_LEN),
  })
  .strict();

export type CriticalIssueInput = z.infer<typeof CriticalIssueSchema>;

/** A voter's review: a verdict + the critical issues it raises. `.strict()`. */
export const VoterReviewSchema = z
  .object({
    verdict: VerdictEnum,
    critical_issues: z.array(CriticalIssueSchema).max(MAX_ISSUES).default([]),
  })
  .strict();

export type VoterReview = z.infer<typeof VoterReviewSchema>;

/** The blind / adjudication verdict shape (verdict + bounded rationale). */
export const VerdictSchema = z
  .object({
    verdict: VerdictEnum,
    rationale: z.string().max(MAX_RATIONALE_LEN).optional(),
  })
  .strict();

export type VerdictInput = z.infer<typeof VerdictSchema>;

/** A single dismissal in an adjudication record — MF-3: non-empty justification. */
export const DismissalSchema = z
  .object({
    issue_key: z.string().min(1).max(MAX_ISSUE_KEY_LEN),
    dismissal_justification: z
      .string()
      .max(MAX_JUSTIFICATION_LEN)
      // MF-3: a dismissal MUST carry a non-empty, trimmed written justification.
      .refine((v) => v.trim().length > 0, {
        message: "dismissal_justification must be non-empty",
      }),
  })
  .strict();

export type DismissalInput = z.infer<typeof DismissalSchema>;

/** Claude's adjudication record: its verdict + which issues it fixed / dismissed. */
export const AdjudicationSchema = z
  .object({
    verdict: VerdictEnum,
    rationale: z.string().max(MAX_RATIONALE_LEN).optional(),
    /** Issue keys resolved by a plan edit. */
    fixed: z.array(z.string().min(1).max(MAX_ISSUE_KEY_LEN)).max(MAX_ISSUES).default([]),
    /** Dismissals — each requires a non-empty justification (MF-3). */
    dismissals: z.array(DismissalSchema).max(MAX_ISSUES).default([]),
    /** Optional revised plan text (bounded). */
    revised_plan: z.string().max(MAX_RATIONALE_LEN).optional(),
  })
  .strict();

export type AdjudicationInput = z.infer<typeof AdjudicationSchema>;

/** Bounded, enum-only parse-failure reason (never echo raw model text — H-1 parity). */
export type VerdictParseError = "no-json" | "bad-shape" | "empty";

/** A parsed voter review, or a fail-CLOSED non-approving fallback. */
export type ParsedVoterReview =
  | { ok: true; review: VoterReview }
  | { ok: false; verdict: "REQUEST_CHANGES"; parseError: VerdictParseError };

/** A parsed verdict (blind/adjudication), or a fail-CLOSED non-approving fallback. */
export type ParsedVerdict =
  | { ok: true; verdict: ConsensusVerdict; rationale?: string }
  | { ok: false; verdict: "REQUEST_CHANGES"; parseError: VerdictParseError };

/** A parsed adjudication, or a fail-CLOSED non-approving fallback. */
export type ParsedAdjudication =
  | { ok: true; adjudication: AdjudicationInput }
  | { ok: false; verdict: "REQUEST_CHANGES"; parseError: VerdictParseError };

/**
 * Locate the first balanced JSON object in free text (fence/prose tolerant).
 * String-literal aware. Returns the object substring or null.
 */
function extractJsonObject(text: string): string | null {
  const open = text.indexOf("{");
  if (open === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

function parseJsonObject(text: string): { ok: true; value: unknown } | { ok: false } {
  const json = extractJsonObject(text);
  if (json === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(json) };
  } catch {
    return { ok: false };
  }
}

/**
 * Parse a voter review from free text. Fail-CLOSED: any miss → REQUEST_CHANGES +
 * a bounded enum parseError. NEVER returns APPROVE on a parse failure (L-2).
 */
export function parseVoterReview(text: string): ParsedVoterReview {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, verdict: "REQUEST_CHANGES", parseError: "empty" };
  }
  const obj = parseJsonObject(text);
  if (!obj.ok) return { ok: false, verdict: "REQUEST_CHANGES", parseError: "no-json" };
  const parsed = VoterReviewSchema.safeParse(obj.value);
  if (!parsed.success) return { ok: false, verdict: "REQUEST_CHANGES", parseError: "bad-shape" };
  return { ok: true, review: parsed.data };
}

/**
 * Parse a blind / adjudication verdict from free text. Fail-CLOSED identically:
 * any miss → REQUEST_CHANGES, never APPROVE.
 */
export function parseVerdict(text: string): ParsedVerdict {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, verdict: "REQUEST_CHANGES", parseError: "empty" };
  }
  const obj = parseJsonObject(text);
  if (!obj.ok) return { ok: false, verdict: "REQUEST_CHANGES", parseError: "no-json" };
  const parsed = VerdictSchema.safeParse(obj.value);
  if (!parsed.success) return { ok: false, verdict: "REQUEST_CHANGES", parseError: "bad-shape" };
  return parsed.data.rationale !== undefined
    ? { ok: true, verdict: parsed.data.verdict, rationale: parsed.data.rationale }
    : { ok: true, verdict: parsed.data.verdict };
}

/**
 * Parse an adjudication record. Fail-CLOSED: a missing/blank dismissal
 * justification fails the zod `.refine` → bad-shape → REQUEST_CHANGES (MF-3), so
 * a justification-less dismissal can never be accepted at the parse boundary.
 */
export function parseAdjudication(text: string): ParsedAdjudication {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, verdict: "REQUEST_CHANGES", parseError: "empty" };
  }
  const obj = parseJsonObject(text);
  if (!obj.ok) return { ok: false, verdict: "REQUEST_CHANGES", parseError: "no-json" };
  const parsed = AdjudicationSchema.safeParse(obj.value);
  if (!parsed.success) return { ok: false, verdict: "REQUEST_CHANGES", parseError: "bad-shape" };
  return { ok: true, adjudication: parsed.data };
}
