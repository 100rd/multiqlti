/**
 * Unit tests for FederationEncryption -- ECDH key exchange + AES-256-GCM.
 */
import { describe, it, expect } from "vitest";
import {
  FederationEncryption,
  isEncryptedPayload,
} from "../../server/federation/encryption.js";
import type { EncryptedPayload } from "../../server/federation/encryption.js";

const CLUSTER_SECRET = "test-cluster-secret-for-encryption-tests";

describe("federation/encryption", () => {
  // -- Key generation ---------------------------------------------------------

  describe("generateKeyPair", () => {
    it("produces a base64 public key on construction", () => {
      const enc = new FederationEncryption(CLUSTER_SECRET);
      const pubKey = enc.getPublicKey();
      expect(typeof pubKey).toBe("string");
      expect(pubKey.length).toBeGreaterThan(0);
      // Verify it is valid base64
      expect(() => Buffer.from(pubKey, "base64")).not.toThrow();
    });

    it("produces different keypairs for different instances", () => {
      const a = new FederationEncryption(CLUSTER_SECRET);
      const b = new FederationEncryption(CLUSTER_SECRET);
      expect(a.getPublicKey()).not.toBe(b.getPublicKey());
    });
  });

  // -- Key exchange -----------------------------------------------------------

  describe("deriveSharedKey", () => {
    it("derives a shared key from peer public key", () => {
      const a = new FederationEncryption(CLUSTER_SECRET);
      const b = new FederationEncryption(CLUSTER_SECRET);

      a.deriveSharedKey("peer-b", b.getPublicKey());
      b.deriveSharedKey("peer-a", a.getPublicKey());

      expect(a.hasPeerKey("peer-b")).toBe(true);
      expect(b.hasPeerKey("peer-a")).toBe(true);
    });

    it("different peers get different encryption keys", () => {
      const a = new FederationEncryption(CLUSTER_SECRET);
      const b = new FederationEncryption(CLUSTER_SECRET);
      const c = new FederationEncryption(CLUSTER_SECRET);

      a.deriveSharedKey("peer-b", b.getPublicKey());
      a.deriveSharedKey("peer-c", c.getPublicKey());

      // Encrypt same payload for different peers -- ciphertext must differ
      const encB = a.encrypt("peer-b", { msg: "hello" });
      const encC = a.encrypt("peer-c", { msg: "hello" });
      expect(encB.ciphertext).not.toBe(encC.ciphertext);
    });
  });

  // -- Encrypt / Decrypt round-trip -------------------------------------------

  describe("encrypt / decrypt", () => {
    function makePair(): { a: FederationEncryption; b: FederationEncryption } {
      const a = new FederationEncryption(CLUSTER_SECRET);
      const b = new FederationEncryption(CLUSTER_SECRET);
      a.deriveSharedKey("peer-b", b.getPublicKey());
      b.deriveSharedKey("peer-a", a.getPublicKey());
      return { a, b };
    }

    it("round-trips a simple object payload", () => {
      const { a, b } = makePair();
      const payload = { message: "hello federation", count: 42 };
      const encrypted = a.encrypt("peer-b", payload);
      const decrypted = b.decrypt("peer-a", encrypted);
      expect(decrypted).toEqual(payload);
    });

    it("round-trips a string payload", () => {
      const { a, b } = makePair();
      const encrypted = a.encrypt("peer-b", "plain string");
      const decrypted = b.decrypt("peer-a", encrypted);
      expect(decrypted).toBe("plain string");
    });

    it("round-trips a null payload", () => {
      const { a, b } = makePair();
      const encrypted = a.encrypt("peer-b", null);
      const decrypted = b.decrypt("peer-a", encrypted);
      expect(decrypted).toBeNull();
    });

    it("round-trips an array payload", () => {
      const { a, b } = makePair();
      const payload = [1, "two", { three: 3 }];
      const encrypted = a.encrypt("peer-b", payload);
      const decrypted = b.decrypt("peer-a", encrypted);
      expect(decrypted).toEqual(payload);
    });

    it("round-trips a large payload (1MB)", () => {
      const { a, b } = makePair();
      const largeString = "x".repeat(1024 * 1024);
      const payload = { data: largeString };
      const encrypted = a.encrypt("peer-b", payload);
      const decrypted = b.decrypt("peer-a", encrypted);
      expect(decrypted).toEqual(payload);
    });

    it("encrypted payload has correct structure", () => {
      const { a } = makePair();
      const encrypted = a.encrypt("peer-b", { key: "value" });

      expect(encrypted.encrypted).toBe(true);
      expect(typeof encrypted.ciphertext).toBe("string");
      expect(typeof encrypted.iv).toBe("string");
      expect(typeof encrypted.authTag).toBe("string");

      // IV should be 12 bytes (16 chars base64 with padding)
      const ivBytes = Buffer.from(encrypted.iv, "base64");
      expect(ivBytes.length).toBe(12);

      // Auth tag should be 16 bytes
      const tagBytes = Buffer.from(encrypted.authTag, "base64");
      expect(tagBytes.length).toBe(16);
    });

    it("each encryption produces a unique IV", () => {
      const { a } = makePair();
      const payload = { msg: "same" };
      const enc1 = a.encrypt("peer-b", payload);
      const enc2 = a.encrypt("peer-b", payload);
      expect(enc1.iv).not.toBe(enc2.iv);
      expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    });
  });

  // -- Tamper detection -------------------------------------------------------

  describe("tamper detection (GCM auth tag)", () => {
    function makePair(): { a: FederationEncryption; b: FederationEncryption } {
      const a = new FederationEncryption(CLUSTER_SECRET);
      const b = new FederationEncryption(CLUSTER_SECRET);
      a.deriveSharedKey("peer-b", b.getPublicKey());
      b.deriveSharedKey("peer-a", a.getPublicKey());
      return { a, b };
    }

    it("rejects tampered ciphertext", () => {
      const { a, b } = makePair();
      const encrypted = a.encrypt("peer-b", { secret: "data" });

      // Tamper with ciphertext
      const tampered: EncryptedPayload = {
        ...encrypted,
        ciphertext: Buffer.from("tampered-data").toString("base64"),
      };

      expect(() => b.decrypt("peer-a", tampered)).toThrow();
    });

    it("rejects tampered IV", () => {
      const { a, b } = makePair();
      const encrypted = a.encrypt("peer-b", { secret: "data" });

      // Tamper with IV
      const tampered: EncryptedPayload = {
        ...encrypted,
        iv: Buffer.alloc(12, 0xff).toString("base64"),
      };

      expect(() => b.decrypt("peer-a", tampered)).toThrow();
    });

    it("rejects tampered auth tag", () => {
      const { a, b } = makePair();
      const encrypted = a.encrypt("peer-b", { secret: "data" });

      // Tamper with auth tag
      const tampered: EncryptedPayload = {
        ...encrypted,
        authTag: Buffer.alloc(16, 0x00).toString("base64"),
      };

      expect(() => b.decrypt("peer-a", tampered)).toThrow();
    });
  });

  // -- Error cases ------------------------------------------------------------

  describe("error handling", () => {
    it("throws when encrypting for unknown peer", () => {
      const enc = new FederationEncryption(CLUSTER_SECRET);
      expect(() => enc.encrypt("unknown-peer", { data: 1 })).toThrow(
        "No encryption key for peer: unknown-peer",
      );
    });

    it("throws when decrypting from unknown peer", () => {
      const enc = new FederationEncryption(CLUSTER_SECRET);
      const fakePayload: EncryptedPayload = {
        encrypted: true,
        ciphertext: "abc",
        iv: "def",
        authTag: "ghi",
      };
      expect(() => enc.decrypt("unknown-peer", fakePayload)).toThrow(
        "No encryption key for peer: unknown-peer",
      );
    });

    it("hasPeerKey returns false for unknown peer", () => {
      const enc = new FederationEncryption(CLUSTER_SECRET);
      expect(enc.hasPeerKey("nobody")).toBe(false);
    });
  });

  // -- Key rotation -----------------------------------------------------------

  describe("key rotation", () => {
    it("rotateKeys produces a new public key", () => {
      const enc = new FederationEncryption(CLUSTER_SECRET);
      const original = enc.getPublicKey();
      const rotated = enc.rotateKeys();
      expect(rotated).not.toBe(original);
      expect(enc.getPublicKey()).toBe(rotated);
    });

    it("rotateKeys increments generation", () => {
      const enc = new FederationEncryption(CLUSTER_SECRET);
      expect(enc.getGeneration()).toBe(0);
      enc.rotateKeys();
      expect(enc.getGeneration()).toBe(1);
      enc.rotateKeys();
      expect(enc.getGeneration()).toBe(2);
    });

    it("rotateKeys clears peer keys", () => {
      const a = new FederationEncryption(CLUSTER_SECRET);
      const b = new FederationEncryption(CLUSTER_SECRET);
      a.deriveSharedKey("peer-b", b.getPublicKey());
      expect(a.hasPeerKey("peer-b")).toBe(true);

      a.rotateKeys();
      expect(a.hasPeerKey("peer-b")).toBe(false);
    });

    it("decrypt falls back to previous key for in-flight messages", () => {
      const a = new FederationEncryption(CLUSTER_SECRET);
      const b = new FederationEncryption(CLUSTER_SECRET);
      a.deriveSharedKey("peer-b", b.getPublicKey());
      b.deriveSharedKey("peer-a", a.getPublicKey());

      // Encrypt with current keys
      const encrypted = a.encrypt("peer-b", { msg: "before rotation" });

      // B rotates keys -- but keeps previous keys for in-flight decryption
      b.rotateKeys();
      // Re-derive with new B keypair (simulating key:rotate exchange)
      a.deriveSharedKey("peer-b", b.getPublicKey());
      b.deriveSharedKey("peer-a", a.getPublicKey());

      // B should still decrypt the message encrypted with old keys
      const decrypted = b.decrypt("peer-a", encrypted);
      expect(decrypted).toEqual({ msg: "before rotation" });
    });

    it("new messages work after key re-exchange post-rotation", () => {
      const a = new FederationEncryption(CLUSTER_SECRET);
      const b = new FederationEncryption(CLUSTER_SECRET);
      a.deriveSharedKey("peer-b", b.getPublicKey());
      b.deriveSharedKey("peer-a", a.getPublicKey());

      // Rotate B
      b.rotateKeys();
      a.deriveSharedKey("peer-b", b.getPublicKey());
      b.deriveSharedKey("peer-a", a.getPublicKey());

      // New message should work
      const encrypted = a.encrypt("peer-b", { msg: "after rotation" });
      const decrypted = b.decrypt("peer-a", encrypted);
      expect(decrypted).toEqual({ msg: "after rotation" });
    });
  });

  // -- removePeer -------------------------------------------------------------

  describe("removePeer", () => {
    it("removes key material for a peer", () => {
      const a = new FederationEncryption(CLUSTER_SECRET);
      const b = new FederationEncryption(CLUSTER_SECRET);
      a.deriveSharedKey("peer-b", b.getPublicKey());
      expect(a.hasPeerKey("peer-b")).toBe(true);
      a.removePeer("peer-b");
      expect(a.hasPeerKey("peer-b")).toBe(false);
    });
  });

  // -- isEncryptedPayload type guard ------------------------------------------

  describe("isEncryptedPayload", () => {
    it("returns true for valid encrypted payload", () => {
      const p: EncryptedPayload = {
        encrypted: true,
        ciphertext: "abc",
        iv: "def",
        authTag: "ghi",
      };
      expect(isEncryptedPayload(p)).toBe(true);
    });

    it("returns false for null", () => {
      expect(isEncryptedPayload(null)).toBe(false);
    });

    it("returns false for string", () => {
      expect(isEncryptedPayload("hello")).toBe(false);
    });

    it("returns false for plain object without encrypted flag", () => {
      expect(isEncryptedPayload({ data: "hello" })).toBe(false);
    });

    it("returns false for object with encrypted=false", () => {
      expect(
        isEncryptedPayload({
          encrypted: false,
          ciphertext: "a",
          iv: "b",
          authTag: "c",
        }),
      ).toBe(false);
    });

    it("returns false when missing ciphertext", () => {
      expect(
        isEncryptedPayload({ encrypted: true, iv: "b", authTag: "c" }),
      ).toBe(false);
    });
  });
});
