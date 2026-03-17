/**
 * TriggerCrypto — AES-256-GCM encryption for trigger secrets.
 *
 * Unlike server/crypto.ts which has a dev fallback, TriggerCrypto intentionally
 * has NO fallback — secrets must be encrypted and the key must be present.
 * If TRIGGER_SECRET_KEY is absent or invalid the server must not start.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
// KEY_LEN in bytes: 32 bytes = 256 bits (matches AES-256)
const KEY_LEN = 32;
// TRIGGER_SECRET_KEY must be exactly 64 hex chars (32 bytes)
const HEX_KEY_LENGTH = 64;

export class TriggerCrypto {
  private readonly key: Buffer;

  constructor() {
    const raw = process.env.TRIGGER_SECRET_KEY;

    // Fix 4: Throw immediately if key is missing or not exactly 64 hex chars.
    // Unlike server/crypto.ts which has a dev fallback, TriggerCrypto intentionally
    // has NO fallback — secrets must be encrypted and the key must be present.
    if (!raw || raw.trim() === "" || !/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error(
        "TRIGGER_SECRET_KEY env var is missing or invalid — cannot initialize TriggerCrypto. " +
          "Set it to a 64-character hex string (32 random bytes as hex).",
      );
    }

    this.key = Buffer.from(raw, "hex");
    if (this.key.length !== KEY_LEN) {
      throw new Error(
        "TRIGGER_SECRET_KEY env var is missing or invalid — cannot initialize TriggerCrypto.",
      );
    }
  }

  /**
   * Encrypt plaintext with AES-256-GCM.
   * Returns a hex string: iv(12 bytes) + authTag(16 bytes) + ciphertext.
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]).toString("hex");
  }

  /**
   * Decrypt a hex string produced by encrypt().
   */
  decrypt(ciphertext: string): string {
    const buf = Buffer.from(ciphertext, "hex");
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }
}
