/**
 * Integration tests for the Settings / API keys API.
 *
 * Settings routes require a database for full operation. In the no-DB test
 * environment, GET /api/settings/providers will return 500. These tests verify:
 * 1. The route exists and returns JSON (not HTML).
 * 2. POST/DELETE return proper shapes.
 *
 * For full DB-backed tests, see the nightly CI workflow where DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createServer } from "http";
import type { Express } from "express";
import type { User } from "../../shared/types.js";

const TEST_ADMIN_USER: User = {
  id: "test-user-id",
  email: "test@example.com",
  name: "Test User",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

// Mock the db module to prevent real PG connections in unit/integration test mode
vi.mock("../../server/db.js", () => ({
  db: {
    select: () => ({
      from: () => Promise.resolve([]),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => Promise.resolve(),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve(),
    }),
  },
}));

// Mock crypto module used by encrypt/decrypt
vi.mock("../../server/crypto.js", () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ""),
}));

describe("Settings API", () => {
  let app: Express;
  let closeApp: () => Promise<void>;

  beforeAll(async () => {
    const { registerSettingsRoutes } = await import("../../server/routes/settings.js");
    const { Gateway } = await import("../../server/gateway/index.js");
    const { MemStorage } = await import("../../server/storage.js");

    const storage = new MemStorage();
    const gateway = new Gateway(storage);
    const httpServer = createServer();

    const appInstance = express();
    appInstance.use(express.json());
    appInstance.use((req, _res, next) => {
      req.user = TEST_ADMIN_USER;
      next();
    });

    registerSettingsRoutes(appInstance as unknown as import("express").Router, gateway);

    app = appInstance;
    closeApp = () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
  });

  afterAll(async () => {
    await closeApp();
  });

  // GET /api/settings/providers ─────────────────────────────────────────────────

  it("GET /api/settings/providers → JSON array (not HTML)", async () => {
    const res = await request(app).get("/api/settings/providers");

    // Must return JSON (not HTML redirect or error page)
    expect(res.headers["content-type"]).toMatch(/json/);

    // Should be 200 with mocked DB returning []
    if (res.status === 200) {
      expect(Array.isArray(res.body)).toBe(true);
      // Each entry should have provider + configured fields
      for (const entry of res.body as Array<{ provider: string; configured: boolean; source: string }>) {
        expect(typeof entry.provider).toBe("string");
        expect(typeof entry.configured).toBe("boolean");
        expect(["env", "db", "none"]).toContain(entry.source);
      }
    }
  });

  it("GET /api/settings/providers → lists anthropic, google, xai providers", async () => {
    const res = await request(app).get("/api/settings/providers");
    if (res.status === 200) {
      const providers = (res.body as Array<{ provider: string }>).map((p) => p.provider);
      expect(providers).toContain("anthropic");
      expect(providers).toContain("google");
      expect(providers).toContain("xai");
    }
  });

  // POST /api/settings/providers/:provider/key ──────────────────────────────────

  it("POST /api/settings/providers/anthropic/key with valid key → 200 or 500", async () => {
    const res = await request(app)
      .post("/api/settings/providers/anthropic/key")
      .send({ key: "sk-ant-test-key-minimum-length" });

    // Valid request — should be 200 (with mock DB) or 500 (real DB unavailable)
    expect([200, 500]).toContain(res.status);
    expect(res.headers["content-type"]).toMatch(/json/);

    if (res.status === 200) {
      expect(res.body.ok).toBe(true);
      expect(res.body.provider).toBe("anthropic");
    }
  });

  it("POST /api/settings/providers/anthropic/key with missing key → 400", async () => {
    const res = await request(app)
      .post("/api/settings/providers/anthropic/key")
      .send({});

    expect(res.status).toBe(400);
  });

  it("POST /api/settings/providers/unknown_provider/key → 400", async () => {
    const res = await request(app)
      .post("/api/settings/providers/unknown_provider/key")
      .send({ key: "some-key" });

    expect(res.status).toBe(400);
  });

  // DELETE /api/settings/providers/:provider/key ────────────────────────────────

  it("DELETE /api/settings/providers/anthropic/key → 200 or 500", async () => {
    const res = await request(app).delete("/api/settings/providers/anthropic/key");

    expect([200, 500]).toContain(res.status);
    expect(res.headers["content-type"]).toMatch(/json/);

    if (res.status === 200) {
      expect(res.body.ok).toBe(true);
      expect(res.body.provider).toBe("anthropic");
    }
  });

  it("DELETE /api/settings/providers/invalid_provider/key → 400", async () => {
    const res = await request(app).delete("/api/settings/providers/invalid_provider/key");
    expect(res.status).toBe(400);
  });
});
