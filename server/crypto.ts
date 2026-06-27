import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { configLoader } from "./config/loader";

// ─── DO NOT DEPLOY THIS FILE UNTIL ──────────────────────────────────────────
// 1. The rekey migration script (scripts/rekey-v2.ts) has been run in EVERY
//    environment (dev → staging → prod).
// 2. `npx tsx scripts/rekey-v2.ts --verify` exits 0 (zero non-v2: rows) in
//    EVERY environment.
// Only after both checks pass is it safe to deploy this commit, which removes
// the insecure dev-fallback key and the legacy-format fallback branch.
// ─────────────────────────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm";
const KEY_LEN = 32;
const V2_SALT_LEN = 32;
const V2_PREFIX = "v2:";
const V2_HEADER_LEN = V2_SALT_LEN + 12 + 16; // salt + iv + authTag (bytes)

function deriveKey(secret: string, salt: string): Buffer {
  return scryptSync(secret, salt, KEY_LEN);
}

/**
 * Returns the configured encryption secret.
 *
 * Throws if ENCRYPTION_KEY / MULTI_ENCRYPTION_KEY is not set.
 * There is NO fallback — a missing key is a hard startup failure.
 * In tests, mock configLoader or set ENCRYPTION_KEY to any 32+-char string.
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
 * Decrypts a string produced by `encrypt()`.
 *
 * Only accepts `v2:` prefixed values.  Legacy unprefixed values are no longer
 * supported — they must have been migrated by `scripts/rekey-v2.ts` before
 * this commit was deployed.
 *
 * If a legacy value is encountered here it means the rekey migration was not
 * completed before deploying this commit.  The error message is explicit about
 * the remediation: roll back this commit and run the rekey migration.
 */
export function decrypt(ciphertext: string): string {
  if (ciphertext.startsWith(V2_PREFIX)) {
    return decryptV2(ciphertext, getSecret());
  }
  throw new Error(
    "[crypto] encountered a legacy (non-v2:) ciphertext after fallback removal. " +
    "This means the rekey migration was not completed before deploying this commit. " +
    "Roll back this deploy, run `npx tsx scripts/rekey-v2.ts` until --verify passes " +
    "in every environment, then re-deploy.",
  );
}

/**
 * Returns true if the value is already in the v2: format.
 */
export function isV2(value: string): boolean {
  return value.startsWith(V2_PREFIX);
}
