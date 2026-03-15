/**
 * Integration test: /api/mcp routes require authentication.
 *
 * This test registers the requireAuth middleware on /api/mcp and then
 * registers the tool routes (which include /api/mcp/servers). It verifies:
 *   - GET /api/mcp/servers returns 401 without an auth token
 *   - GET /api/mcp/servers returns 200 when a valid session token is provided
 *
 * We mock authService and configLoader to avoid any DB dependency.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";
import type { User } from "../../shared/types.js";

// ─── Mock configLoader before any server modules are imported ─────────────────

const TEST_JWT_SECRET = "test-secret-minimum-32-characters-long-xx";

vi.mock("../../server/config/loader.js", () => ({
  configLoader: {
    get: () => ({
      auth: {
        jwtSecret: TEST_JWT_SECRET,
        bcryptRounds: 4,
        sessionTtlDays: 1,
      },
      server: { nodeEnv: "test", port: 3000, host: "localhost" },
      database: { url: undefined },
      providers: { anthropic: {}, google: {}, xai: {} },
    }),
  },
}));

// Mock authService so we control token validation without a real DB
const TEST_USER: User = {
  id: "mcp-test-user",
  email: "mcp@test.com",
  name: "MCP Test User",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

const VALID_TOKEN = "valid-bearer-token";

vi.mock("../../server/auth/service.js", () => ({
  authService: {
    validateToken: vi.fn(async (token: string) => {
      return token === VALID_TOKEN ? TEST_USER : null;
    }),
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("MCP routes — authentication required", () => {
  let app: Express;

  beforeAll(async () => {
    const { requireAuth } = await import("../../server/auth/middleware.js");
    const { MemStorage } = await import("../../server/storage.js");
    const { registerToolRoutes } = await import("../../server/routes/tools.js");

    const storage = new MemStorage();

    app = express();
    app.use(express.json());

    // Apply the requireAuth guard to /api/mcp (this is what routes.ts now does)
    app.use("/api/mcp", requireAuth);

    // Register the tool routes (includes /api/mcp/servers)
    registerToolRoutes(app, storage);
  });

  it("returns 401 when no auth token is provided", async () => {
    const res = await request(app).get("/api/mcp/servers");
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 401 when an invalid auth token is provided", async () => {
    const res = await request(app)
      .get("/api/mcp/servers")
      .set("Authorization", "Bearer invalid-token-xyz");
    expect(res.status).toBe(401);
  });

  it("returns 200 when a valid auth token is provided", async () => {
    const res = await request(app)
      .get("/api/mcp/servers")
      .set("Authorization", `Bearer ${VALID_TOKEN}`);
    // Either 200 with a list or other success status — the key is NOT 401
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("POST /api/mcp/servers returns 401 without auth", async () => {
    const res = await request(app).post("/api/mcp/servers").send({
      name: "test-server",
      transport: "stdio",
    });
    expect(res.status).toBe(401);
  });
});
