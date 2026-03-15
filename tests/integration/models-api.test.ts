/**
 * Integration tests for the models API routes (routes/models.ts).
 *
 * Endpoints covered:
 *   GET    /api/models          — returns all models
 *   GET    /api/models/active   — returns only active models
 *   GET    /api/models/:slug    — returns single model; 404 if not found
 *   POST   /api/models          — creates model; 400 on invalid body
 *   PATCH  /api/models/:id      — updates model; 400 on invalid; 404 if not found
 *   DELETE /api/models/:id      — 404 if not found; 204 on success
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";
import type { User } from "../../shared/types.js";
import type { MemStorage } from "../../server/storage.js";

// ─── Mock configLoader before any server module import ───────────────────────

const TEST_JWT_SECRET = "test-secret-minimum-32-chars-longxx";

vi.mock("../../server/config/loader.js", () => ({
  configLoader: {
    get: () => ({
      auth: { jwtSecret: TEST_JWT_SECRET, bcryptRounds: 4, sessionTtlDays: 1 },
      server: { nodeEnv: "test", port: 3000 },
      database: { url: undefined },
      providers: { anthropic: {}, google: {}, xai: {}, vllm: { endpoint: undefined }, ollama: { endpoint: undefined }, tavily: {} },
      features: {
        sandbox: { enabled: false },
        privacy: { enabled: true },
        maintenance: { enabled: false, cronSchedule: "0 2 * * *" },
      },
      encryption: {},
    }),
  },
}));

// ─── Mock authService for 401 tests ──────────────────────────────────────────

const VALID_TOKEN = "valid-models-bearer-token";

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

// ─── App factory ─────────────────────────────────────────────────────────────

async function createAuthenticatedApp() {
  const { MemStorage } = await import("../../server/storage.js");
  const { registerModelRoutes } = await import("../../server/routes/models.js");

  const storage = new MemStorage();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = TEST_ADMIN_USER;
    next();
  });
  registerModelRoutes(app, storage);

  return { app, storage };
}

async function createUnauthenticatedApp() {
  const { MemStorage } = await import("../../server/storage.js");
  const { registerModelRoutes } = await import("../../server/routes/models.js");
  const { requireAuth } = await import("../../server/auth/middleware.js");

  const storage = new MemStorage();
  const app = express();
  app.use(express.json());
  app.use("/api/models", requireAuth);
  registerModelRoutes(app, storage);

  return { app };
}

// ─── GET /api/models ──────────────────────────────────────────────────────────

describe("GET /api/models", () => {
  it("returns 200 with an empty array when no models exist", async () => {
    const { app } = await createAuthenticatedApp();
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("returns all models after creation", async () => {
    const { app, storage } = await createAuthenticatedApp();
    await storage.createModel({
      name: "Model A",
      slug: "model-a",
      provider: "mock",
      contextLimit: 4096,
      isActive: true,
      capabilities: [],
    });
    await storage.createModel({
      name: "Model B",
      slug: "model-b",
      provider: "mock",
      contextLimit: 8192,
      isActive: false,
      capabilities: [],
    });

    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect((res.body as unknown[]).length).toBe(2);
  });

  it("returns 401 when no auth token is provided", async () => {
    const { app } = await createUnauthenticatedApp();
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/models/active ───────────────────────────────────────────────────

describe("GET /api/models/active", () => {
  it("returns only active models", async () => {
    const { app, storage } = await createAuthenticatedApp();
    await storage.createModel({
      name: "Active Model",
      slug: "active-model",
      provider: "mock",
      contextLimit: 4096,
      isActive: true,
      capabilities: [],
    });
    await storage.createModel({
      name: "Inactive Model",
      slug: "inactive-model",
      provider: "mock",
      contextLimit: 4096,
      isActive: false,
      capabilities: [],
    });

    const res = await request(app).get("/api/models/active");
    expect(res.status).toBe(200);
    const models = res.body as Array<{ isActive: boolean; slug: string }>;
    expect(models.every((m) => m.isActive)).toBe(true);
    expect(models.some((m) => m.slug === "active-model")).toBe(true);
    expect(models.some((m) => m.slug === "inactive-model")).toBe(false);
  });

  it("returns 401 when no auth token is provided", async () => {
    const { app } = await createUnauthenticatedApp();
    const res = await request(app).get("/api/models/active");
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/models/:slug ────────────────────────────────────────────────────

describe("GET /api/models/:slug", () => {
  it("returns 404 for an unknown slug", async () => {
    const { app } = await createAuthenticatedApp();
    const res = await request(app).get("/api/models/no-such-model");
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBeTruthy();
  });

  it("returns 200 with the model when slug exists", async () => {
    const { app, storage } = await createAuthenticatedApp();
    await storage.createModel({
      name: "Slug Model",
      slug: "slug-model-test",
      provider: "anthropic",
      contextLimit: 200000,
      isActive: true,
      capabilities: ["vision"],
    });

    const res = await request(app).get("/api/models/slug-model-test");
    expect(res.status).toBe(200);
    const model = res.body as {
      slug: string;
      name: string;
      provider: string;
    };
    expect(model.slug).toBe("slug-model-test");
    expect(model.name).toBe("Slug Model");
    expect(model.provider).toBe("anthropic");
  });

  it("returns 401 when no auth token is provided", async () => {
    const { app } = await createUnauthenticatedApp();
    const res = await request(app).get("/api/models/some-slug");
    expect(res.status).toBe(401);
  });
});

// ─── POST /api/models ─────────────────────────────────────────────────────────

describe("POST /api/models", () => {
  let app: Express;
  let storage: MemStorage;

  beforeAll(async () => {
    const ctx = await createAuthenticatedApp();
    app = ctx.app;
    storage = ctx.storage;
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/api/models")
      .send({ slug: "test", provider: "mock" });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBeTruthy();
  });

  it("returns 400 when slug is missing", async () => {
    const res = await request(app)
      .post("/api/models")
      .send({ name: "Test Model", provider: "mock" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when provider is not a valid enum value", async () => {
    const res = await request(app)
      .post("/api/models")
      .send({ name: "Test", slug: "test-bad-provider", provider: "unknown-llm" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when contextLimit is not a positive integer", async () => {
    const res = await request(app)
      .post("/api/models")
      .send({ name: "Test", slug: "test-bad-ctx", provider: "mock", contextLimit: -1 });
    expect(res.status).toBe(400);
  });

  it("returns 201 with the created model on valid body", async () => {
    const res = await request(app).post("/api/models").send({
      name: "New Mock Model",
      slug: "new-mock-model",
      provider: "mock",
      contextLimit: 8192,
      isActive: true,
      capabilities: ["text"],
    });
    expect(res.status).toBe(201);
    const model = res.body as {
      id: string;
      slug: string;
      name: string;
      provider: string;
    };
    expect(model.id).toBeDefined();
    expect(model.slug).toBe("new-mock-model");
    expect(model.name).toBe("New Mock Model");
    expect(model.provider).toBe("mock");
  });

  it("returns 201 with defaults when optional fields are omitted", async () => {
    const res = await request(app).post("/api/models").send({
      name: "Minimal Model",
      slug: "minimal-model",
    });
    expect(res.status).toBe(201);
    const model = res.body as {
      provider: string;
      contextLimit: number;
      isActive: boolean;
    };
    expect(model.provider).toBe("mock");
    expect(model.contextLimit).toBe(4096);
    expect(model.isActive).toBe(true);
  });

  it("returns 401 when no auth token is provided", async () => {
    const { app: unauthApp } = await createUnauthenticatedApp();
    const res = await request(unauthApp)
      .post("/api/models")
      .send({ name: "X", slug: "x", provider: "mock" });
    expect(res.status).toBe(401);
  });
});

// ─── PATCH /api/models/:id ────────────────────────────────────────────────────

describe("PATCH /api/models/:id", () => {
  let app: Express;
  let storage: MemStorage;
  let modelId: string;

  beforeAll(async () => {
    const ctx = await createAuthenticatedApp();
    app = ctx.app;
    storage = ctx.storage;

    const model = await storage.createModel({
      name: "Patch Target",
      slug: "patch-target",
      provider: "mock",
      contextLimit: 4096,
      isActive: true,
      capabilities: [],
    });
    modelId = model.id;
  });

  it("returns 404 for a non-existent model ID", async () => {
    const res = await request(app)
      .patch("/api/models/nonexistent-id")
      .send({ name: "Updated" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when provider is an invalid enum value", async () => {
    const res = await request(app)
      .patch(`/api/models/${modelId}`)
      .send({ provider: "bad-provider-name" });
    expect(res.status).toBe(400);
  });

  it("returns 200 with updated model on valid partial update", async () => {
    const res = await request(app)
      .patch(`/api/models/${modelId}`)
      .send({ name: "Updated Name", contextLimit: 16384 });
    expect(res.status).toBe(200);
    const model = res.body as { name: string; contextLimit: number };
    expect(model.name).toBe("Updated Name");
    expect(model.contextLimit).toBe(16384);
  });

  it("returns 401 when no auth token is provided", async () => {
    const { app: unauthApp } = await createUnauthenticatedApp();
    const res = await request(unauthApp)
      .patch("/api/models/some-id")
      .send({ name: "X" });
    expect(res.status).toBe(401);
  });
});

// ─── DELETE /api/models/:id ───────────────────────────────────────────────────

describe("DELETE /api/models/:id", () => {
  it("returns 404 when the model does not exist", async () => {
    const { app } = await createAuthenticatedApp();
    const res = await request(app).delete("/api/models/nonexistent-id");
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBeTruthy();
  });

  it("returns 204 when the model is deleted successfully", async () => {
    const { app, storage } = await createAuthenticatedApp();
    const model = await storage.createModel({
      name: "To Delete",
      slug: "to-delete",
      provider: "mock",
      contextLimit: 4096,
      isActive: true,
      capabilities: [],
    });

    const res = await request(app).delete(`/api/models/${model.id}`);
    expect(res.status).toBe(204);
  });

  it("model is no longer returned after deletion", async () => {
    const { app, storage } = await createAuthenticatedApp();
    const model = await storage.createModel({
      name: "Gone Model",
      slug: "gone-model",
      provider: "mock",
      contextLimit: 4096,
      isActive: true,
      capabilities: [],
    });

    await request(app).delete(`/api/models/${model.id}`);

    const listRes = await request(app).get("/api/models");
    const models = listRes.body as Array<{ id: string }>;
    expect(models.find((m) => m.id === model.id)).toBeUndefined();
  });

  it("returns 401 when no auth token is provided", async () => {
    const { app } = await createUnauthenticatedApp();
    const res = await request(app).delete("/api/models/some-id");
    expect(res.status).toBe(401);
  });
});
