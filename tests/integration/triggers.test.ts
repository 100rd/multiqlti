/**
 * Integration tests for the trigger CRUD API routes (routes/triggers.ts).
 *
 * Endpoints covered:
 *   GET    /api/pipelines/:pipelineId/triggers  — list triggers for a pipeline
 *   POST   /api/pipelines/:pipelineId/triggers  — create trigger; 400 on invalid; 401 without auth
 *   GET    /api/triggers/:id                    — get single trigger; 404 for unknown; 401 without auth
 *   PATCH  /api/triggers/:id                    — update; 400 on invalid config; 404 if not found
 *   DELETE /api/triggers/:id                    — 204 on success; 404 for unknown
 *   POST   /api/triggers/:id/enable             — 200, trigger.enabled = true
 *   POST   /api/triggers/:id/disable            — 200, trigger.enabled = false
 *
 * Auth: POST/PATCH/DELETE/enable/disable return 401 when no user is set.
 *
 * TriggerCrypto is mocked to avoid requiring TRIGGER_SECRET_KEY in the test env.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";
import type { User } from "../../shared/types.js";

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

// ─── Mock TriggerCrypto to avoid TRIGGER_SECRET_KEY requirement ───────────────
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

// ─── Mock authService ─────────────────────────────────────────────────────────

const VALID_TOKEN = "valid-triggers-bearer-token";

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
    validateToken: vi.fn(async (token: string) =>
      token === VALID_TOKEN ? TEST_ADMIN_USER : null,
    ),
  },
}));

// ─── App factory helpers ──────────────────────────────────────────────────────

async function createAuthenticatedApp() {
  const { MemStorage } = await import("../../server/storage.js");
  const { TriggerService } = await import("../../server/services/trigger-service.js");
  const { registerTriggerRoutes } = await import("../../server/routes/triggers.js");

  const storage = new MemStorage();
  const triggerService = new TriggerService(storage);

  const app = express();
  app.use(express.json());
  // Inject synthetic admin user — bypasses real auth so RBAC middleware passes
  app.use((req, _res, next) => {
    req.user = TEST_ADMIN_USER;
    next();
  });

  registerTriggerRoutes(app as never, triggerService, storage);

  return { app, storage, triggerService };
}

async function createUnauthenticatedApp() {
  const { MemStorage } = await import("../../server/storage.js");
  const { TriggerService } = await import("../../server/services/trigger-service.js");
  const { registerTriggerRoutes } = await import("../../server/routes/triggers.js");
  const { requireAuth } = await import("../../server/auth/middleware.js");

  const storage = new MemStorage();
  const triggerService = new TriggerService(storage);

  const app = express();
  app.use(express.json());
  // No synthetic user injected — requireAuth will return 401
  app.use("/api/pipelines", requireAuth);
  app.use("/api/triggers", requireAuth);

  registerTriggerRoutes(app as never, triggerService, storage);

  return { app };
}

/** Helper: create a pipeline in MemStorage so the trigger FK is satisfiable. */
async function seedPipeline(storage: Awaited<ReturnType<typeof createAuthenticatedApp>>["storage"]): Promise<string> {
  const pipeline = await storage.createPipeline({
    name: "Test Pipeline",
    description: "For trigger tests",
    stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
    isTemplate: false,
  });
  return pipeline.id;
}

// ─── GET /api/pipelines/:pipelineId/triggers ──────────────────────────────────

describe("GET /api/pipelines/:pipelineId/triggers", () => {
  it("should return 200 with empty array when no triggers exist for a pipeline", async () => {
    const { app, storage } = await createAuthenticatedApp();
    const pipelineId = await seedPipeline(storage);

    const res = await request(app).get(`/api/pipelines/${pipelineId}/triggers`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as unknown[]).length).toBe(0);
  });

  it("should return 200 with triggers filtered by pipelineId", async () => {
    const { app, storage, triggerService } = await createAuthenticatedApp();
    const pipelineId = await seedPipeline(storage);
    const otherPipelineId = await seedPipeline(storage);

    await triggerService.createTrigger({
      pipelineId,
      type: "webhook",
      config: {},
      enabled: true,
    });
    await triggerService.createTrigger({
      pipelineId: otherPipelineId,
      type: "webhook",
      config: {},
      enabled: true,
    });

    const res = await request(app).get(`/api/pipelines/${pipelineId}/triggers`);
    expect(res.status).toBe(200);
    const triggers = res.body as Array<{ pipelineId: string }>;
    expect(triggers.length).toBe(1);
    expect(triggers[0].pipelineId).toBe(pipelineId);
  });
});

