/**
 * Unit tests for server/crypto.ts (PR-0e — versioned ciphertext + dual-key rekey)
 *
 * These tests verify:
 *   1. encrypt() produces a `v2:` prefixed string
 *   2. decrypt() round-trips a v2: value correctly
 *   3. decrypt() can still decrypt legacy (unprefixed) values encrypted with the
 *      current key (backward compat — existing rows that were encrypted pre-PR-0e)
 *   4. decrypt() falls back to the dev-fallback key for legacy values (migration
 *      detection — lets the rekey script find and re-encrypt those rows)
 *   5. encrypt() / decrypt() throw when ENCRYPTION_KEY is not configured
 *   6. The rekey migration path is idempotent (v2: values are re-readable)
 *   7. isV2() correctly identifies format
 *   8. decryptLegacyWithKey() is accessible for the rekey script
 *
 * The configLoader is mocked so these tests work without a running server or
 * any real ENCRYPTION_KEY env var.  To test the "throws when missing" path,
 * the mock returns undefined for the key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock configLoader BEFORE importing crypto ────────────────────────────────

const TEST_KEY_32 = "test-key-32-chars-exactly-paddedX"; // 33 chars, valid (min 32)
const ALT_KEY_32 = "alternate-key-32-chars-padded-XXX"; // 33 chars

let mockEncryptionKey: string | undefined = TEST_KEY_32;

vi.mock("../../server/config/loader.js", () => ({
  configLoader: {
    get: () => ({
      encryption: { key: mockEncryptionKey },
    }),
  },
}));

// ─── Import AFTER mocks ───────────────────────────────────────────────────────

import {
  encrypt,
  decrypt,
  isV2,
  decryptLegacyWithKey,
  DEV_FALLBACK_KEY_EXPORT,
} from "../../server/crypto.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Produce a legacy-format ciphertext using the internal crypto primitives.
 * This simulates what was stored by the OLD crypto.ts (pre-PR-0e).
 */
function makeLegacyCiphertext(plaintext: string, secret: string): string {
  const { createCipheriv, randomBytes, scryptSync } = require("crypto");
  const SALT = "multiqlti-provider-keys-v1";
  const KEY_LEN = 32;
  const key = scryptSync(secret, SALT, KEY_LEN);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("hex");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("encrypt()", () => {
  beforeEach(() => {
    mockEncryptionKey = TEST_KEY_32;
  });

  it("produces a v2: prefixed string", () => {
    const result = encrypt("hello world");
    expect(result).toMatch(/^v2:/);
  });

  it("produces different ciphertexts for the same plaintext (random salt per call)", () => {
    const a = encrypt("same plaintext");
    const b = encrypt("same plaintext");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v2:/);
    expect(b).toMatch(/^v2:/);
  });

  it("throws when ENCRYPTION_KEY is not configured", () => {
    mockEncryptionKey = undefined;
    expect(() => encrypt("anything")).toThrow(/ENCRYPTION_KEY/);
  });
});

