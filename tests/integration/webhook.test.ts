/**
 * Integration tests for the webhook receipt routes (routes/webhooks.ts).
 *
 * Endpoints covered:
 *   POST /api/webhooks/:triggerId  — generic webhook receiver
 *
 * Security scenarios:
 *   - Valid HMAC signature    → 200
 *   - Invalid HMAC signature  → 401
 *   - Missing signature       → 401 (when trigger has a secret)
 *   - Disabled trigger        → 404
 *   - No secret on trigger    → 200 (open webhook, no verification)
 *   - Rate limited            → 429
 *   - Non-existent trigger    → 404
 *
 * HMAC is computed as "sha256=" + hex(HMAC-SHA256(secret, rawBody)).
 * The express.json `verify` callback must set req.rawBody so the handler
 * can compare against the actual raw bytes received over the wire.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";
import { createHmac } from "crypto";
import type { User } from "../../shared/types.js";
import type { TriggerRow } from "../../shared/schema.js";

// ─── Mock configLoader before any server module import ───────────────────────

const TEST_JWT_SECRET = "test-secret-minimum-32-chars-longxx";

vi.mock("../../server/config/loader.js", () => ({
  configLoader: {
    get: () => ({
      auth: { jwtSecret: TEST_JWT_SECRET, bcryptRounds: 4, sessionTtlDays: 1 },
      server: { nodeEnv: "test", port: 3000 },
      database: { url: undefined },
      providers: {
        anthropic: {},
        google: {},
        xai: {},
        vllm: { endpoint: undefined },
        ollama: { endpoint: undefined },
        tavily: {},
      },
      features: {
        sandbox: { enabled: false },
        privacy: { enabled: true },
        maintenance: { enabled: false, cronSchedule: "0 2 * * *" },
      },
      encryption: {},
    }),
  },
}));

// ─── Mock TriggerCrypto ───────────────────────────────────────────────────────
// Must use a regular function (not arrow) so it is `new`-able as a class constructor.

vi.mock("../../server/services/trigger-crypto.js", () => ({
  // eslint-disable-next-line prefer-arrow-callback
  TriggerCrypto: function TriggerCryptoMock() {
    return {
      encrypt(plaintext: string) { return `enc:${plaintext}`; },
      decrypt(ciphertext: string) { return ciphertext.replace(/^enc:/, ""); },
    };
  },
}));

// ─── Mock authService (not used for public webhook routes) ───────────────────

const TEST_ADMIN_USER: User = {
  id: "test-user-id",
  email: "test@example.com",
  name: "Test User",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

vi.mock("../../server/auth/service.js", () => ({
  authService: {
    validateToken: vi.fn(async () => TEST_ADMIN_USER),
  },
}));

// ─── App factory ─────────────────────────────────────────────────────────────

/**
 * Build an app with webhook routes wired.
 * The express.json `verify` callback sets req.rawBody so HMAC verification works.
 */
async function createWebhookApp() {
  const { MemStorage } = await import("../../server/storage.js");
  const { TriggerService } = await import("../../server/services/trigger-service.js");
  const { registerWebhookRoutes } = await import("../../server/routes/webhooks.js");

  const storage = new MemStorage();
  const triggerService = new TriggerService(storage);

  // Track fired triggers for assertions
  const firedPayloads: Array<{ trigger: TriggerRow; payload: unknown }> = [];
  const fireTrigger = async (trigger: TriggerRow, payload: unknown): Promise<void> => {
    firedPayloads.push({ trigger, payload });
  };

  const app = express();

  // Set rawBody on every request (mirrors the production index.ts setup)
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as import("http").IncomingMessage & { rawBody: unknown }).rawBody = buf;
      },
    }),
  );

  registerWebhookRoutes(app as never, storage, triggerService, fireTrigger);

  return { app, storage, triggerService, firedPayloads };
}