// ─── POST /api/pipelines/:pipelineId/triggers ─────────────────────────────────

describe("POST /api/pipelines/:pipelineId/triggers", () => {
  let app: Express;
  let storage: Awaited<ReturnType<typeof createAuthenticatedApp>>["storage"];
  let pipelineId: string;

  beforeAll(async () => {
    const ctx = await createAuthenticatedApp();
    app = ctx.app;
    storage = ctx.storage;
    pipelineId = await seedPipeline(storage);
  });

  it("should return 201 with the created trigger on valid webhook body", async () => {
    const res = await request(app)
      .post(`/api/pipelines/${pipelineId}/triggers`)
      .send({ type: "webhook", config: {} });

    expect(res.status).toBe(201);
    const trigger = res.body as {
      id: string;
      pipelineId: string;
      type: string;
      enabled: boolean;
      webhookUrl: string;
      hasSecret: boolean;
    };
    expect(trigger.id).toBeDefined();
    expect(trigger.pipelineId).toBe(pipelineId);
    expect(trigger.type).toBe("webhook");
    expect(trigger.enabled).toBe(true);
    expect(trigger.webhookUrl).toContain("/api/webhooks/");
    expect(trigger.hasSecret).toBe(false);
  });

  it("should return 201 with hasSecret=true when secret is provided", async () => {
    const res = await request(app)
      .post(`/api/pipelines/${pipelineId}/triggers`)
      .send({ type: "webhook", config: {}, secret: "super-secret-1234" });

    expect(res.status).toBe(201);
    const trigger = res.body as { hasSecret: boolean };
    expect(trigger.hasSecret).toBe(true);
  });

  it("should return 201 for a valid schedule trigger with cron expression", async () => {
    const res = await request(app)
      .post(`/api/pipelines/${pipelineId}/triggers`)
      .send({
        type: "schedule",
        config: { cron: "0 9 * * 1" },
      });

    expect(res.status).toBe(201);
    const trigger = res.body as { type: string; config: { cron: string } };
    expect(trigger.type).toBe("schedule");
    expect(trigger.config.cron).toBe("0 9 * * 1");
  });

  it("should return 201 for a valid github_event trigger", async () => {
    const res = await request(app)
      .post(`/api/pipelines/${pipelineId}/triggers`)
      .send({
        type: "github_event",
        config: {
          repository: "owner/repo",
          events: ["push", "pull_request"],
        },
      });

    expect(res.status).toBe(201);
    const trigger = res.body as { type: string };
    expect(trigger.type).toBe("github_event");
  });

  it("should return 400 when type is missing", async () => {
    const res = await request(app)
      .post(`/api/pipelines/${pipelineId}/triggers`)
      .send({ config: {} });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBeTruthy();
  });

  it("should return 400 when type is not a valid trigger type", async () => {
    const res = await request(app)
      .post(`/api/pipelines/${pipelineId}/triggers`)
      .send({ type: "unknown_type", config: {} });

    expect(res.status).toBe(400);
  });

  it("should return 400 when schedule trigger has missing cron field", async () => {
    const res = await request(app)
      .post(`/api/pipelines/${pipelineId}/triggers`)
      .send({ type: "schedule", config: {} });

    expect(res.status).toBe(400);
  });

  it("should return 400 when github_event trigger has empty events array", async () => {
    const res = await request(app)
      .post(`/api/pipelines/${pipelineId}/triggers`)
      .send({
        type: "github_event",
        config: { repository: "owner/repo", events: [] },
      });

    expect(res.status).toBe(400);
  });

  it("should return 400 when github_event trigger has malformed repository (no slash)", async () => {
    const res = await request(app)
      .post(`/api/pipelines/${pipelineId}/triggers`)
      .send({
        type: "github_event",
        config: { repository: "notavalidrepo", events: ["push"] },
      });

    expect(res.status).toBe(400);
  });

  it("should return 400 when file_change trigger has missing watchPath", async () => {
    const res = await request(app)
      .post(`/api/pipelines/${pipelineId}/triggers`)
      .send({ type: "file_change", config: {} });

    expect(res.status).toBe(400);
  });

  it("should return 201 with enabled=false when explicitly set to false", async () => {
    const res = await request(app)
      .post(`/api/pipelines/${pipelineId}/triggers`)
      .send({ type: "webhook", config: {}, enabled: false });

    expect(res.status).toBe(201);
    const trigger = res.body as { enabled: boolean };
    expect(trigger.enabled).toBe(false);
  });

  it("should return 401 when no auth token is provided", async () => {
    const { app: unauthApp } = await createUnauthenticatedApp();
    const res = await request(unauthApp)
      .post(`/api/pipelines/${pipelineId}/triggers`)
      .send({ type: "webhook", config: {} });

    expect(res.status).toBe(401);
  });
});

