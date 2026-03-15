/**
 * Integration tests for the Memory API.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createFullTestApp } from "../helpers/test-app-full.js";

describe("Memory API", () => {
  let app: Express;
  let closeApp: () => Promise<void>;
  let pipelineId: string;

  beforeAll(async () => {
    const testApp = await createFullTestApp();
    app = testApp.app;
    closeApp = testApp.close;

    // Create a pipeline for per-pipeline memory tests
    const res = await request(app)
      .post("/api/pipelines")
      .send({
        name: "Memory Test Pipeline",
        description: "For memory tests",
        stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
      });
    expect(res.status).toBe(201);
    pipelineId = res.body.id as string;
  });

  afterAll(async () => {
    await closeApp();
  });

  // GET /api/memories ──────────────────────────────────────────────────────────

  it("GET /api/memories → [] initially", async () => {
    const res = await request(app).get("/api/memories");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  // POST /api/memories ─────────────────────────────────────────────────────────

  it("POST /api/memories creates memory → 201 with id", async () => {
    const res = await request(app)
      .post("/api/memories")
      .send({
        scope: "global",
        type: "decision",
        key: "test-decision",
        content: "Use TypeScript for all new services",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.key).toBe("test-decision");
    expect(res.body.content).toBe("Use TypeScript for all new services");
  });

  it("POST /api/memories with missing required field → 400", async () => {
    const res = await request(app)
      .post("/api/memories")
      .send({
        scope: "global",
        // missing type, key, content
      });

    expect(res.status).toBe(400);
  });

  it("POST /api/memories with invalid scope → 400", async () => {
    const res = await request(app)
      .post("/api/memories")
      .send({
        scope: "invalid-scope",
        type: "fact",
        key: "x",
        content: "y",
      });

    expect(res.status).toBe(400);
  });

  // GET /api/memories?q=... ─────────────────────────────────────────────────────

  it("GET /api/memories?q=test → finds matching memory", async () => {
    // Ensure memory exists
    await request(app)
      .post("/api/memories")
      .send({
        scope: "global",
        type: "fact",
        key: "searchable-fact",
        content: "test searchable content here",
      });

    const res = await request(app).get("/api/memories?q=test");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  // PUT /api/memories/:id ───────────────────────────────────────────────────────

  it("PUT /api/memories/:id → updates content", async () => {
    const createRes = await request(app)
      .post("/api/memories")
      .send({
        scope: "global",
        type: "pattern",
        key: "update-test",
        content: "original content",
      });
    expect(createRes.status).toBe(201);
    const id: number = createRes.body.id as number;

    const updateRes = await request(app)
      .put(`/api/memories/${id}`)
      .send({ content: "updated content" });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.content).toBe("updated content");
  });

  it("PUT /api/memories/:id for nonexistent id → 404", async () => {
    const res = await request(app)
      .put("/api/memories/999999")
      .send({ content: "new content" });

    expect(res.status).toBe(404);
  });

  // DELETE /api/memories/stale ──────────────────────────────────────────────────

  it("DELETE /api/memories/stale → {deleted: 0} when no stale memories", async () => {
    const res = await request(app).delete("/api/memories/stale");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("deleted");
    expect(typeof res.body.deleted).toBe("number");
    expect(res.body.deleted).toBeGreaterThanOrEqual(0);
  });

  // DELETE /api/memories/:id ────────────────────────────────────────────────────

  it("DELETE /api/memories/:id → 204", async () => {
    const createRes = await request(app)
      .post("/api/memories")
      .send({
        scope: "global",
        type: "fact",
        key: "delete-me",
        content: "to be deleted",
      });
    expect(createRes.status).toBe(201);
    const id: number = createRes.body.id as number;

    const deleteRes = await request(app).delete(`/api/memories/${id}`);
    expect(deleteRes.status).toBe(204);
  });

  it("DELETE /api/memories/nonexistent-number → 400", async () => {
    const res = await request(app).delete("/api/memories/not-a-number");
    expect(res.status).toBe(400);
  });

  // GET /api/pipelines/:id/memories ─────────────────────────────────────────────

  it("GET /api/pipelines/:id/memories → []", async () => {
    const res = await request(app).get(`/api/pipelines/${pipelineId}/memories`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("POST + GET /api/pipelines/:id/memories → returns scoped memory", async () => {
    await request(app)
      .post("/api/memories")
      .send({
        scope: "pipeline",
        scopeId: pipelineId,
        type: "decision",
        key: "pipeline-decision",
        content: "Use REST not GraphQL",
      });

    const res = await request(app).get(`/api/pipelines/${pipelineId}/memories`);
    expect(res.status).toBe(200);
    expect(res.body.some((m: { key: string }) => m.key === "pipeline-decision")).toBe(true);
  });
});
