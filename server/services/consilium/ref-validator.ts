/**
 * ref-validator.ts — strict branch/revision name validation for BRANCH-targeted
 * consilium reviews.
 *
 * A review may optionally target an arbitrary git ref (a branch name like
 * `feature/x`, a tag, or any revision). That ref flows to git ONLY as an
 * arg-array element (never a shell string, never a branch/PR title) and is
 * always pinned behind `--end-of-options` at the git call sites, but it is still
 * attacker-influenced caller input, so it is gated by a STRICT allowlist HERE,
 * at the factory boundary, BEFORE it ever reaches git. Defense in depth: even if
 * a malformed ref slipped past, `--end-of-options` would stop it being parsed as
 * a flag — but we reject it up front and never persist it.
 *
 * SECURITY (flagged for the adversarial reviewer):
 *   - Allowed chars ONLY: letters, digits, `_`, `-`, `/`, `.`. Everything else
 *     (whitespace, `;`, `|`, `&`, `$`, backticks, `(`, `)`, `<`, `>`, `'`, `"`,
 *     `\`, `@`, `{`, `}`, `:`, `~`, `^`, …) is rejected — so shell metachars,
 *     git range/peel syntax (`:`/`~`/`^`/`@{`), and option-injection payloads
 *     can never appear in a ref.
 *   - Leading `-` is rejected (flag/option injection, e.g. `-x` / `--upload-pack`).
 *   - Leading `/` is rejected (absolute-path-shaped refs, e.g. `/etc/passwd`) — git
 *     never names a ref with a leading slash; this just denies the misleading shape.
 *   - `..` is rejected (git range syntax + path traversal).
 *   - `@{` is rejected (reflog/upstream peel) — already covered because neither
 *     `@` nor `{` is in the allowed set; the lookahead documents the intent.
 *   - At least one alphanumeric is REQUIRED, so an all-dots/all-slashes ref
 *     (`.`, `/`, `./.`) — which would resolve to nothing useful and only widens
 *     the surface — is rejected.
 *   - Length capped at 255; empty rejected (the `{1,255}` quantifier enforces both).
 */

/**
 * The single canonical ref pattern, shared by the factory validator AND the HTTP
 * endpoint's zod schema so they can NEVER drift:
 *   `^(?!-)`            — must not start with `-` (flag injection)
 *   `(?!/)`             — must not start with `/` (absolute-path-shaped ref)
 *   `(?!.*\.\.)`        — must not contain `..` (range syntax / traversal)
 *   `(?!.*@\{)`         — must not contain `@{` (redundant w/ charset; explicit)
 *   `(?=.*[A-Za-z0-9])` — must contain ≥1 alphanumeric (reject all-dots/slashes)
 *   `[A-Za-z0-9._/-]{1,255}$` — allowed chars only, 1..255 long (non-empty, capped)
 */
export const REVIEW_REF_RE =
  /^(?!-)(?!\/)(?!.*\.\.)(?!.*@\{)(?=.*[A-Za-z0-9])[A-Za-z0-9._/-]{1,255}$/;

/** Stable, user-facing rejection message (mirrored by the endpoint's 400). */
export const INVALID_REF_MESSAGE = "ref is not a valid branch/revision name";

/**
 * Validate a caller-supplied branch/revision name. Returns the ref UNCHANGED on
 * success (it is already in canonical, git-safe form); THROWS on any violation.
 * The factory calls this at its boundary so an invalid ref becomes a 400 at the
 * endpoint and is NEVER persisted as a loop's `reviewRef`.
 */
export function validateReviewRef(ref: unknown): string {
  if (typeof ref !== "string" || !REVIEW_REF_RE.test(ref)) {
    throw new Error(INVALID_REF_MESSAGE);
  }
  return ref;
}
