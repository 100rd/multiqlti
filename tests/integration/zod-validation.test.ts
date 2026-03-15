/**
 * Zod validation integration tests.
 *
 * Verifies that every POST/PUT/PATCH route that has Zod body validation:
 *   1. Returns 400 with field-level errors when the body is invalid.
 *   2. Passes through successfully when the body is valid.
 *
 * Chat routes are tested against a minimal Express app because the full
 * createTestApp() does not register chat routes (it is a purely in-memory
 * pipeline-focused helper).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { createTestApp } from "../helpers/test-app.js";
import { registerChatRoutes } from "../../server/routes/chat.js";
import { registerStrategyRoutes } from "../../server/routes/strategies.js";
import type { TestApp } from "../helpers/test-app.js";

// ─── Minimal chat-app fixture ────────────────────────────────────────────────

function createChatApp() {
  const app = express();
  app.use(express.json());

  // Stub gateway and wsManager — chat routes call gateway.complete / stream
  // but our validation tests short-circuit before that via 400 responses.
  // For the "valid body passes through" tests we need them to resolve.
  const stubGateway = {
    complete: async () => ({ content: "ok", tokensUsed: 1 }),
    stream: async function* () { yield "chunk"; },
  };
  const stubWsManager = { broadcastToRun: () => {} };
  const stubStorage = {
    getChatMessages: async () => [],
    createChatMessage: async (msg: Record<string, unknown>) => ({ id: "msg-1", ...msg }),
  };

  registerChatRoutes(
    app as unknown as import("express").Router & ReturnType<typeof express>,
    stubStorage as never,
    stubGateway as never,
    stubWsManager as never,
  );

  return app;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type ValidationError = { error: string; issues?: Array<{ path: unknown[]; message: string }> };

function expectValidationFailure(body: unknown) {
  const b = body as ValidationError;
  // Our middleware returns { error: "Validation failed", issues: [...] }
  // or Zod's own error string from older routes.
  expect(b.error).toBeTruthy();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Zod validation — POST /api/pipelines", () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(testApp.app)
      .post("/api/pipelines")
      .send({ stages: [] });
    expect(res.status).toBe(400);
    expectValidationFailure(res.body);
  });

  it("returns 400 when name is empty string", async () => {
    const res = await request(testApp.app)
      .post("/api/pipelines")
      .send({ name: "", stages: [] });
    expect(res.status).toBe(400);
  });

  it("passes through with valid body (201)", async () => {
    const res = await request(testApp.app)
      .post("/api/pipelines")
      .send({ name: "Valid Pipeline", stages: [] });
    expect(res.status).toBe(201);
    expect((res.body as { name: string }).name).toBe("Valid Pipeline");
  });
});

describe("Zod validation — PATCH /api/pipelines/:id", () => {
  let testApp: TestApp;
  let pipelineId: string;

  beforeAll(async () => {
    testApp = await createTestApp();
    const res = await request(testApp.app)
      .post("/api/pipelines")
      .send({ name: "Patch Target", stages: [] });
    pipelineId = (res.body as { id: string }).id;
  });

  afterAll(async () => {
    await testApp.close();
  });

  it("returns 400 when name is too long (>100 chars)", async () => {
    const res = await request(testApp.app)
      .patch(`/api/pipelines/${pipelineId}`)
      .send({ name: "x".repeat(101) });
    expect(res.status).toBe(400);
    expectValidationFailure(res.body);
  });

  it("passes through with valid partial body (200)", async () => {
    const res = await request(testApp.app)
      .patch(`/api/pipelines/${pipelineId}`)
      .send({ name: "Updated Name" });
    expect(res.status).toBe(200);
    expect((res.body as { name: string }).name).toBe("Updated Name");
  });
});

describe("Zod validation — POST /api/runs", () => {
  let testApp: TestApp;
  let pipelineId: string;

  beforeAll(async () => {
    testApp = await createTestApp();
    const res = await request(testApp.app)
      .post("/api/pipelines")
      .send({ name: "Run Target", stages: [] });
    pipelineId = (res.body as { id: string }).id;
  });

  afterAll(async () => {
    await testApp.close();
  });

  it("returns 400 when pipelineId is missing", async () => {
    const res = await request(testApp.app)
      .post("/api/runs")
      .send({ input: "hello" });
    expect(res.status).toBe(400);
    expectValidationFailure(res.body);
  });

  it("returns 400 when input is missing", async () => {
    const res = await request(testApp.app)
      .post("/api/runs")
      .send({ pipelineId });
    expect(res.status).toBe(400);
    expectValidationFailure(res.body);
  });

  it("returns 400 when input is empty string", async () => {
    const res = await request(testApp.app)
      .post("/api/runs")
      .send({ pipelineId, input: "" });
    expect(res.status).toBe(400);
    expectValidationFailure(res.body);
  });

  it("passes validation with valid body (pipeline not found → 400 from controller, not validation)", async () => {
    // With a valid pipelineId that doesn't exist, validation passes
    // and the controller returns 400 "Pipeline not found" (not a validation error)
    const res = await request(testApp.app)
      .post("/api/runs")
      .send({ pipelineId: "nonexistent-id", input: "some input" });
    // Validation passes, controller returns 400 with a different error
    expect(res.status).toBe(400);
    const body = res.body as { error: string };
    // Should NOT be a validation error — it should be a controller error
    expect(body.error).toMatch(/not found|pipeline/i);
  });
});

describe("Zod validation — POST /api/models", () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(testApp.app)
      .post("/api/models")
      .send({ slug: "test-slug", provider: "mock" });
    expect(res.status).toBe(400);
    expectValidationFailure(res.body);
  });

  it("returns 400 when slug is missing", async () => {
    const res = await request(testApp.app)
      .post("/api/models")
      .send({ name: "Test Model", provider: "mock" });
    expect(res.status).toBe(400);
    expectValidationFailure(res.body);
  });

  it("returns 400 when provider is unknown", async () => {
    const res = await request(testApp.app)
      .post("/api/models")
      .send({ name: "Test", slug: "test", provider: "unknown-provider" });
    expect(res.status).toBe(400);
    expectValidationFailure(res.body);
  });

  it("passes through with valid body (201)", async () => {
    const res = await request(testApp.app)
      .post("/api/models")
      .send({ name: "New Model", slug: "new-model", provider: "mock" });
    expect(res.status).toBe(201);
    expect((res.body as { slug: string }).slug).toBe("new-model");
  });
});

describe("Zod validation — PATCH /api/models/:id", () => {
  let testApp: TestApp;
  let modelId: string;

  beforeAll(async () => {
    testApp = await createTestApp();
    const res = await request(testApp.app)
      .post("/api/models")
      .send({ name: "Patch Model", slug: "patch-model", provider: "mock" });
    modelId = (res.body as { id: string }).id;
  });

  afterAll(async () => {
    await testApp.close();
  });

  it("returns 400 when provider is invalid", async () => {
    const res = await request(testApp.app)
      .patch(`/api/models/${modelId}`)
      .send({ provider: "bad-provider" });
    expect(res.status).toBe(400);
    expectValidationFailure(res.body);
  });

  it("passes through with valid partial update (200)", async () => {
    const res = await request(testApp.app)
      .patch(`/api/models/${modelId}`)
      .send({ name: "Updated Model Name" });
    expect(res.status).toBe(200);
    expect((res.body as { name: string }).name).toBe("Updated Model Name");
  });
});

describe("Zod validation — PATCH /api/pipelines/:id/stages/:stageIndex/strategy", () => {
  let app: express.Express;
  let pipelineId: string;
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
    app = testApp.app;
    registerStrategyRoutes(app as unknown as import("express").Router & ReturnType<typeof express>, testApp.storage);

    const res = await request(app)
      .post("/api/pipelines")
      .send({
        name: "Strategy Pipeline",
        stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
      });
    pipelineId = (res.body as { id: string }).id;
  });

  afterAll(async () => {
    await testApp.close();
  });

  it("returns 400 when strategy type is invalid", async () => {
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}/stages/0/strategy`)
      .send({ type: "invalid-type" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when moa strategy is missing proposers", async () => {
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}/stages/0/strategy`)
      .send({ type: "moa", aggregator: { modelSlug: "mock" } });
    expect(res.status).toBe(400);
  });

  it("passes through with valid single strategy (200)", async () => {
    const res = await request(app)
      .patch(`/api/pipelines/${pipelineId}/stages/0/strategy`)
      .send({ type: "single" });
    expect(res.status).toBe(200);
  });
});

describe("Zod validation — POST /api/chat/:runId/messages", () => {
  it("returns 400 when content is missing", async () => {
    const app = createChatApp();
    const res = await request(app)
      .post("/api/chat/run-123/messages")
      .send({ modelSlug: "mock" });
    expect(res.status).toBe(400);
    expectValidationFailure(res.body);
  });

  it("returns 400 when content is empty string", async () => {
    const app = createChatApp();
    const res = await request(app)
      .post("/api/chat/run-123/messages")
      .send({ content: "" });
    expect(res.status).toBe(400);
    expectValidationFailure(res.body);
  });

  it("passes through with valid body", async () => {
    const app = createChatApp();
    const res = await request(app)
      .post("/api/chat/run-123/messages")
      .send({ content: "Hello!" });
    expect(res.status).toBe(200);
  });
});

describe("Zod validation — POST /api/chat/standalone", () => {
  it("returns 400 when content is missing", async () => {
    const app = createChatApp();
    const res = await request(app)
      .post("/api/chat/standalone")
      .send({ modelSlug: "mock" });
    expect(res.status).toBe(400);
    expectValidationFailure(res.body);
  });

  it("returns 400 when content is empty", async () => {
    const app = createChatApp();
    const res = await request(app)
      .post("/api/chat/standalone")
      .send({ content: "" });
    expect(res.status).toBe(400);
  });

  it("passes through with valid body and optional history", async () => {
    const app = createChatApp();
    const res = await request(app)
      .post("/api/chat/standalone")
      .send({
        content: "Tell me something",
        history: [{ role: "user", content: "Hi" }],
      });
    expect(res.status).toBe(200);
  });
});

describe("Zod validation — POST /api/chat/stream", () => {
  it("returns 400 when content is missing", async () => {
    const app = createChatApp();
    const res = await request(app)
      .post("/api/chat/stream")
      .send({});
    expect(res.status).toBe(400);
    expectValidationFailure(res.body);
  });

  it("accepts valid content and returns SSE headers", async () => {
    const app = createChatApp();
    const res = await request(app)
      .post("/api/chat/stream")
      .send({ content: "Stream me" });
    // SSE endpoint returns 200 with text/event-stream
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
  });
});
