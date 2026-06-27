import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { configLoader } from "./config/loader";

const ALGORITHM = "aes-256-gcm";
const KEY_LEN = 32;

/**
 * Legacy static salt used for all ciphertext produced before v2:.
 * Kept here ONLY to decrypt existing (pre-rekey) rows — never used for new
 * encryptions. The v2: format embeds a per-value random salt instead.
 */
const LEGACY_SALT = "multiqlti-provider-keys-v1";

/**
 * V2 salt length in bytes. Each v2: ciphertext embeds a fresh 32-byte random
 * salt so key-derivation is independent per value.
 */
const V2_SALT_LEN = 32;

/**
 * The old insecure dev-fallback key.
 *
 * Used ONLY inside `decryptLegacy()` to detect rows that were written with the
 * fallback instead of a real key. This lets the rekey migration script find and
 * re-encrypt those rows. The application NEVER produces new ciphertext with this
 * key — `encrypt()` calls `getSecret()` which throws if ENCRYPTION_KEY is unset.
 *
 * After the rekey migration confirms zero non-v2: rows in every environment,
 * this constant and the fallback branch in decryptLegacy() will be removed in a
 * separate deploy (see PR-0e Commit 2 — "Remove fallback").
 */
const DEV_FALLBACK_KEY = "dev-default-insecure-key-change-me!";

function deriveKey(secret: string, salt: string): Buffer {
  return scryptSync(secret, salt, KEY_LEN);
}

/**
 * Returns the configured encryption secret.
 *
 * Throws if ENCRYPTION_KEY / MULTI_ENCRYPTION_KEY is not set.
 * There is NO insecure dev-fallback — a missing key is a hard failure.
 * To run tests, set ENCRYPTION_KEY (any 32+-char string) or mock configLoader.
 */
function getSecret(): string {
  const { key } = configLoader.get().encryption;
  if (!key) {
    throw new Error(
      "[crypto] ENCRYPTION_KEY (or MULTI_ENCRYPTION_KEY) is not configured. " +
      "Set it to a random string of at least 32 characters. " +
      "This value must be the SAME across all server instances sharing a database.",
    );
  }
  return key;
}

// ─── V2 format ────────────────────────────────────────────────────────────────
//
// Wire format (binary, then hex-encoded):
//   salt    (32 bytes) — random per-value, embedded in the ciphertext
//   iv      (12 bytes) — AES-GCM nonce
//   authTag (16 bytes) — GCM authentication tag
//   payload (n  bytes) — encrypted plaintext
//
// Stored as: "v2:" + Buffer.concat([salt, iv, authTag, payload]).toString("hex")
//
// Benefits over the legacy format:
//   - Per-value random salt: each ciphertext uses an independently derived key.
//   - Version prefix: format is self-describing; migration scripts can detect
//     which rows need rekeying vs. which are already current.

const V2_PREFIX = "v2:";
const V2_HEADER_LEN = V2_SALT_LEN + 12 + 16; // salt + iv + authTag (bytes)

function encryptV2(plaintext: string, secret: string): string {
  const salt = randomBytes(V2_SALT_LEN);
  const key = deriveKey(secret, salt.toString("hex"));
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return V2_PREFIX + Buffer.concat([salt, iv, authTag, encrypted]).toString("hex");
}

function decryptV2(prefixedHex: string, secret: string): string {
  const hex = prefixedHex.slice(V2_PREFIX.length);
  const buf = Buffer.from(hex, "hex");
  if (buf.length < V2_HEADER_LEN) {
    throw new Error("[crypto] v2: ciphertext is too short to be valid");
  }
  const salt = buf.subarray(0, V2_SALT_LEN);
  const iv = buf.subarray(V2_SALT_LEN, V2_SALT_LEN + 12);
  const authTag = buf.subarray(V2_SALT_LEN + 12, V2_HEADER_LEN);
  const payload = buf.subarray(V2_HEADER_LEN);
  const key = deriveKey(secret, salt.toString("hex"));
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
}