describe("decrypt() — v2: round-trip", () => {
  beforeEach(() => {
    mockEncryptionKey = TEST_KEY_32;
  });

  it("decrypts a value produced by encrypt()", () => {
    const plaintext = "super secret api key";
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("handles unicode and long values", () => {
    const plaintext = "日本語テスト — with emoji 🔐 — " + "x".repeat(500);
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("throws on a corrupted v2: payload", () => {
    expect(() => decrypt("v2:deadbeef")).toThrow();
  });

  it("throws when ENCRYPTION_KEY is not configured", () => {
    const ciphertext = encrypt("something");
    mockEncryptionKey = undefined;
    expect(() => decrypt(ciphertext)).toThrow(/ENCRYPTION_KEY/);
  });
});

describe("decrypt() — legacy backward compatibility", () => {
  beforeEach(() => {
    mockEncryptionKey = TEST_KEY_32;
  });

  it("decrypts a legacy (unprefixed) value encrypted with the CURRENT key", () => {
    const plaintext = "legacy secret value";
    const legacy = makeLegacyCiphertext(plaintext, TEST_KEY_32);
    expect(legacy).not.toMatch(/^v2:/);
    expect(decrypt(legacy)).toBe(plaintext);
  });

  it("decrypts a legacy value encrypted with the DEV FALLBACK key (migration detection)", () => {
    // Simulates a prod row written before ENCRYPTION_KEY was configured
    const plaintext = "value written with fallback key";
    const legacy = makeLegacyCiphertext(plaintext, DEV_FALLBACK_KEY_EXPORT);
    expect(decrypt(legacy)).toBe(plaintext);
  });

  it("throws when a legacy value cannot be decrypted with either key", () => {
    // Random noise that isn't valid GCM ciphertext for any known key
    const garbage = Buffer.alloc(60, 0xab).toString("hex");
    expect(() => decrypt(garbage)).toThrow();
  });
});

describe("isV2()", () => {
  it("returns true for v2: prefixed values", () => {
    expect(isV2("v2:abcdef")).toBe(true);
  });

  it("returns false for legacy (unprefixed) values", () => {
    expect(isV2("abcdef1234")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isV2("")).toBe(false);
  });
});

describe("decryptLegacyWithKey() — rekey script helper", () => {
  beforeEach(() => {
    mockEncryptionKey = TEST_KEY_32;
  });

  it("decrypts a legacy value with the correct key", () => {
    const plaintext = "plaintext for rekey";
    const legacy = makeLegacyCiphertext(plaintext, TEST_KEY_32);
    expect(decryptLegacyWithKey(legacy, TEST_KEY_32)).toBe(plaintext);
  });

  it("throws when given the wrong key", () => {
    const plaintext = "plaintext for rekey";
    const legacy = makeLegacyCiphertext(plaintext, TEST_KEY_32);
    expect(() => decryptLegacyWithKey(legacy, ALT_KEY_32)).toThrow();
  });

  it("decrypts a fallback-key legacy value with the fallback key", () => {
    const plaintext = "written with fallback";
    const legacy = makeLegacyCiphertext(plaintext, DEV_FALLBACK_KEY_EXPORT);
    expect(decryptLegacyWithKey(legacy, DEV_FALLBACK_KEY_EXPORT)).toBe(plaintext);
  });
});

describe("rekey idempotency", () => {
  beforeEach(() => {
    mockEncryptionKey = TEST_KEY_32;
  });

  it("a v2: value is unchanged when re-read after a simulated rekey", () => {
    const plaintext = "idempotent secret";

    // Step 1: encrypt (as rekey script would produce)
    const v2Ciphertext = encrypt(plaintext);
    expect(isV2(v2Ciphertext)).toBe(true);

    // Step 2: decrypt the v2: value (simulates a second rekey pass — should be a no-op)
    const recovered = decrypt(v2Ciphertext);
    expect(recovered).toBe(plaintext);

    // Step 3: re-encrypting again produces a DIFFERENT ciphertext (new random
    // salt) but decrypts to the same plaintext (idempotent from the data perspective)
    const v2Again = encrypt(recovered);
    expect(v2Again).not.toBe(v2Ciphertext); // different random salt
    expect(decrypt(v2Again)).toBe(plaintext);
  });

  it("a legacy value that has been rekeyed is no longer treated as legacy", () => {
    const plaintext = "pre-migration secret";
    const legacy = makeLegacyCiphertext(plaintext, TEST_KEY_32);
    expect(isV2(legacy)).toBe(false);

    // Simulate what the rekey script does: decrypt legacy → re-encrypt as v2:
    const recovered = decryptLegacyWithKey(legacy, TEST_KEY_32);
    const rekeyed = encrypt(recovered);

    expect(isV2(rekeyed)).toBe(true);
    expect(decrypt(rekeyed)).toBe(plaintext);
  });
});
