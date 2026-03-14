import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LEN = 32;
const SALT = "multiqlti-provider-keys-v1"; // static salt; key is env-derived

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, SALT, KEY_LEN);
}

function getSecret(): string {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    console.warn(
      "[crypto] ENCRYPTION_KEY env var not set — using insecure dev default. " +
      "Set ENCRYPTION_KEY in production.",
    );
    return "dev-default-insecure-key-change-me!";
  }
  return secret;
}

/**
 * Encrypts plaintext with AES-256-GCM.
 * Returns a hex string: iv(24) + authTag(32) + ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = deriveKey(getSecret());
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("hex");
}

/**
 * Decrypts a hex string produced by encrypt().
 */
export function decrypt(ciphertext: string): string {
  const key = deriveKey(getSecret());
  const buf = Buffer.from(ciphertext, "hex");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
