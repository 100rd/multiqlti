/**
 * rate-limit.ts — CONSERVATIVE classifier for "agent usage/rate limit exhausted"
 * errors surfaced by a model/CLI provider during REVIEW or DEVELOP.
 *
 * ⚠️ CONSERVATIVE BY DESIGN: only a CLEAR limit signature classifies as a rate
 * limit. Anything ambiguous returns false, so the caller keeps the EXISTING
 * degrade/fail path unchanged. A false positive (pausing a loop forever on a
 * non-limit error) is worse than a false negative (one more degrade/fail that
 * an operator can already see and retry manually).
 *
 * Pure, case-insensitive, substring/regex matching over the raw error text
 * (message + stderr). Never throws.
 */

// Word-boundary match for the bare HTTP status — avoids false positives like
// "timeout after 1429ms" or a stray "...1429..." inside an unrelated number.
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[\s_-]?limit/i,
  /\b429\b/,
  /too many requests/i,
  /usage limit/i,
  /resource_exhausted/i,
  /insufficient_quota/i,
  /overloaded_error/i,
  /retry-after/i,
];

/**
 * Returns true iff `text` contains a CLEAR rate-limit/usage-quota signature.
 * Conservative: only the fixed signature list above matches; everything else
 * (timeouts, spawn failures, parse errors, generic 5xx, network errors, …)
 * returns false and keeps the existing degrade/fail path byte-identical.
 */
export function isRateLimitError(text: string): boolean {
  if (!text) return false;
  // "quota" + "exceed/exhaust" in ANY order/wording (e.g. "exceeded quota for
  // requests per day", "quota exhausted") — a clear usage-limit signature that a
  // fixed-distance regex misses when word suffixes sit between the two tokens.
  const lower = text.toLowerCase();
  if (lower.includes("quota") && (lower.includes("exceed") || lower.includes("exhaust"))) {
    return true;
  }
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}
