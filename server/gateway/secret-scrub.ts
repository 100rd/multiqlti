/**
 * Secret scrubbing for streamed/partial output, CLI stderr, error messages, WS
 * progress/failure payloads, logs, the tracer, and promoted run output
 * (streaming-stage-execution, Security M2).
 *
 * The spawned CLI child inherits the full {...process.env}, so secret values
 * (OMNISCIENCE_TOKEN, JWT_SECRET, *_API_KEY, ...) can in principle echo back
 * through stdout/stderr. Before any of that text crosses a trust boundary we
 * replace the literal VALUE of each known secret env var with a redaction
 * marker. We deliberately scrub by value (not by guessing token shapes) so we
 * only ever redact things that are genuinely secrets on this host.
 */

/** Existing preview/truncation contract — keep at 256 chars. */
export const MAX_PREVIEW_CHARS = 256;

const REDACTION = "[REDACTED]";

/**
 * Env var names whose values must be scrubbed. We match by exact name
 * (OMNISCIENCE_TOKEN, JWT_SECRET, ENCRYPTION_KEY) and by suffix family
 * (*_API_KEY, *_SECRET, *_TOKEN, *_PASSWORD). Short values (< 6 chars) are
 * skipped to avoid mass false-positive redaction of ordinary prose.
 */
const EXPLICIT_SECRET_NAMES: ReadonlySet<string> = new Set([
  "OMNISCIENCE_TOKEN",
  "JWT_SECRET",
  "ENCRYPTION_KEY",
  "FEDERATION_CLUSTER_SECRET",
  "ANTHROPIC_API_KEY",
]);

const SECRET_NAME_SUFFIXES: readonly string[] = [
  "_API_KEY",
  "_SECRET",
  "_TOKEN",
  "_PASSWORD",
];

const MIN_SECRET_LENGTH = 6;

function isSecretName(name: string): boolean {
  if (EXPLICIT_SECRET_NAMES.has(name)) return true;
  return SECRET_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** Escape a literal string for safe use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Collect the current set of secret VALUES present in process.env. Read fresh
 * each call (cheap; env is small) so tests and runtime env changes are honored.
 */
function collectSecretValues(): string[] {
  const values: string[] = [];
  const env = process.env;
  for (const name of Object.keys(env)) {
    if (!isSecretName(name)) continue;
    const value = env[name];
    if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) {
      values.push(value);
    }
  }
  // Longest first so a secret that is a prefix of another doesn't leave a tail.
  return values.sort((a, b) => b.length - a.length);
}

/**
 * Merge the process.env secret values with a caller-supplied per-run value set,
 * longest-first. `extraValues` (ADR-003 §D dynamic scrubber) carries values that
 * were LEASED into a subprocess env but never sat in this server's process.env —
 * e.g. a freshly issued credential delivered to a consilium dev coder — so they
 * are still redacted from that run's stdout/stderr/trace. Short values (< 6
 * chars) are dropped to avoid mass false-positive redaction, same as env values.
 */
function scrubValueSet(extraValues: readonly string[]): string[] {
  if (extraValues.length === 0) return collectSecretValues();
  const extra = extraValues.filter(
    (v) => typeof v === "string" && v.length >= MIN_SECRET_LENGTH,
  );
  return [...collectSecretValues(), ...extra].sort((a, b) => b.length - a.length);
}

/**
 * Replace every occurrence of a known secret env value in `input` with
 * [REDACTED]. Non-string input coerces to "" (never throws).
 *
 * `extraValues` (default empty ⇒ byte-identical to the env-only behavior) adds a
 * per-run leased value set to the scrub (ADR-003 §D dynamic scrubber).
 */
export function scrubSecrets(
  input: string,
  extraValues: readonly string[] = [],
): string {
  if (typeof input !== "string") return "";
  if (input.length === 0) return input;
  let out = input;
  for (const secret of scrubValueSet(extraValues)) {
    if (!out.includes(secret)) continue;
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTION);
  }
  return out;
}

/**
 * Scrub secrets, then truncate to MAX_PREVIEW_CHARS. Use for any partial-output
 * preview / stderr fragment that enters an error, WS payload, log, or trace.
 *
 * `extraValues` (default empty ⇒ byte-identical) threads a per-run leased value
 * set into the scrub (ADR-003 §D dynamic scrubber).
 */
export function scrubAndTruncate(
  input: string,
  extraValues: readonly string[] = [],
): string {
  const scrubbed = scrubSecrets(input, extraValues);
  return scrubbed.length > MAX_PREVIEW_CHARS
    ? scrubbed.slice(0, MAX_PREVIEW_CHARS)
    : scrubbed;
}
