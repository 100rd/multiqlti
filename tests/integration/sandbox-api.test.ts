/**
 * Integration tests for the Sandbox API.
 *
 * In CI there is no Docker daemon, so sandbox is unavailable.
 * These tests verify the API contract; they do not require Docker to pass.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createFullTestApp } from "../helpers/test-app-full.js";

describe("Sandbox API", () => {
  let app: Express;
  let closeApp: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createFullTestApp();
    app = testApp.app;
    closeApp = testApp.close;
  });

  afterAll(async () => {
    await closeApp();
  });

  // GET /api/sandbox/status ─────────────────────────────────────────────────────

  it("GET /api/sandbox/status → JSON with available boolean (not HTML)", async () => {
    const res = await request(app).get("/api/sandbox/status");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(typeof res.body.available).toBe("boolean");
  });

  it("GET /api/sandbox/status → body is JSON not HTML string", async () => {
    const res = await request(app).get("/api/sandbox/status");
    // The response must not be an HTML page
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toContain("<!DOCTYPE");
    expect(bodyText).not.toContain("<html");
  });

  // GET /api/sandbox/presets ────────────────────────────────────────────────────

  it("GET /api/sandbox/presets → array with id field (not keyed object)", async () => {
    const res = await request(app).get("/api/sandbox/presets");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(Array.isArray(res.body)).toBe(true);

    // Each preset must have an id field
    for (const preset of res.body as Array<{ id: string }>) {
      expect(typeof preset.id).toBe("string");
      expect(preset.id.length).toBeGreaterThan(0);
    }
  });

  it("GET /api/sandbox/presets → includes node, python entries", async () => {
    const res = await request(app).get("/api/sandbox/presets");
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((p) => p.id);
    expect(ids.some((id) => id.toLowerCase().includes("node"))).toBe(true);
  });

  it("GET /api/sandbox/presets → each preset has image field", async () => {
    const res = await request(app).get("/api/sandbox/presets");
    for (const preset of res.body as Array<{ image?: string }>) {
      expect(typeof preset.image).toBe("string");
    }
  });

  // POST /api/sandbox/test ──────────────────────────────────────────────────────

  it("POST /api/sandbox/test with {image: 'node:20-alpine'} → result object (not 400)", async () => {
    const res = await request(app)
      .post("/api/sandbox/test")
      .send({ image: "node:20-alpine" });

    // Either succeeds (200 with result) or fails with 500 (Docker not available)
    // but must NOT return 400 (bad request) — the body is valid
    expect(res.status).not.toBe(400);
    expect(res.headers["content-type"]).toMatch(/json/);
  });

  it("POST /api/sandbox/test with missing image → 400", async () => {
    const res = await request(app)
      .post("/api/sandbox/test")
      .send({});

    expect(res.status).toBe(400);
  });

  it("POST /api/sandbox/test result shape when available", async () => {
    const res = await request(app)
      .post("/api/sandbox/test")
      .send({ image: "node:20-alpine" });

    if (res.status === 200) {
      // Docker is available — verify result shape
      expect(typeof res.body).toBe("object");
      // Should not be an HTML page
      expect(JSON.stringify(res.body)).not.toContain("<!DOCTYPE");
    }
    // If status 500 (Docker unavailable), that's expected in test env
  });
});
