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
 * JSON extraction is fence/prose TOLERANT (mirrors orchestrator/plan-schema.ts
 * `extractJsonPayload`): real gemini/agy wraps the JSON object in ```json fences
 * and/or narrates a `{ ... }` snippet in prose BEFORE the verdict. We strip an
 * outer code fence first, then slice the outermost `{`..`}`, then fall back to the
 * first balanced object. This is extraction tolerance ONLY — the zod `.strict()`
 * parse + the asymmetric fail-CLOSED direction are unchanged: a genuinely
 * malformed / wrong-shape payload still throws/fails → REQUEST_CHANGES.
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
 * Strip a leading/wrapping markdown code fence (```json ... ``` or ``` ... ```),
 * returning the fenced body trimmed, or the trimmed input when there is no fence.
 * Mirrors the fence step of orchestrator/plan-schema.ts `extractJsonPayload`.
 */
function stripFence(text: string): string {
  const s = text.trim();
  const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  return fence && fence[1] ? fence[1].trim() : s;
}

/**
 * Narrow to the OUTERMOST `{`..`}` of `s`. Mirrors the brace step of
 * `extractJsonPayload` so a body preceded by a narrated `{ ... }` prose snippet
 * still yields the real verdict object. Returns the candidate or null.
 */
function outermostBraceCandidate(s: string): string | null {
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  return s.slice(first, last + 1);
}

/**
 * Locate the FIRST balanced JSON object in free text (string-literal aware).
 * Fallback for when the outermost-brace candidate fails to JSON.parse (e.g. a
 * complete object followed by trailing prose braces). Returns the object
 * substring or null.
 */
function firstBalancedObject(text: string): string | null {
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

/**
 * Parse the first JSON object out of free text. Fence/prose TOLERANT but fail-
 * CLOSED: tries the fence-stripped outermost-brace candidate first, then the
 * first balanced object (post-fence-strip, then raw). A candidate that does not
 * JSON.parse is rejected → { ok: false } (the caller maps that to REQUEST_CHANGES).
 */
function parseJsonObject(text: string): { ok: true; value: unknown } | { ok: false } {
  const body = stripFence(text);
  const candidates = [
    outermostBraceCandidate(body),
    firstBalancedObject(body),
    firstBalancedObject(text),
  ];
  for (const json of candidates) {
    if (json === null) continue;
    try {
      return { ok: true, value: JSON.parse(json) };
    } catch {
      // Try the next, more conservative candidate before giving up (fail-closed).
    }
  }
  return { ok: false };
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
