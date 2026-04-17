/**
 * Tests for Conflict Resolution API routes (issue #229)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { registerFederationRoutes } from "../../server/routes/federation";
import type { ConflictResolutionService } from "../../server/federation/conflict-resolution";
import type { SessionConflict } from "../../shared/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeConflict(overrides: Partial<SessionConflict> = {}): SessionConflict {
  const now = Date.now();
  return {
    id: "conflict-1",
    sessionId: "session-1",
    raisedBy: "user-1",
    raisedByInstance: "instance-1",
    question: "REST vs GraphQL?",
    strategy: "quorum_vote",
    status: "open",
    proposals: [],
    votes: [],
    quorumThreshold: 0.67,
    timeoutMs: 300_000,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createMockConflictService(): ConflictResolutionService {
  const conflict = makeConflict();

  return {
    raiseConflict: vi.fn(async () => ({
      conflictId: "conflict-1",
      resolution: Promise.resolve({
        strategy: "quorum_vote" as const,
        reasoning: "Quorum reached.",
        decidedBy: "quorum" as const,
        decidedAt: Date.now(),
      }),
    })),
    getConflict: vi.fn(() => conflict),
    getSessionConflicts: vi.fn(() => [conflict]),
    addProposal: vi.fn(async () => ({ ...conflict, proposals: [] })),
    castVote: vi.fn(async () => conflict),
    forceResolve: vi.fn(async () => ({ ...conflict, status: "resolved" as const })),
    runDebateJudge: vi.fn(async () => ({
      judgeModelSlug: "default",
      reasoning: "Proposal 1 wins.",
      confidence: 0.9,
      evaluatedAt: Date.now(),
    })),
    updateExperimentBranch: vi.fn(async () => conflict),
    getSessionDecisionLog: vi.fn(() => []),
    getDecisionLog: vi.fn(() => []),
    submitDebateJudgement: vi.fn(async () => conflict),
    _triggerTimeout: vi.fn(async () => {}),
    _getPendingCount: vi.fn(() => 0),
  } as unknown as ConflictResolutionService;
}

function buildApp(conflictService: ConflictResolutionService | null = null) {
  const app = express();
  app.use(express.json());

  // Inject a mock user
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string; role: string } }).user = {
      id: "user-1",
      role: "user",
    };
    next();
  });

  registerFederationRoutes(
    app,
    null,
    null,
    null,
    null,
    null,
    null,
    conflictService,
  );

  return app;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Conflict Resolution Routes", () => {
  let mockService: ConflictResolutionService;
  let app: express.Application;

  beforeEach(() => {
    mockService = createMockConflictService();
    app = buildApp(mockService);
  });

  // ── POST /api/sessions/:id/conflicts ─────────────────────────────────────────

  describe("POST /api/sessions/:id/conflicts", () => {
    it("returns 201 with the new conflict", async () => {
      const res = await request(app)
        .post("/api/sessions/session-1/conflicts")
        .send({
          question: "REST vs GraphQL?",
          strategy: "quorum_vote",
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("conflict-1");
      expect(mockService.raiseConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-1",
          raisedBy: "user-1",
          question: "REST vs GraphQL?",
          strategy: "quorum_vote",
        }),
      );
    });

    it("returns 400 for missing question", async () => {
      const res = await request(app)
        .post("/api/sessions/session-1/conflicts")
        .send({ strategy: "quorum_vote" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();
    });

    it("returns 400 for invalid strategy", async () => {
      const res = await request(app)
        .post("/api/sessions/session-1/conflicts")
        .send({ question: "Q", strategy: "invalid_strategy" });

      expect(res.status).toBe(400);
    });

    it("returns 503 when service is not available", async () => {
      const res = await request(buildApp(null))
        .post("/api/sessions/session-1/conflicts")
        .send({ question: "Q", strategy: "quorum_vote" });

      expect(res.status).toBe(503);
    });
  });

  // ── GET /api/sessions/:id/conflicts ──────────────────────────────────────────

  describe("GET /api/sessions/:id/conflicts", () => {
    it("returns 200 with conflict list", async () => {
      const res = await request(app).get("/api/sessions/session-1/conflicts");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].id).toBe("conflict-1");
    });

    it("returns 503 when service is not available", async () => {
      const res = await request(buildApp(null)).get(
        "/api/sessions/session-1/conflicts",
      );
      expect(res.status).toBe(503);
    });
  });

  // ── POST /api/sessions/:id/conflicts/:cid/proposals ──────────────────────────

  describe("POST /api/sessions/:id/conflicts/:cid/proposals", () => {
    it("returns 201 with updated conflict", async () => {
      const res = await request(app)
        .post("/api/sessions/session-1/conflicts/conflict-1/proposals")
        .send({
          authorId: "user-1",
          instanceId: "instance-1",
          title: "Use REST",
          description: "Simple and well-understood",
        });

      expect(res.status).toBe(201);
      expect(mockService.addProposal).toHaveBeenCalledWith(
        "conflict-1",
        expect.objectContaining({ title: "Use REST" }),
      );
    });

    it("returns 400 for missing required fields", async () => {
      const res = await request(app)
        .post("/api/sessions/session-1/conflicts/conflict-1/proposals")
        .send({ title: "Incomplete" });

      expect(res.status).toBe(400);
    });

    it("returns 404 when service throws 'not found'", async () => {
      (mockService.addProposal as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Conflict xyz not found."),
      );

      const res = await request(app)
        .post("/api/sessions/session-1/conflicts/xyz/proposals")
        .send({
          authorId: "u1",
          instanceId: "i1",
          title: "T",
          description: "D",
        });

      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/sessions/:id/conflicts/:cid/vote ────────────────────────────────

  describe("POST /api/sessions/:id/conflicts/:cid/vote", () => {
    it("returns 200 with updated conflict", async () => {
      const res = await request(app)
        .post("/api/sessions/session-1/conflicts/conflict-1/vote")
        .send({
          participantId: "user-1",
          instanceId: "instance-1",
          proposalId: "proposal-1",
        });

      expect(res.status).toBe(200);
      expect(mockService.castVote).toHaveBeenCalledWith(
        "conflict-1",
        expect.objectContaining({ proposalId: "proposal-1" }),
      );
    });

    it("returns 409 when duplicate vote detected", async () => {
      (mockService.castVote as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Participant user-1 has already voted on conflict conflict-1."),
      );

      const res = await request(app)
        .post("/api/sessions/session-1/conflicts/conflict-1/vote")
        .send({
          participantId: "user-1",
          instanceId: "instance-1",
          proposalId: "proposal-1",
        });

      expect(res.status).toBe(409);
    });

    it("returns 400 for missing fields", async () => {
      const res = await request(app)
        .post("/api/sessions/session-1/conflicts/conflict-1/vote")
        .send({ participantId: "user-1" });

      expect(res.status).toBe(400);
    });
  });

  // ── POST /api/sessions/:id/conflicts/:cid/resolve ─────────────────────────────

  describe("POST /api/sessions/:id/conflicts/:cid/resolve", () => {
    it("returns 200 with resolved conflict", async () => {
      const res = await request(app)
        .post("/api/sessions/session-1/conflicts/conflict-1/resolve")
        .send({ reasoning: "Owner decided." });

      expect(res.status).toBe(200);
      expect(mockService.forceResolve).toHaveBeenCalledWith(
        "conflict-1",
        undefined,
        "Owner decided.",
        undefined,
      );
    });

    it("returns 404 when already resolved", async () => {
      (mockService.forceResolve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Conflict conflict-1 is already resolved."),
      );

      const res = await request(app)
        .post("/api/sessions/session-1/conflicts/conflict-1/resolve")
        .send({ reasoning: "Again?" });

      expect(res.status).toBe(404);
    });

    it("returns 400 for missing reasoning", async () => {
      const res = await request(app)
        .post("/api/sessions/session-1/conflicts/conflict-1/resolve")
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // ── POST /api/sessions/:id/conflicts/:cid/judge ──────────────────────────────

  describe("POST /api/sessions/:id/conflicts/:cid/judge", () => {
    it("returns 200 with judgement", async () => {
      const res = await request(app).post(
        "/api/sessions/session-1/conflicts/conflict-1/judge",
      );

      expect(res.status).toBe(200);
      expect(res.body.reasoning).toBe("Proposal 1 wins.");
    });

    it("returns 503 when no gateway available", async () => {
      (mockService.runDebateJudge as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("No LLM gateway available for debate judgement."),
      );

      const res = await request(app).post(
        "/api/sessions/session-1/conflicts/conflict-1/judge",
      );

      expect(res.status).toBe(503);
    });
  });

  // ── POST /api/sessions/:id/conflicts/:cid/experiment ─────────────────────────

  describe("POST /api/sessions/:id/conflicts/:cid/experiment", () => {
    it("returns 200 with updated conflict", async () => {
      const res = await request(app)
        .post("/api/sessions/session-1/conflicts/conflict-1/experiment")
        .send({
          proposalId: "proposal-1",
          runId: "run-abc",
          status: "completed",
          outcome: "10ms avg",
        });

      expect(res.status).toBe(200);
      expect(mockService.updateExperimentBranch).toHaveBeenCalledWith(
        "conflict-1",
        expect.objectContaining({ proposalId: "proposal-1", status: "completed" }),
      );
    });

    it("returns 400 for invalid status", async () => {
      const res = await request(app)
        .post("/api/sessions/session-1/conflicts/conflict-1/experiment")
        .send({ proposalId: "p1", runId: "r1", status: "unknown_status" });

      expect(res.status).toBe(400);
    });
  });

  // ── GET /api/sessions/:id/decision-log ───────────────────────────────────────

  describe("GET /api/sessions/:id/decision-log", () => {
    it("returns 200 with empty array", async () => {
      const res = await request(app).get(
        "/api/sessions/session-1/decision-log",
      );

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("calls getSessionDecisionLog with the session ID", async () => {
      await request(app).get("/api/sessions/session-42/decision-log");
      expect(mockService.getSessionDecisionLog).toHaveBeenCalledWith("session-42");
    });

    it("returns 503 when service is not available", async () => {
      const res = await request(buildApp(null)).get(
        "/api/sessions/session-1/decision-log",
      );
      expect(res.status).toBe(503);
    });
  });
});
