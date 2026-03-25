/**
 * Unit tests for federation HMAC-SHA256 authentication.
 */
import { describe, it, expect } from "vitest";
import {
  signMessage,
  verifyMessage,
  signEnvelope,
  verifyEnvelope,
} from "../../server/federation/auth.js";
import type { FederationMessage } from "../../server/federation/types.js";

const SECRET = "test-cluster-secret-that-is-long-enough";
const INSTANCE_ID = "instance-a";

describe("federation/auth", () => {
  // ── signMessage / verifyMessage ──────────────────────────────────────────

  describe("signMessage", () => {
    it("produces a consistent hex HMAC for the same inputs", () => {
      const ts = 1700000000000;
      const a = signMessage(SECRET, INSTANCE_ID, ts);
      const b = signMessage(SECRET, INSTANCE_ID, ts);
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/); // SHA-256 = 64 hex chars
    });

    it("produces different HMACs for different instance IDs", () => {
      const ts = 1700000000000;
      const a = signMessage(SECRET, "instance-a", ts);
      const b = signMessage(SECRET, "instance-b", ts);
      expect(a).not.toBe(b);
    });

    it("produces different HMACs for different timestamps", () => {
      const a = signMessage(SECRET, INSTANCE_ID, 1000);
      const b = signMessage(SECRET, INSTANCE_ID, 2000);
      expect(a).not.toBe(b);
    });

    it("produces different HMACs for different secrets", () => {
      const ts = 1700000000000;
      const a = signMessage("secret-one", INSTANCE_ID, ts);
      const b = signMessage("secret-two", INSTANCE_ID, ts);
      expect(a).not.toBe(b);
    });
  });

  describe("verifyMessage", () => {
    it("accepts a valid HMAC", () => {
      const ts = Date.now();
      const hmac = signMessage(SECRET, INSTANCE_ID, ts);
      expect(verifyMessage(SECRET, INSTANCE_ID, ts, hmac)).toBe(true);
    });

    it("rejects an invalid HMAC (wrong secret)", () => {
      const ts = Date.now();
      const hmac = signMessage("wrong-secret", INSTANCE_ID, ts);
      expect(verifyMessage(SECRET, INSTANCE_ID, ts, hmac)).toBe(false);
    });

    it("rejects an invalid HMAC (wrong instance ID)", () => {
      const ts = Date.now();
      const hmac = signMessage(SECRET, "wrong-id", ts);
      expect(verifyMessage(SECRET, INSTANCE_ID, ts, hmac)).toBe(false);
    });

    it("rejects an invalid HMAC (wrong timestamp)", () => {
      const ts = Date.now();
      const hmac = signMessage(SECRET, INSTANCE_ID, ts);
      expect(verifyMessage(SECRET, INSTANCE_ID, ts + 1, hmac)).toBe(false);
    });

    it("rejects a completely bogus HMAC of same length", () => {
      const ts = Date.now();
      const bogus = "a".repeat(64);
      expect(verifyMessage(SECRET, INSTANCE_ID, ts, bogus)).toBe(false);
    });

    it("rejects HMAC with different length gracefully", () => {
      const ts = Date.now();
      expect(verifyMessage(SECRET, INSTANCE_ID, ts, "tooshort")).toBe(false);
    });
  });

  // ── signEnvelope / verifyEnvelope ────────────────────────────────────────

  describe("signEnvelope", () => {
    it("produces a consistent hex HMAC for the same envelope", () => {
      const msg = {
        type: "sync",
        from: INSTANCE_ID,
        correlationId: "corr-1",
        payload: { data: 42 },
        timestamp: 1700000000000,
      };
      const a = signEnvelope(SECRET, msg);
      const b = signEnvelope(SECRET, msg);
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces different HMACs when type changes", () => {
      const base = {
        from: INSTANCE_ID,
        correlationId: "corr-1",
        payload: null,
        timestamp: 1700000000000,
      };
      const a = signEnvelope(SECRET, { ...base, type: "sync" });
      const b = signEnvelope(SECRET, { ...base, type: "query" });
      expect(a).not.toBe(b);
    });
  });

  describe("verifyEnvelope", () => {
    function makeMessage(
      overrides: Partial<Omit<FederationMessage, "hmac">> = {},
    ): FederationMessage {
      const base: Omit<FederationMessage, "hmac"> = {
        type: "sync",
        from: INSTANCE_ID,
        correlationId: "corr-123",
        payload: { key: "value" },
        timestamp: 1700000000000,
        ...overrides,
      };
      return { ...base, hmac: signEnvelope(SECRET, base) };
    }

    it("accepts a correctly signed envelope", () => {
      const msg = makeMessage();
      expect(verifyEnvelope(SECRET, msg)).toBe(true);
    });

    it("rejects an envelope with tampered type", () => {
      const msg = makeMessage();
      msg.type = "tampered";
      expect(verifyEnvelope(SECRET, msg)).toBe(false);
    });

    it("rejects an envelope with tampered from", () => {
      const msg = makeMessage();
      msg.from = "evil-instance";
      expect(verifyEnvelope(SECRET, msg)).toBe(false);
    });

    it("rejects an envelope with tampered correlationId", () => {
      const msg = makeMessage();
      msg.correlationId = "tampered-corr";
      expect(verifyEnvelope(SECRET, msg)).toBe(false);
    });

    it("rejects an envelope with tampered timestamp", () => {
      const msg = makeMessage();
      msg.timestamp = 9999999999999;
      expect(verifyEnvelope(SECRET, msg)).toBe(false);
    });

    it("rejects an envelope signed with a different secret", () => {
      const base: Omit<FederationMessage, "hmac"> = {
        type: "sync",
        from: INSTANCE_ID,
        correlationId: "corr-123",
        payload: null,
        timestamp: 1700000000000,
      };
      const msg: FederationMessage = {
        ...base,
        hmac: signEnvelope("wrong-secret", base),
      };
      expect(verifyEnvelope(SECRET, msg)).toBe(false);
    });

    it("roundtrips: sign then verify succeeds for arbitrary messages", () => {
      for (let i = 0; i < 10; i++) {
        const msg = makeMessage({
          type: `type-${i}`,
          correlationId: `corr-${i}`,
          timestamp: Date.now() + i,
        });
        expect(verifyEnvelope(SECRET, msg)).toBe(true);
      }
    });
  });
});
