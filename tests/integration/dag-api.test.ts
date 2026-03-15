/**
 * Integration tests — DAG API Routes
 *
 * Tests GET/PUT /api/pipelines/:id/dag and POST /api/pipelines/:id/dag/validate
 * using a full in-memory Express app (no DB, no real LLM calls).
 *
 * Status code semantics for PUT:
 *   400 — Zod schema validation failure (invalid types, out-of-range, bad operator,
 *          or cross-reference refine: edge references non-existent stage ID)
 *   422 — Zod schema passes but structural validator rejects (cycle, duplicate ID, etc.)
 *   404 — Pipeline not found
 *   200 — Success
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createTestApp } from "../helpers/test-app.js";
import { registerDAGRoutes } from "../../server/routes/dag.js";
import type { PipelineDAG } from "../../shared/types.js";

const VALID_DAG: PipelineDAG = {
  stages: [
    {
      id: "s1",
      teamId: "planning",
      modelSlug: "mock",
      enabled: true,
      position: { x: 0, y: 0 },
      label: "Plan",
    },
    {
      id: "s2",
      teamId: "development",
      modelSlug: "mock",
      enabled: true,
      position: { x: 200, y: 0 },
      label: "Dev",
    },
  ],
  edges: [
    {
      id: "e1",
      from: "s1",
      to: "s2",
      label: "proceed",
    },
  ],
};

const CONDITIONAL_DAG: PipelineDAG = {
  stages: [
    { id: "a", teamId: "planning", modelSlug: "mock", enabled: true, position: { x: 0, y: 0 } },
    { id: "b", teamId: "testing", modelSlug: "mock", enabled: true, position: { x: 200, y: 0 } },
  ],
  edges: [
    {
      id: "e1",
      from: "a",
      to: "b",
      condition: { field: "score", operator: "gt", value: 0.5 },
    },
  ],
};

describe("DAG API Routes", () => {
  let app: Express;
  let closeApp: () => Promise<void>;
  let pipelineId: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    closeApp = testApp.close;

    // Register DAG routes on the test app
    registerDAGRoutes(app, testApp.storage);

    // Create a test pipeline
    const res = await request(app)
      .post("/api/pipelines")
      .send({
        name: "DAG Test Pipeline",
        description: "For DAG route tests",
        stages: [{ teamId: "planning", modelSlug: "mock", enabled: true }],
      });

    expect(res.status).toBe(201);
    pipelineId = (res.body as { id: string }).id;
  }, 30_000);

  afterAll(async () => {
    await closeApp();
  });

  // ── GET /api/pipelines/:id/dag ─────────────────────────────────────────────

  describe("GET /api/pipelines/:id/dag", () => {
    it("returns null when pipeline has no DAG configured", async () => {
      const res = await request(app).get(`/api/pipelines/${pipelineId}/dag`);
      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });

    it("returns 404 for an unknown pipeline ID", async () => {
      const res = await request(app).get("/api/pipelines/nonexistent/dag");
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("error");
    });
  });

  // ── PUT /api/pipelines/:id/dag ─────────────────────────────────────────────

  describe("PUT /api/pipelines/:id/dag", () => {
    it("stores a valid DAG and returns { ok: true }", async () => {
      const res = await request(app)
        .put(`/api/pipelines/${pipelineId}/dag`)
        .send(VALID_DAG);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("GET after PUT returns the stored DAG", async () => {
      await request(app).put(`/api/pipelines/${pipelineId}/dag`).send(VALID_DAG);

      const res = await request(app).get(`/api/pipelines/${pipelineId}/dag`);
      expect(res.status).toBe(200);
      expect(res.body.stages).toHaveLength(2);
      expect(res.body.edges).toHaveLength(1);
    });

    it("accepts a DAG with conditional edges", async () => {
      const res = await request(app)
        .put(`/api/pipelines/${pipelineId}/dag`)
        .send(CONDITIONAL_DAG);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("returns 422 when DAG has a cycle (passes Zod, fails structural validator)", async () => {
      const cyclic: PipelineDAG = {
        stages: [
          { id: "x", teamId: "planning", modelSlug: "mock", enabled: true, position: { x: 0, y: 0 } },
          { id: "y", teamId: "planning", modelSlug: "mock", enabled: true, position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: "e1", from: "x", to: "y" },
          { id: "e2", from: "y", to: "x" },
        ],
      };
      const res = await request(app)
        .put(`/api/pipelines/${pipelineId}/dag`)
        .send(cyclic);

      expect(res.status).toBe(422);
      expect(res.body).toHaveProperty("error");
      expect(res.body).toHaveProperty("reason");
    });

    it("returns 400 when edge references non-existent stage (Zod refine catches this)", async () => {
      // Zod PipelineDAGSchema.refine() verifies all edge from/to IDs exist in stages,
      // so this is a 400 (schema validation) rather than 422 (structural validator).
      const invalid: PipelineDAG = {
        stages: [
          { id: "s1", teamId: "planning", modelSlug: "mock", enabled: true, position: { x: 0, y: 0 } },
        ],
        edges: [{ id: "e1", from: "s1", to: "ghost" }],
      };
      const res = await request(app)
        .put(`/api/pipelines/${pipelineId}/dag`)
        .send(invalid);

      expect(res.status).toBe(400);
    });

    it("returns 400 when body fails Zod validation (empty stages)", async () => {
      const res = await request(app)
        .put(`/api/pipelines/${pipelineId}/dag`)
        .send({ stages: [], edges: [] });

      expect(res.status).toBe(400);
    });

    it("returns 400 when condition operator is invalid", async () => {
      const bad = {
        stages: [
          { id: "s1", teamId: "planning", modelSlug: "mock", enabled: true, position: { x: 0, y: 0 } },
        ],
        edges: [
          {
            id: "e1",
            from: "s1",
            to: "s1",
            condition: { field: "score", operator: "badop", value: 0 },
          },
        ],
      };
      const res = await request(app)
        .put(`/api/pipelines/${pipelineId}/dag`)
        .send(bad);

      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown pipeline ID", async () => {
      const res = await request(app)
        .put("/api/pipelines/unknown-id/dag")
        .send(VALID_DAG);

      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/pipelines/:id/dag/validate ──────────────────────────────────

  describe("POST /api/pipelines/:id/dag/validate", () => {
    it("returns { valid: true } for a valid DAG", async () => {
      const res = await request(app)
        .post(`/api/pipelines/${pipelineId}/dag/validate`)
        .send(VALID_DAG);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: true });
    });

    it("returns { valid: true } for conditional edges", async () => {
      const res = await request(app)
        .post(`/api/pipelines/${pipelineId}/dag/validate`)
        .send(CONDITIONAL_DAG);

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
    });

    it("returns { valid: false, issues } when DAG contains a cycle", async () => {
      const cyclic = {
        stages: [
          { id: "a", teamId: "planning", modelSlug: "mock", enabled: true, position: { x: 0, y: 0 } },
          { id: "b", teamId: "planning", modelSlug: "mock", enabled: true, position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: "e1", from: "a", to: "b" },
          { id: "e2", from: "b", to: "a" },
        ],
      };
      const res = await request(app)
        .post(`/api/pipelines/${pipelineId}/dag/validate`)
        .send(cyclic);

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.issues).toBeDefined();
      expect(res.body.issues.length).toBeGreaterThan(0);
    });

    it("returns { valid: false, issues } for Zod schema violations", async () => {
      const res = await request(app)
        .post(`/api/pipelines/${pipelineId}/dag/validate`)
        .send({ stages: "not an array", edges: [] });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.issues).toBeDefined();
    });

    it("returns { valid: false } for empty stages", async () => {
      const res = await request(app)
        .post(`/api/pipelines/${pipelineId}/dag/validate`)
        .send({ stages: [], edges: [] });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
    });

    it("returns { valid: false } when edge refs non-existent stage ID", async () => {
      const res = await request(app)
        .post(`/api/pipelines/${pipelineId}/dag/validate`)
        .send({
          stages: [
            { id: "s1", teamId: "planning", modelSlug: "mock", enabled: true, position: { x: 0, y: 0 } },
          ],
          edges: [{ id: "e1", from: "s1", to: "ghost" }],
        });

      // Zod refine catches this at the schema level
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
    });
  });
});
