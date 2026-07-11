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

// Matches a provider's suggested cooldown phrase: "retry after 42s", "retry-after
// 90 seconds", "Retry-After: 120" (colon, HTTP-header style), "try again in 5m".
// Group 1 is the integer; group 2 is an optional unit (s/m/h and their long forms).
const RETRY_AFTER_PATTERN = /(?:retry[\s-]?after|try again in)\s*:?\s*(\d+)\s*([a-z]+)?/i;

/**
 * Best-effort parse of a provider's suggested cooldown (in whole SECONDS) from raw
 * error/header text — "retry after 42s", "try again in 5m", "Retry-After: 120",
 * "retry-after 90 seconds". A bare number with no unit is treated as seconds
 * (matches the raw HTTP `Retry-After` header semantics); `m` → ×60, `h` → ×3600.
 * Returns `null` on no match/parse failure — the caller falls back to the
 * configured cooldown default. Pure, case-insensitive, never throws.
 */
export function parseRetryAfterSeconds(text: string): number | null {
  if (!text) return null;
  try {
    const match = RETRY_AFTER_PATTERN.exec(text);
    if (!match) return null;
    const value = Number.parseInt(match[1], 10);
    if (!Number.isFinite(value)) return null;
    const unit = (match[2] ?? "").toLowerCase();
    if (unit.startsWith("h")) return value * 3600;
    if (unit.startsWith("m")) return value * 60;
    return value; // "s"/"sec(s)"/"second(s)"/no unit → seconds
  } catch {
    return null;
  }
}
