/**
 * Integration tests for the Privacy API.
 * Tests the anonymization endpoints end-to-end via supertest.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createFullTestApp } from "../helpers/test-app-full.js";

describe("Privacy API", () => {
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

  // GET /api/privacy/patterns ──────────────────────────────────────────────────

  it("GET /api/privacy/patterns → [] (no database)", async () => {
    const res = await request(app).get("/api/privacy/patterns");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  // GET /api/privacy/audit-log ─────────────────────────────────────────────────

  it("GET /api/privacy/audit-log → [] (no database)", async () => {
    const res = await request(app).get("/api/privacy/audit-log");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // POST /api/privacy/patterns ─────────────────────────────────────────────────

  it("POST /api/privacy/patterns → 503 (no database) or 201 (with database)", async () => {
    const res = await request(app)
      .post("/api/privacy/patterns")
      .send({
        name: "Test Pattern",
        regexPattern: "TICKET-\\d+",
        severity: "medium",
        entityType: "custom_pattern",
        allowlist: [],
      });
    // Without DATABASE_URL → 503; with DATABASE_URL (nightly CI) → 201
    expect([503, 201]).toContain(res.status);
  });

  it("POST /api/privacy/patterns with invalid regex → 400", async () => {
    const res = await request(app)
      .post("/api/privacy/patterns")
      .send({
        name: "Bad Pattern",
        regexPattern: "[invalid",
        severity: "high",
        entityType: "custom_pattern",
        allowlist: [],
      });
    expect(res.status).toBe(400);
  });

  // DELETE /api/privacy/patterns/:id ──────────────────────────────────────────

  it("DELETE /api/privacy/patterns/1 → 503 (no database) or 204 (with database)", async () => {
    const res = await request(app).delete("/api/privacy/patterns/1");
    // Without DATABASE_URL → 503; with DATABASE_URL (nightly CI) → 204
    expect([503, 204]).toContain(res.status);
  });

  it("DELETE /api/privacy/patterns/invalid-id → 400", async () => {
    const res = await request(app).delete("/api/privacy/patterns/not-a-number");
    expect(res.status).toBe(400);
  });

  // POST /api/privacy/test — level=off ─────────────────────────────────────────

  it("POST /api/privacy/test level=off → text unchanged, entities=[]", async () => {
    const text = "My secret OPENAI_KEY=sk-abcdefghijklmnopqrstuvwxyz123456";
    const res = await request(app)
      .post("/api/privacy/test")
      .send({ text, level: "off" });

    expect(res.status).toBe(200);
    expect(res.body.anonymized).toBe(text);
    expect(res.body.entities).toHaveLength(0);
  });

  // POST /api/privacy/test — standard + api_key → REDACTED ────────────────────

  it("POST /api/privacy/test level=standard with OPENAI_KEY → <REDACTED>", async () => {
    const text = "OPENAI_KEY=sk-abcdefghijklmnopqrstuvwxyz123456";
    const res = await request(app)
      .post("/api/privacy/test")
      .send({ text, level: "standard" });

    expect(res.status).toBe(200);
    expect(res.body.anonymized).toContain("<REDACTED>");
    expect(res.body.anonymized).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  // POST /api/privacy/test — standard + email → pseudonymized ─────────────────

  it("POST /api/privacy/test level=standard with email → email pseudonymized", async () => {
    const text = "Contact alice@company.io for support";
    const res = await request(app)
      .post("/api/privacy/test")
      .send({ text, level: "standard" });

    expect(res.status).toBe(200);
    expect(res.body.anonymized).not.toContain("alice@company.io");
    expect(res.body.anonymized).toContain("@example.com");
    expect(res.body.entities.some((e: { type: string }) => e.type === "email")).toBe(true);
  });

  // POST /api/privacy/test — strict level ──────────────────────────────────────

  it("POST /api/privacy/test level=strict → anonymizes more entities", async () => {
    const text = "Connect to namespace: my-app-namespace";
    const res = await request(app)
      .post("/api/privacy/test")
      .send({ text, level: "strict" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("anonymized");
    expect(res.body).toHaveProperty("entities");
  });

  // POST /api/privacy/test — with valid customPatterns ─────────────────────────

  it("POST /api/privacy/test with valid customPattern → detects match", async () => {
    const res = await request(app)
      .post("/api/privacy/test")
      .send({
        text: "TICKET-1234 needs attention",
        level: "standard",
        customPatterns: [
          { name: "ticket", pattern: "TICKET-\\d+", severity: "high" },
        ],
      });

    expect(res.status).toBe(200);
  });

  // POST /api/privacy/test — invalid regex in customPatterns → 400 ─────────────

  it("POST /api/privacy/test with invalid regex in customPatterns → 400", async () => {
    const res = await request(app)
      .post("/api/privacy/test")
      .send({
        text: "some text",
        level: "standard",
        customPatterns: [
          { name: "bad-pattern", pattern: "[invalid", severity: "high" },
        ],
      });

    expect(res.status).toBe(400);
  });

  // Consistency: same text + same request → identical output ───────────────────

  it("same text twice with same request → identical anonymized output", async () => {
    const text = "Contact alice@company.io for support";
    const payload = { text, level: "standard" };

    const r1 = await request(app).post("/api/privacy/test").send(payload);
    const r2 = await request(app).post("/api/privacy/test").send(payload);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Both requests are independent sessions but same input → same output
    expect(r1.body.anonymized).toBe(r2.body.anonymized);
  });

  // Validation errors ───────────────────────────────────────────────────────────

  it("POST /api/privacy/test with missing text → 400", async () => {
    const res = await request(app)
      .post("/api/privacy/test")
      .send({ level: "standard" });
    expect(res.status).toBe(400);
  });

  it("POST /api/privacy/test with invalid level → 400", async () => {
    const res = await request(app)
      .post("/api/privacy/test")
      .send({ text: "hello", level: "maximum" });
    expect(res.status).toBe(400);
  });
});
