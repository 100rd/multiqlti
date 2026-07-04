/**
 * trigger-webhook-url.test.ts — webhookUrl() port fix (FIX 1).
 *
 * The default used to hardcode :5000 while the dev server runs on :5050, so the
 * synthesized URL pointed at nothing. It now defaults to the ACTUAL server PORT,
 * and honors PUBLIC_URL when set. webhookUrl() reads only env (no storage), so we
 * construct the service with a stub storage.
 */
import { describe, it, expect, afterEach } from "vitest";
import { TriggerService } from "../../../server/services/trigger-service.js";
import type { IStorage } from "../../../server/storage.js";

// TriggerService constructs a TriggerCrypto, which requires a 64-hex key. This
// test only exercises webhookUrl() (env-only, no crypto), but the constructor
// still needs the key present.
process.env.TRIGGER_SECRET_KEY ??= "0".repeat(64);

const svc = new TriggerService({} as unknown as IStorage);

const savedPort = process.env.PORT;
const savedPublic = process.env.PUBLIC_URL;

afterEach(() => {
  if (savedPort === undefined) delete process.env.PORT;
  else process.env.PORT = savedPort;
  if (savedPublic === undefined) delete process.env.PUBLIC_URL;
  else process.env.PUBLIC_URL = savedPublic;
});

describe("TriggerService.webhookUrl", () => {
  it("defaults to the actual server PORT (not the hardcoded 5000)", () => {
    delete process.env.PUBLIC_URL;
    process.env.PORT = "5050";
    expect(svc.webhookUrl("abc")).toBe("http://localhost:5050/api/webhooks/abc");
  });

  it("falls back to 5000 only when PORT is unset", () => {
    delete process.env.PUBLIC_URL;
    delete process.env.PORT;
    expect(svc.webhookUrl("abc")).toBe("http://localhost:5000/api/webhooks/abc");
  });

  it("honors PUBLIC_URL (a public tunnel) over the local port", () => {
    process.env.PUBLIC_URL = "https://demo.trycloudflare.com";
    process.env.PORT = "5050";
    expect(svc.webhookUrl("xyz")).toBe("https://demo.trycloudflare.com/api/webhooks/xyz");
  });
});
