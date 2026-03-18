/**
 * Integration tests for GET /api/settings/versions
 *
 * The endpoint uses Promise.allSettled internally, so it MUST always return
 * 200 regardless of which external services (Docker, vLLM, Ollama, Postgres)
 * are available.
 *
 * The DB mock and spawnSync mock ensure no real side-effects occur in CI.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createServer } from "http";
import type { Express } from "express";
import type { User } from "../../shared/types.js";
import type { VersionsResponse } from "../../shared/types.js";

const TEST_ADMIN_USER: User = {
  id: "test-user-id",
  email: "test@example.com",
  name: "Test User",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../server/db.js", () => ({
  db: {
    select: () => ({ from: () => Promise.resolve([]) }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
    execute: () => Promise.resolve([{ version: "PostgreSQL 16.1 on x86_64-pc-linux-gnu" }]),
  },
}));

vi.mock("../../server/crypto.js", () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ""),
}));

// Mock child_process so we can control docker probe behaviour
vi.mock("child_process", () => ({
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: "24.0.5\n",
    stderr: "",
    error: undefined,
  })),
}));

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("GET /api/settings/versions", () => {
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
    // Inject auth user so requireAuth passes (not used here, but good practice)
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

  // ─── Shape validation ───────────────────────────────────────────────────────

  it("returns HTTP 200", async () => {
    const res = await request(app).get("/api/settings/versions");
    expect(res.status).toBe(200);
  });

  it("returns JSON content-type", async () => {
    const res = await request(app).get("/api/settings/versions");
    expect(res.headers["content-type"]).toMatch(/json/);
  });

  it("response has platform, runtimes, database top-level keys", async () => {
    const res = await request(app).get("/api/settings/versions");
    const body = res.body as VersionsResponse;
    expect(body).toHaveProperty("platform");
    expect(body).toHaveProperty("runtimes");
    expect(body).toHaveProperty("database");
  });

  it("platform contains all expected fields", async () => {
    const res = await request(app).get("/api/settings/versions");
    const { platform } = res.body as VersionsResponse;
    expect(typeof platform.frontend).toBe("string");
    expect(typeof platform.backend).toBe("string");
    expect(typeof platform.node).toBe("string");
    expect(typeof platform.buildDate).toBe("string");
    expect(typeof platform.gitCommit).toBe("string");
  });

  it("runtimes contains docker, vllm, ollama (string or null)", async () => {
    const res = await request(app).get("/api/settings/versions");
    const { runtimes } = res.body as VersionsResponse;
    expect(runtimes).toHaveProperty("docker");
    expect(runtimes).toHaveProperty("vllm");
    expect(runtimes).toHaveProperty("ollama");
    // Each must be a string or null
    for (const v of [runtimes.docker, runtimes.vllm, runtimes.ollama]) {
      expect(v === null || typeof v === "string").toBe(true);
    }
  });

  it("database contains postgres (string or null)", async () => {
    const res = await request(app).get("/api/settings/versions");
    const { database } = res.body as VersionsResponse;
    expect(database).toHaveProperty("postgres");
    expect(database.postgres === null || typeof database.postgres === "string").toBe(true);
  });

  it("node version starts with 'v'", async () => {
    const res = await request(app).get("/api/settings/versions");
    const { platform } = res.body as VersionsResponse;
    expect(platform.node).toMatch(/^v\d+\.\d+/);
  });

  it("docker returns version string from mocked spawnSync", async () => {
    const res = await request(app).get("/api/settings/versions");
    const { runtimes } = res.body as VersionsResponse;
    // Our mock returns "24.0.5\n" — endpoint should strip whitespace
    expect(runtimes.docker).toBe("24.0.5");
  });
});