/** Build a valid HMAC signature for the given body and secret (GitHub-style header). */
function computeHmacSignature(rawBody: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** Seed a raw TriggerRow directly in MemStorage, bypassing TriggerService encryption. */
async function seedRawTrigger(
  storage: Awaited<ReturnType<typeof createWebhookApp>>["storage"],
  opts: {
    pipelineId?: string;
    enabled?: boolean;
    secretEncrypted?: string | null;
  } = {},
): Promise<TriggerRow> {
  return storage.createTrigger({
    pipelineId: opts.pipelineId ?? "test-pipeline-id",
    type: "webhook",
    config: {},
    secretEncrypted: opts.secretEncrypted ?? null,
    enabled: opts.enabled ?? true,
  });
}

// ─── POST /api/webhooks/:triggerId — HMAC signature verification ───────────────

describe("POST /api/webhooks/:triggerId — HMAC signature verification", () => {
  let app: Express;
  let triggerService: Awaited<ReturnType<typeof createWebhookApp>>["triggerService"];
  let firedPayloads: Awaited<ReturnType<typeof createWebhookApp>>["firedPayloads"];

  beforeAll(async () => {
    const ctx = await createWebhookApp();
    app = ctx.app;
    triggerService = ctx.triggerService;
    firedPayloads = ctx.firedPayloads;
  });

  it("should return 200 and fire the trigger when HMAC signature is valid", async () => {
    const trigger = await triggerService.createTrigger({
      pipelineId: "p-hmac-valid",
      type: "webhook",
      config: {},
      secret: "my-webhook-secret",
      enabled: true,
    });

    const body = JSON.stringify({ event: "test" });
    const sig = computeHmacSignature(body, "my-webhook-secret");
    const fired = firedPayloads.length;

    const res = await request(app)
      .post(`/api/webhooks/${trigger.id}`)
      .set("Content-Type", "application/json")
      .set("x-hub-signature-256", sig)
      .send(body);

    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect(firedPayloads.length).toBe(fired + 1);
  });

  it("should return 401 when HMAC signature is invalid (wrong secret)", async () => {
    const trigger = await triggerService.createTrigger({
      pipelineId: "p-hmac-invalid",
      type: "webhook",
      config: {},
      secret: "real-secret",
      enabled: true,
    });

    const body = JSON.stringify({ event: "test" });
    const wrongSig = computeHmacSignature(body, "wrong-secret");

    const res = await request(app)
      .post(`/api/webhooks/${trigger.id}`)
      .set("Content-Type", "application/json")
      .set("x-hub-signature-256", wrongSig)
      .send(body);

    expect(res.status).toBe(401);
    expect((res.body as { error: string }).error).toBeTruthy();
  });

  it("should return 401 when HMAC signature header is missing and trigger has a secret", async () => {
    const trigger = await triggerService.createTrigger({
      pipelineId: "p-hmac-missing",
      type: "webhook",
      config: {},
      secret: "required-secret",
      enabled: true,
    });

    const res = await request(app)
      .post(`/api/webhooks/${trigger.id}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ event: "test" }));

    expect(res.status).toBe(401);
  });

  it("should return 200 with no HMAC verification when trigger has no secret (open webhook)", async () => {
    const trigger = await triggerService.createTrigger({
      pipelineId: "p-no-secret",
      type: "webhook",
      config: {},
      // No secret
      enabled: true,
    });

    const fired = firedPayloads.length;

    const res = await request(app)
      .post(`/api/webhooks/${trigger.id}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ event: "open-webhook" }));

    expect(res.status).toBe(200);
    expect(firedPayloads.length).toBe(fired + 1);
  });
});

// ─── POST /api/webhooks/:triggerId — disabled and missing trigger ─────────────

describe("POST /api/webhooks/:triggerId — disabled and missing trigger", () => {
  it("should return 404 when trigger is disabled", async () => {
    const { app, storage } = await createWebhookApp();
    const trigger = await seedRawTrigger(storage, { enabled: false });

    const res = await request(app)
      .post(`/api/webhooks/${trigger.id}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ event: "should-not-fire" }));

    expect(res.status).toBe(404);
  });

  it("should return 404 for a non-existent triggerId", async () => {
    const { app } = await createWebhookApp();

    const res = await request(app)
      .post("/api/webhooks/nonexistent-trigger-00000")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ event: "test" }));

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/webhooks/:triggerId — rate limiting ────────────────────────────

describe("POST /api/webhooks/:triggerId — rate limiting", () => {
  it("should return 429 when the rate limit (60 calls/min) is exceeded", async () => {
    const { app, triggerService } = await createWebhookApp();

    // Create an enabled trigger with no secret so we can hit it freely
    const trigger = await triggerService.createTrigger({
      pipelineId: "p-rate-limit",
      type: "webhook",
      config: {},
      enabled: true,
    });

    // Exhaust the 60-call rate limit
    const { checkRateLimit } = await import("../../server/services/webhook-handler.js");
    for (let i = 0; i < 60; i++) {
      checkRateLimit(trigger.id);
    }

    // The next actual HTTP request should be rate-limited
    const res = await request(app)
      .post(`/api/webhooks/${trigger.id}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ event: "test" }));

    expect(res.status).toBe(429);
  });
});

// ─── POST /api/webhooks/:triggerId — alternate signature header ───────────────

describe("POST /api/webhooks/:triggerId — alternate signature header", () => {
  it("should return 200 when using x-webhook-signature header with valid HMAC (plain hex)", async () => {
    const { app, triggerService } = await createWebhookApp();

    const trigger = await triggerService.createTrigger({
      pipelineId: "p-alt-header",
      type: "webhook",
      config: {},
      secret: "alt-secret",
      enabled: true,
    });

    const body = JSON.stringify({ event: "alt-header-test" });
    // Plain hex (no "sha256=" prefix) via x-webhook-signature
    const plainHex = createHmac("sha256", "alt-secret").update(body).digest("hex");

    const res = await request(app)
      .post(`/api/webhooks/${trigger.id}`)
      .set("Content-Type", "application/json")
      .set("x-webhook-signature", plainHex)
      .send(body);

    expect(res.status).toBe(200);
  });
});