// ─── GET /api/triggers/:id ────────────────────────────────────────────────────

describe("GET /api/triggers/:id", () => {
  it("should return 200 with the trigger when it exists", async () => {
    const { app, storage, triggerService } = await createAuthenticatedApp();
    const pipelineId = await seedPipeline(storage);

    const created = await triggerService.createTrigger({
      pipelineId,
      type: "webhook",
      config: {},
    });

    const res = await request(app).get(`/api/triggers/${created.id}`);
    expect(res.status).toBe(200);
    const trigger = res.body as { id: string; type: string };
    expect(trigger.id).toBe(created.id);
    expect(trigger.type).toBe("webhook");
  });

  it("should return 404 for a non-existent trigger id", async () => {
    const { app } = await createAuthenticatedApp();
    const res = await request(app).get("/api/triggers/nonexistent-id-00000");
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBeTruthy();
  });

  it("should return 401 when no auth token is provided", async () => {
    const { app } = await createUnauthenticatedApp();
    const res = await request(app).get("/api/triggers/some-trigger-id");
    expect(res.status).toBe(401);
  });
});

// ─── PATCH /api/triggers/:id ──────────────────────────────────────────────────

describe("PATCH /api/triggers/:id", () => {
  it("should return 200 and update enabled flag", async () => {
    const { app, storage, triggerService } = await createAuthenticatedApp();
    const pipelineId = await seedPipeline(storage);
    const created = await triggerService.createTrigger({
      pipelineId,
      type: "webhook",
      config: {},
      enabled: true,
    });

    const res = await request(app)
      .patch(`/api/triggers/${created.id}`)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    const trigger = res.body as { enabled: boolean };
    expect(trigger.enabled).toBe(false);
  });

  it("should return 200 and update the cron expression for a schedule trigger", async () => {
    const { app, storage, triggerService } = await createAuthenticatedApp();
    const pipelineId = await seedPipeline(storage);
    const created = await triggerService.createTrigger({
      pipelineId,
      type: "schedule",
      config: { cron: "0 9 * * 1" },
    });

    const res = await request(app)
      .patch(`/api/triggers/${created.id}`)
      .send({ type: "schedule", config: { cron: "0 12 * * *" } });

    expect(res.status).toBe(200);
    const trigger = res.body as { config: { cron: string } };
    expect(trigger.config.cron).toBe("0 12 * * *");
  });

  it("should return 400 when updating a schedule trigger with invalid config (missing cron)", async () => {
    const { app, storage, triggerService } = await createAuthenticatedApp();
    const pipelineId = await seedPipeline(storage);
    const created = await triggerService.createTrigger({
      pipelineId,
      type: "schedule",
      config: { cron: "0 9 * * 1" },
    });

    const res = await request(app)
      .patch(`/api/triggers/${created.id}`)
      .send({ type: "schedule", config: {} });

    expect(res.status).toBe(400);
  });

  it("should return 404 when patching a non-existent trigger", async () => {
    const { app } = await createAuthenticatedApp();
    const res = await request(app)
      .patch("/api/triggers/nonexistent-00000")
      .send({ enabled: true });

    expect(res.status).toBe(404);
  });

  it("should return 401 when no auth token is provided", async () => {
    const { app } = await createUnauthenticatedApp();
    const res = await request(app)
      .patch("/api/triggers/some-trigger-id")
      .send({ enabled: false });

    expect(res.status).toBe(401);
  });
});

// ─── DELETE /api/triggers/:id ─────────────────────────────────────────────────

describe("DELETE /api/triggers/:id", () => {
  it("should return 204 when the trigger is deleted successfully", async () => {
    const { app, storage, triggerService } = await createAuthenticatedApp();
    const pipelineId = await seedPipeline(storage);
    const created = await triggerService.createTrigger({
      pipelineId,
      type: "webhook",
      config: {},
    });

    const res = await request(app).delete(`/api/triggers/${created.id}`);
    expect(res.status).toBe(204);

    // Verify it no longer exists
    const getRes = await request(app).get(`/api/triggers/${created.id}`);
    expect(getRes.status).toBe(404);
  });

  it("should return 404 when deleting a non-existent trigger", async () => {
    const { app } = await createAuthenticatedApp();
    const res = await request(app).delete("/api/triggers/nonexistent-00000");
    expect(res.status).toBe(404);
  });

  it("should return 401 when no auth token is provided", async () => {
    const { app } = await createUnauthenticatedApp();
    const res = await request(app).delete("/api/triggers/some-trigger-id");
    expect(res.status).toBe(401);
  });
});

