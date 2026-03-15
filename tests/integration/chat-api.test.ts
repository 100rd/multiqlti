/**
 * Integration tests for the chat API routes (routes/chat.ts).
 *
 * Endpoints covered:
 *   GET  /api/chat/:runId/messages  — returns messages array
 *   POST /api/chat/:runId/messages  — add message; 400 on missing content
 *   POST /api/chat/standalone       — standalone chat; 400 on missing content
 *
 * Auth: 401 on all endpoints when no token is provided.
 * The tests for 404 (non-existent runId) are omitted because the route does
 * not validate run existence — it delegates to storage.getChatMessages which
 * returns [] for unknown runIds rather than throwing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
      providers: { anthropic: {}, google: {}, xai: {} },
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

const VALID_TOKEN = "valid-chat-bearer-token";

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

// ─── App factories ────────────────────────────────────────────────────────────

async function createAuthenticatedApp() {
  const { MemStorage } = await import("../../server/storage.js");
  const { registerChatRoutes } = await import("../../server/routes/chat.js");

  const storage = new MemStorage();

  // Stub gateway: complete returns a fixed response, stream yields one chunk
  const stubGateway = {
    complete: async () => ({ content: "Test response", tokensUsed: 10 }),
    stream: async function* () {
      yield "chunk";
    },
  };

  const stubWsManager = {
    broadcastToRun: () => {
      // intentional no-op
    },
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = TEST_ADMIN_USER;
    next();
  });

  registerChatRoutes(
    app as never,
    storage,
    stubGateway as never,
    stubWsManager as never,
  );

  return { app, storage };
}

async function createUnauthenticatedApp() {
  const { MemStorage } = await import("../../server/storage.js");
  const { registerChatRoutes } = await import("../../server/routes/chat.js");
  const { requireAuth } = await import("../../server/auth/middleware.js");

  const storage = new MemStorage();

  const stubGateway = {
    complete: async () => ({ content: "ok", tokensUsed: 1 }),
    stream: async function* () {
      yield "chunk";
    },
  };

  const stubWsManager = {
    broadcastToRun: () => {
      // intentional no-op
    },
  };

  const app = express();
  app.use(express.json());
  app.use("/api/chat", requireAuth);
  registerChatRoutes(
    app as never,
    storage,
    stubGateway as never,
    stubWsManager as never,
  );

  return { app };
}

// ─── GET /api/chat/:runId/messages ────────────────────────────────────────────

describe("GET /api/chat/:runId/messages", () => {
  let app: Express;

  beforeAll(async () => {
    const ctx = await createAuthenticatedApp();
    app = ctx.app;
  });

  it("returns 200 with an empty array for a run with no messages", async () => {
    const res = await request(app).get("/api/chat/nonexistent-run/messages");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as unknown[]).length).toBe(0);
  });

  it("returns messages after they are created for a run", async () => {
    const ctx = await createAuthenticatedApp();
    await ctx.storage.createChatMessage({
      runId: "run-with-msgs",
      role: "user",
      content: "Hello agent",
    });

    const res = await request(ctx.app).get(
      "/api/chat/run-with-msgs/messages",
    );
    expect(res.status).toBe(200);
    const messages = res.body as Array<{ role: string; content: string }>;
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello agent");
  });

  it("honours the limit query parameter", async () => {
    const ctx = await createAuthenticatedApp();
    for (let i = 0; i < 5; i++) {
      await ctx.storage.createChatMessage({
        runId: "run-limit-test",
        role: "user",
        content: `Message ${i}`,
      });
    }

    const res = await request(ctx.app).get(
      "/api/chat/run-limit-test/messages?limit=3",
    );
    expect(res.status).toBe(200);
    expect((res.body as unknown[]).length).toBeLessThanOrEqual(3);
  });

  it("returns 401 when no auth token is provided", async () => {
    const ctx = await createUnauthenticatedApp();
    const res = await request(ctx.app).get("/api/chat/some-run/messages");
    expect(res.status).toBe(401);
  });
});

// ─── POST /api/chat/:runId/messages ──────────────────────────────────────────

describe("POST /api/chat/:runId/messages", () => {
  let app: Express;

  beforeAll(async () => {
    const ctx = await createAuthenticatedApp();
    app = ctx.app;
  });

  it("returns 400 when content is missing", async () => {
    const res = await request(app)
      .post("/api/chat/run-123/messages")
      .send({ modelSlug: "mock" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when content is an empty string", async () => {
    const res = await request(app)
      .post("/api/chat/run-123/messages")
      .send({ content: "" });
    expect(res.status).toBe(400);
  });

  it("returns 200 with userMessage and assistantMessage on valid body", async () => {
    const res = await request(app)
      .post("/api/chat/run-chat-test/messages")
      .send({ content: "What is 2+2?" });
    expect(res.status).toBe(200);

    const body = res.body as {
      userMessage: { role: string; content: string };
      assistantMessage: { role: string; content: string };
    };
    expect(body.userMessage).toBeDefined();
    expect(body.userMessage.role).toBe("user");
    expect(body.userMessage.content).toBe("What is 2+2?");
    expect(body.assistantMessage).toBeDefined();
    expect(body.assistantMessage.content).toBeTruthy();
  });

  it("returns 401 when no auth token is provided", async () => {
    const ctx = await createUnauthenticatedApp();
    const res = await request(ctx.app)
      .post("/api/chat/run-123/messages")
      .send({ content: "hello" });
    expect(res.status).toBe(401);
  });
});

// ─── POST /api/chat/standalone ───────────────────────────────────────────────

describe("POST /api/chat/standalone", () => {
  let app: Express;

  beforeAll(async () => {
    const ctx = await createAuthenticatedApp();
    app = ctx.app;
  });

  it("returns 400 when content is missing", async () => {
    const res = await request(app).post("/api/chat/standalone").send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 when content is an empty string", async () => {
    const res = await request(app)
      .post("/api/chat/standalone")
      .send({ content: "" });
    expect(res.status).toBe(400);
  });

  it("returns 200 with content, modelSlug and tokensUsed on valid body", async () => {
    const res = await request(app)
      .post("/api/chat/standalone")
      .send({ content: "Tell me a joke" });
    expect(res.status).toBe(200);

    const body = res.body as {
      content: string;
      modelSlug: string;
      tokensUsed: number;
    };
    expect(body.content).toBeTruthy();
    expect(typeof body.modelSlug).toBe("string");
    expect(typeof body.tokensUsed).toBe("number");
  });

  it("accepts optional history array", async () => {
    const res = await request(app)
      .post("/api/chat/standalone")
      .send({
        content: "Continue the story",
        history: [
          { role: "user", content: "Once upon a time" },
          { role: "assistant", content: "There was a dragon" },
        ],
      });
    expect(res.status).toBe(200);
  });

  it("returns 401 when no auth token is provided", async () => {
    const ctx = await createUnauthenticatedApp();
    const res = await request(ctx.app)
      .post("/api/chat/standalone")
      .send({ content: "hello" });
    expect(res.status).toBe(401);
  });
});