// ─── Legacy format ─────────────────────────────────────────────────────────────
//
// Wire format (binary, then hex-encoded, NO prefix):
//   iv      (12 bytes)
//   authTag (16 bytes)
//   payload (n  bytes)
//
// Key derived with: scryptSync(secret, LEGACY_SALT, KEY_LEN)

const LEGACY_HEADER_LEN = 12 + 16;

function decryptLegacy(hex: string): string {
  const buf = Buffer.from(hex, "hex");
  if (buf.length < LEGACY_HEADER_LEN) {
    throw new Error("[crypto] legacy ciphertext is too short to be valid");
  }
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const payload = buf.subarray(28);

  // Try the real (configured) key first.
  const currentSecret = getSecret();
  try {
    const key = deriveKey(currentSecret, LEGACY_SALT);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
  } catch {
    // GCM auth-tag failure means this value was NOT encrypted with the current
    // key.  Try the dev-fallback key so the rekey migration can detect and
    // re-encrypt these rows.
    //
    // NOTE: This fallback branch will be removed in Commit 2 of PR-0e AFTER the
    // rekey migration script has confirmed zero non-v2: rows in every environment.
  }

  try {
    const fallbackKey = deriveKey(DEV_FALLBACK_KEY, LEGACY_SALT);
    const decipher = createDecipheriv(ALGORITHM, fallbackKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(
      "[crypto] failed to decrypt legacy ciphertext with both the current key and the dev fallback. " +
      "The ciphertext may be corrupt, or encrypted with an unknown key.",
    );
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Encrypts plaintext with AES-256-GCM.
 *
 * Returns a `v2:` prefixed hex string.  The embedded random salt ensures each
 * call produces independently derived key material even when the same secret is
 * reused.
 *
 * Wire format: `"v2:" + hex(salt[32] | iv[12] | authTag[16] | ciphertext)`
 */
export function encrypt(plaintext: string): string {
  return encryptV2(plaintext, getSecret());
}

/**
 * Decrypts a string produced by `encrypt()` (v2: format) or any legacy value
 * produced by the previous format (no prefix).
 *
 * Dispatch:
 *   - Starts with `v2:` → decryptV2 with the current key.
 *   - No prefix (legacy) → decryptLegacy: tries current key first, then the
 *     dev-fallback key so the rekey migration can detect affected rows.
 *
 * After the rekey migration + `--verify` passes in every environment, Commit 2
 * of PR-0e removes the legacy branch and the fallback key entirely.
 */
export function decrypt(ciphertext: string): string {
  if (ciphertext.startsWith(V2_PREFIX)) {
    return decryptV2(ciphertext, getSecret());
  }
  return decryptLegacy(ciphertext);
}

/**
 * Returns true if the value is already in the v2: format (i.e. produced by
 * this version of encrypt() or already rekeyed by the migration script).
 */
export function isV2(value: string): boolean {
  return value.startsWith(V2_PREFIX);
}

/**
 * Exposed for the rekey migration script ONLY.  Do not call from application
 * code.
 *
 * Attempts to decrypt a legacy (non-v2:) ciphertext using a known secret and
 * the static legacy salt.  Throws on auth-tag failure.  The caller (rekey
 * script) is expected to catch the error and try alternative keys.
 */
export function decryptLegacyWithKey(hex: string, secret: string): string {
  const buf = Buffer.from(hex, "hex");
  if (buf.length < LEGACY_HEADER_LEN) {
    throw new Error("[crypto] legacy ciphertext is too short to be valid");
  }
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const payload = buf.subarray(28);
  const key = deriveKey(secret, LEGACY_SALT);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
}

/**
 * The dev fallback key — exported for the rekey script so it can try to
 * decrypt values that were written without a real ENCRYPTION_KEY.
 */
export const DEV_FALLBACK_KEY_EXPORT = DEV_FALLBACK_KEY;
