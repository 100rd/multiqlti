/**
 * webhook-handler.test.ts — HMAC verification + the per-trigger webhook receiver
 * (server/services/webhook-handler.ts). Focus (adversarial rails):
 *   - a GOOD GitHub signature (sha256=<hmac of the RAW body>) passes → fireTrigger.
 *   - a BAD / MISSING / TAMPERED signature → 401, fireTrigger NOT called.
 *   - the RAW body is hashed (a re-serialized body with different whitespace fails).
 *   - a github_event trigger fires with the `{ event, delivery, payload }` envelope
 *     built from the X-GitHub-Event header (so the dispatch can map the event).
 */
import { describe, it, expect, vi } from "vitest";
import { createHmac } from "crypto";
import type { Request, Response } from "express";
import type { TriggerRow } from "@shared/schema";
import {
  verifyHmacSignature,
  handleWebhookRequest,
} from "../../server/services/webhook-handler.js";

const SECRET = "s3cr3t-webhook-key";

function githubSignature(rawBody: Buffer, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

// ─── verifyHmacSignature (pure) ────────────────────────────────────────────────

describe("verifyHmacSignature — GitHub X-Hub-Signature-256 scheme", () => {
  const raw = Buffer.from(JSON.stringify({ action: "opened", number: 7 }), "utf8");

  it("accepts a correct sha256=<hex> signature over the RAW body", () => {
    expect(verifyHmacSignature(raw, SECRET, githubSignature(raw))).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(verifyHmacSignature(raw, SECRET, githubSignature(raw, "other"))).toBe(false);
  });

  it("rejects a missing / empty signature (unsigned request)", () => {
    expect(verifyHmacSignature(raw, SECRET, undefined)).toBe(false);
    expect(verifyHmacSignature(raw, SECRET, "")).toBe(false);
  });

  it("rejects a tampered body (signature computed over a different body)", () => {
    const tampered = Buffer.from(JSON.stringify({ action: "opened", number: 8 }), "utf8");
    expect(verifyHmacSignature(tampered, SECRET, githubSignature(raw))).toBe(false);
  });

  it("rejects a malformed (non 64-hex) digest without throwing", () => {
    expect(verifyHmacSignature(raw, SECRET, "sha256=zzzz")).toBe(false);
    expect(verifyHmacSignature(raw, SECRET, "sha256=" + "a".repeat(63))).toBe(false);
  });
});

// ─── handleWebhookRequest (route seam) ─────────────────────────────────────────

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

function makeReq(over: Partial<Request> & { rawBody?: Buffer } = {}): Request {
  return {
    params: { triggerId: "gh-1" },
    headers: {},
    body: {},
    ...over,
  } as unknown as Request;
}

const GH_TRIGGER = {
  id: "gh-1",
  type: "github_event",
  enabled: true,
} as unknown as TriggerRow;

describe("handleWebhookRequest — HMAC gate + github envelope", () => {
  it("GOOD signature → fireTrigger called with the github envelope, 200", async () => {
    const ghBody = { action: "opened", number: 7, pull_request: { title: "x" } };
    const raw = Buffer.from(JSON.stringify(ghBody), "utf8");
    const fireTrigger = vi.fn().mockResolvedValue(undefined);
    const req = makeReq({
      rawBody: raw,
      body: ghBody,
      headers: {
        "x-hub-signature-256": githubSignature(raw),
        "x-github-event": "pull_request",
        "x-github-delivery": "d-99",
      },
    });
    const res = makeRes();

    await handleWebhookRequest(req, res, {
      getTrigger: async () => GH_TRIGGER,
      getSecret: async () => SECRET,
      fireTrigger,
    });

    expect(res.statusCode).toBe(200);
    expect(fireTrigger).toHaveBeenCalledTimes(1);
    const [, payload] = fireTrigger.mock.calls[0];
    expect(payload).toEqual({ event: "pull_request", delivery: "d-99", payload: ghBody });
  });

  it("BAD signature → 401, fireTrigger NOT called", async () => {
    const raw = Buffer.from(JSON.stringify({ action: "opened" }), "utf8");
    const fireTrigger = vi.fn();
    const req = makeReq({
      rawBody: raw,
      body: { action: "opened" },
      headers: { "x-hub-signature-256": githubSignature(raw, "wrong"), "x-github-event": "pull_request" },
    });
    const res = makeRes();

    await handleWebhookRequest(req, res, {
      getTrigger: async () => GH_TRIGGER,
      getSecret: async () => SECRET,
      fireTrigger,
    });

    expect(res.statusCode).toBe(401);
    expect(fireTrigger).not.toHaveBeenCalled();
  });

  it("MISSING signature (unsigned) with a secret configured → 401, no fire", async () => {
    const raw = Buffer.from("{}", "utf8");
    const fireTrigger = vi.fn();
    const req = makeReq({ rawBody: raw, body: {}, headers: { "x-github-event": "pull_request" } });
    const res = makeRes();

    await handleWebhookRequest(req, res, {
      getTrigger: async () => GH_TRIGGER,
      getSecret: async () => SECRET,
      fireTrigger,
    });

    expect(res.statusCode).toBe(401);
    expect(fireTrigger).not.toHaveBeenCalled();
  });

  it("unknown / disabled trigger → 404, no fire", async () => {
    const fireTrigger = vi.fn();
    const res = makeRes();
    await handleWebhookRequest(makeReq(), res, {
      getTrigger: async () => undefined,
      getSecret: async () => null,
      fireTrigger,
    });
    expect(res.statusCode).toBe(404);
    expect(fireTrigger).not.toHaveBeenCalled();
  });
});