// ─── POST /api/triggers/:id/enable ───────────────────────────────────────────

describe("POST /api/triggers/:id/enable", () => {
  it("should return 200 with trigger.enabled = true", async () => {
    const { app, storage, triggerService } = await createAuthenticatedApp();
    const pipelineId = await seedPipeline(storage);
    const created = await triggerService.createTrigger({
      pipelineId,
      type: "webhook",
      config: {},
      enabled: false,
    });

    const res = await request(app).post(`/api/triggers/${created.id}/enable`);
    expect(res.status).toBe(200);
    const trigger = res.body as { enabled: boolean };
    expect(trigger.enabled).toBe(true);
  });

  it("should return 404 for a non-existent trigger", async () => {
    const { app } = await createAuthenticatedApp();
    const res = await request(app).post("/api/triggers/nonexistent-00000/enable");
    expect(res.status).toBe(404);
  });

  it("should return 401 when no auth token is provided", async () => {
    const { app } = await createUnauthenticatedApp();
    const res = await request(app).post("/api/triggers/some-id/enable");
    expect(res.status).toBe(401);
  });
});

// ─── POST /api/triggers/:id/disable ──────────────────────────────────────────

describe("POST /api/triggers/:id/disable", () => {
  it("should return 200 with trigger.enabled = false", async () => {
    const { app, storage, triggerService } = await createAuthenticatedApp();
    const pipelineId = await seedPipeline(storage);
    const created = await triggerService.createTrigger({
      pipelineId,
      type: "webhook",
      config: {},
      enabled: true,
    });

    const res = await request(app).post(`/api/triggers/${created.id}/disable`);
    expect(res.status).toBe(200);
    const trigger = res.body as { enabled: boolean };
    expect(trigger.enabled).toBe(false);
  });

  it("should return 404 for a non-existent trigger", async () => {
    const { app } = await createAuthenticatedApp();
    const res = await request(app).post("/api/triggers/nonexistent-00000/disable");
    expect(res.status).toBe(404);
  });

  it("should return 401 when no auth token is provided", async () => {
    const { app } = await createUnauthenticatedApp();
    const res = await request(app).post("/api/triggers/some-id/disable");
    expect(res.status).toBe(401);
  });
});

// ─── Edge case: Two triggers for the same pipeline ────────────────────────────

describe("Multiple triggers for the same pipeline", () => {
  it("should list all triggers independently — two webhook triggers both appear", async () => {
    const { app, storage, triggerService } = await createAuthenticatedApp();
    const pipelineId = await seedPipeline(storage);

    const t1 = await triggerService.createTrigger({
      pipelineId,
      type: "webhook",
      config: {},
    });
    const t2 = await triggerService.createTrigger({
      pipelineId,
      type: "schedule",
      config: { cron: "*/5 * * * *" },
    });

    const res = await request(app).get(`/api/pipelines/${pipelineId}/triggers`);
    expect(res.status).toBe(200);
    const triggers = res.body as Array<{ id: string }>;
    expect(triggers.length).toBe(2);
    const ids = triggers.map((t) => t.id);
    expect(ids).toContain(t1.id);
    expect(ids).toContain(t2.id);
  });
});

// ─── Edge case: schedule trigger cron validation ──────────────────────────────

describe("Schedule trigger edge cases", () => {
  it("should accept cron '* * * * *' (every minute) as valid", async () => {
    const { app, storage } = await createAuthenticatedApp();
    const pipelineId = await seedPipeline(storage);

    const res = await request(app)
      .post(`/api/pipelines/${pipelineId}/triggers`)
      .send({ type: "schedule", config: { cron: "* * * * *" } });

    expect(res.status).toBe(201);
  });

  it("should return 400 when cron is an empty string", async () => {
    const { app, storage } = await createAuthenticatedApp();
    const pipelineId = await seedPipeline(storage);

    const res = await request(app)
      .post(`/api/pipelines/${pipelineId}/triggers`)
      .send({ type: "schedule", config: { cron: "" } });

    expect(res.status).toBe(400);
  });
});
