/**
 * diff-redactor.ts — best-effort secret scrubbing for the consilium diff
 * (design §13 H-4). The diff body WILL be sent to external LLM providers, so we
 * strip the obvious secret shapes BEFORE the text enters the assembled prompt.
 *
 * Best-effort by design — this is a safety net, not a guarantee. It removes:
 *   - PEM private-key blocks (-----BEGIN * PRIVATE KEY----- … -----END … -----)
 *   - AWS_*=<value> assignments (env-style)
 *   - password=<value> / passwd=/pwd= assignments
 *   - long high-entropy bearer/token-looking strings
 *
 * Each match is replaced with a fixed `<REDACTED:kind>` marker so the diff stays
 * readable while the secret value is gone.
 */

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const AWS_ASSIGN = /\bAWS_[A-Z0-9_]*\s*=\s*['"]?[^\s'"]+['"]?/g;
const PASSWORD_ASSIGN = /\b(?:password|passwd|pwd)\s*[=:]\s*['"]?[^\s'"]+['"]?/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._\-]{16,}/g;
/** Long base64/hex-ish run with mixed case+digits → likely a key/token. */
const HIGH_ENTROPY = /\b(?=[A-Za-z0-9_\-]*[A-Z])(?=[A-Za-z0-9_\-]*[a-z])(?=[A-Za-z0-9_\-]*\d)[A-Za-z0-9_\-]{32,}\b/g;

/** Apply all redaction passes; returns the scrubbed text. Pure, never throws. */
export function redactSecrets(text: string): string {
  return text
    .replace(PEM_BLOCK, "<REDACTED:private-key>")
    .replace(AWS_ASSIGN, "<REDACTED:aws-credential>")
    .replace(PASSWORD_ASSIGN, "<REDACTED:password>")
    .replace(BEARER, "<REDACTED:bearer-token>")
    .replace(HIGH_ENTROPY, "<REDACTED:token>");
}
