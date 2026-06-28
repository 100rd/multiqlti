/**
 * Unit tests for server/crypto.ts (PR-0e Commit 2 — fallback removed)
 *
 * This is the Commit 2 version of the test file.  It covers the post-migration
 * state where:
 *   - All DB rows are in v2: format (rekey migration has been verified).
 *   - Legacy (unprefixed) ciphertext is no longer supported — decrypt() throws.
 *   - The dev-fallback key and decryptLegacyWithKey() have been removed.
 *
 * For the Commit 1 tests (dual-key detection, legacy fallback, migration helpers)
 * see the git history at the Commit 1 SHA.
 *
 * Tests:
 *   1. encrypt() produces a `v2:` prefixed string
 *   2. decrypt() round-trips a v2: value correctly
 *   3. decrypt() throws for legacy (non-v2:) values (post-migration guard)
 *   4. encrypt() / decrypt() throw when ENCRYPTION_KEY is not configured
 *   5. isV2() correctly identifies format
 *   6. Rekey idempotency (v2: values re-read and re-encrypt cleanly)
 *   7. Tamper-resistance: GCM auth-tag rejects payload bit-flip (R2-L1 fix)
 *
 * The configLoader is mocked so these tests work without a running server or
 * any real ENCRYPTION_KEY env var.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock configLoader BEFORE importing crypto ────────────────────────────────

const TEST_KEY_32 = "test-key-32-chars-exactly-paddedX"; // 33 chars, valid (min 32)

let mockEncryptionKey: string | undefined = TEST_KEY_32;

vi.mock("../../server/config/loader.js", () => ({
  configLoader: {
    get: () => ({
      encryption: { key: mockEncryptionKey },
    }),
  },
}));

// ─── Import AFTER mocks ───────────────────────────────────────────────────────

import { encrypt, decrypt, isV2 } from "../../server/crypto.js";

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

  it("throws on a corrupted v2: payload (length guard path)", () => {
    // "v2:deadbeef" is too short to be a valid ciphertext — hits the length guard
    // before GCM auth-tag verification. See the tamper test for the GCM path.
    expect(() => decrypt("v2:deadbeef")).toThrow();
  });

  it("throws when ENCRYPTION_KEY is not configured", () => {
    const ciphertext = encrypt("something");
    mockEncryptionKey = undefined;
    expect(() => decrypt(ciphertext)).toThrow(/ENCRYPTION_KEY/);
  });
});

describe("decrypt() — tamper resistance (R2-L1)", () => {
  beforeEach(() => {
    mockEncryptionKey = TEST_KEY_32;
  });

  /**
   * R2-L1 fix: verifies GCM auth-tag rejection on ciphertext payload tampering.
   *
   * v2: wire format after the "v2:" prefix (hex-encoded binary):
   *   salt    [32 bytes = 64 hex chars]
   *   iv      [12 bytes = 24 hex chars]
   *   authTag [16 bytes = 32 hex chars]
   *   payload [N  bytes = 2N hex chars]  ← flip one char HERE
   *
   * Header = 32+12+16 = 60 bytes = 120 hex chars.
   * Payload starts at hex index 120 (relative to start of the hex string).
   *
   * Flipping a hex char in the payload corrupts one nibble of the encrypted
   * bytes. AES-256-GCM's auth tag covers the entire payload, so any change
   * causes decipher.final() to throw — NOT the length guard.
   *
   * This test differs from "v2:deadbeef" (which hits the length guard) because
   * the tampered value has the SAME length as a valid ciphertext.
   */
  it("throws (GCM auth-tag rejection, not length guard) when one payload nibble is flipped", () => {
    const plaintext = "tamper-detection-test";
    const ciphertext = encrypt(plaintext);

    const V2_PREFIX = "v2:";
    const hex = ciphertext.slice(V2_PREFIX.length);

    // Header = salt(64) + iv(24) + authTag(32) = 120 hex chars.
    const HEADER_HEX_LEN = 120;

    // Sanity check: must have payload bytes to flip.
    expect(hex.length).toBeGreaterThan(HEADER_HEX_LEN);

    // Flip the first hex char of the payload (XOR nibble by 1 for guaranteed change).
    const originalNibble = parseInt(hex[HEADER_HEX_LEN], 16);
    const flippedNibble = (originalNibble ^ 0x01).toString(16);
    const tampered =
      V2_PREFIX +
      hex.slice(0, HEADER_HEX_LEN) +
      flippedNibble +
      hex.slice(HEADER_HEX_LEN + 1);

    // Same length as original — this is the GCM auth-tag path, not length guard.
    expect(tampered.length).toBe(ciphertext.length);
    expect(() => decrypt(tampered)).toThrow();
  });
});

describe("decrypt() — legacy guard (post-migration)", () => {
  beforeEach(() => {
    mockEncryptionKey = TEST_KEY_32;
  });

  it("throws for unprefixed (legacy) ciphertext with a helpful error message", () => {
    // Simulate encountering a row that was NOT migrated before this commit was deployed
    const fakeHex = Buffer.alloc(60, 0xab).toString("hex"); // not v2: prefixed
    expect(() => decrypt(fakeHex)).toThrow(/rekey migration/i);
  });

  it("throws with a rollback instruction when legacy value is encountered", () => {
    const fakeHex = Buffer.alloc(60, 0xab).toString("hex");
    const error = (() => {
      try { decrypt(fakeHex); return null; }
      catch (e) { return e as Error; }
    })();
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/rekey-v2\.ts/);
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

describe("rekey idempotency", () => {
  beforeEach(() => {
    mockEncryptionKey = TEST_KEY_32;
  });

  it("a v2: value is unchanged when re-read after a rekey pass", () => {
    const plaintext = "idempotent secret";

    // Step 1: encrypt (as rekey script would produce)
    const v2Ciphertext = encrypt(plaintext);
    expect(isV2(v2Ciphertext)).toBe(true);

    // Step 2: decrypt the v2: value (simulates a second rekey pass — a no-op)
    const recovered = decrypt(v2Ciphertext);
    expect(recovered).toBe(plaintext);

    // Step 3: re-encrypting again produces a different ciphertext (new random
    // salt) but decrypts to the same plaintext (idempotent from data perspective)
    const v2Again = encrypt(recovered);
    expect(v2Again).not.toBe(v2Ciphertext); // different random salt
    expect(decrypt(v2Again)).toBe(plaintext);
  });

  it("each encrypt() call uses a distinct salt (independent key derivation per value)", () => {
    const plaintext = "check salt independence";
    const results = Array.from({ length: 5 }, () => encrypt(plaintext));
    const unique = new Set(results);
    expect(unique.size).toBe(5); // all different (random salts)
    // but all decrypt to the same plaintext
    results.forEach((ct) => expect(decrypt(ct)).toBe(plaintext));
  });
});
