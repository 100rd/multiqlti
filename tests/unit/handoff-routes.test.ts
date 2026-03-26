import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { registerFederationRoutes } from "../../server/routes/federation";
import type { SessionSharingService } from "../../server/federation/session-sharing";
import type { FederationManager } from "../../server/federation/index";
import type { PresenceEntry } from "../../shared/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function createMockSessionSharing(): SessionSharingService {
  return {
    shareRun: vi.fn(async () => ({
      id: "session-1",
      runId: "run-1",
      shareToken: "token-abc",
      ownerInstanceId: "local",
      createdBy: "user-1",
      isActive: true,
      expiresAt: null,
      createdAt: new Date(),
    })),
    getActiveSessions: vi.fn(async () => [
      {
        id: "session-1",
        runId: "run-1",
        shareToken: "token-abc",
        ownerInstanceId: "local",
        createdBy: "user-1",
        isActive: true,
        expiresAt: null,
        createdAt: new Date(),
      },
    ]),
    stopSharing: vi.fn(),
    subscribeToSession: vi.fn(),
    unsubscribeFromSession: vi.fn(),
    forwardEvent: vi.fn(),
    getRemoteOffers: vi.fn(() => []),
    getPendingHandoffs: vi.fn(() => [
      {
        bundleToken: "pending-1",
        notes: "Take over",
        originalRunId: "run-1",
        pipelineId: "pipe-1",
      },
    ]),
    sendHandoff: vi.fn(async () => "bundle-token-123"),
    acceptHandoff: vi.fn(async () => ({ runId: "new-run-1" })),
    recordPresence: vi.fn(),
    getSessionPresence: vi.fn((): PresenceEntry[] => [
      { userId: "user-1", instanceId: "local", lastHeartbeat: Date.now() },
    ]),
    onWsEvent: vi.fn(),
    createHandoffBundle: vi.fn(),
    stopPresenceSweep: vi.fn(),
  } as unknown as SessionSharingService;
}

function createMockFederationManager(): FederationManager {
  return {
    getPeers: vi.fn(() => []),
    isEnabled: vi.fn(() => true),
    send: vi.fn(),
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as FederationManager;
}

function buildApp(
  sessionSharing: SessionSharingService | null = createMockSessionSharing(),
  fm: FederationManager | null = createMockFederationManager(),
): express.Express {
  const app = express();
  app.use(express.json());
  // Simulate authenticated user middleware
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string; role: string } }).user = {
      id: "user-1",
      role: "admin",
    };
    next();
  });
  registerFederationRoutes(app, sessionSharing, fm);
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Federation Handoff Routes", () => {
  let sessionSharing: SessionSharingService;
  let app: express.Express;

  beforeEach(() => {
    sessionSharing = createMockSessionSharing();
    app = buildApp(sessionSharing);
  });

  // ── POST /api/federation/sessions/:id/handoff ─────────────────────────────

  it("sends handoff to peer", async () => {
    const res = await request(app)
      .post("/api/federation/sessions/session-1/handoff")
      .send({ targetPeerId: "peer-2", notes: "Please continue" });

    expect(res.status).toBe(200);
    expect(res.body.bundleToken).toBe("bundle-token-123");
    expect(sessionSharing.sendHandoff).toHaveBeenCalledWith(
      "session-1",
      "peer-2",
      "Please continue",
    );
  });

  it("rejects handoff with missing targetPeerId", async () => {
    const res = await request(app)
      .post("/api/federation/sessions/session-1/handoff")
      .send({ notes: "notes" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("rejects handoff with missing notes", async () => {
    const res = await request(app)
      .post("/api/federation/sessions/session-1/handoff")
      .send({ targetPeerId: "peer-2" });

    expect(res.status).toBe(400);
  });

  it("rejects handoff with notes exceeding max length", async () => {
    const res = await request(app)
      .post("/api/federation/sessions/session-1/handoff")
      .send({ targetPeerId: "peer-2", notes: "x".repeat(2001) });

    expect(res.status).toBe(400);
  });

  it("returns 500 when sendHandoff throws", async () => {
    (sessionSharing.sendHandoff as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Session not found"),
    );

    const res = await request(app)
      .post("/api/federation/sessions/session-1/handoff")
      .send({ targetPeerId: "peer-2", notes: "test" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Session not found");
  });

  // ── POST /api/federation/sessions/handoff/accept ──────────────────────────

  it("accepts handoff with valid bundle token", async () => {
    const res = await request(app)
      .post("/api/federation/sessions/handoff/accept")
      .send({ bundleToken: "token-abc" });

    expect(res.status).toBe(201);
    expect(res.body.runId).toBe("new-run-1");
    expect(sessionSharing.acceptHandoff).toHaveBeenCalledWith("token-abc");
  });

  it("rejects accept with missing bundleToken", async () => {
    const res = await request(app)
      .post("/api/federation/sessions/handoff/accept")
      .send({});

    expect(res.status).toBe(400);
  });

  it("rejects accept with empty bundleToken", async () => {
    const res = await request(app)
      .post("/api/federation/sessions/handoff/accept")
      .send({ bundleToken: "" });

    expect(res.status).toBe(400);
  });

  it("returns 500 when acceptHandoff throws", async () => {
    (sessionSharing.acceptHandoff as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Handoff bundle not found or expired"),
    );

    const res = await request(app)
      .post("/api/federation/sessions/handoff/accept")
      .send({ bundleToken: "bad-token" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Handoff bundle not found or expired");
  });

  // ── GET /api/federation/sessions/handoffs ─────────────────────────────────

  it("lists pending handoffs", async () => {
    const res = await request(app)
      .get("/api/federation/sessions/handoffs");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].bundleToken).toBe("pending-1");
    expect(res.body[0].notes).toBe("Take over");
  });

  // ── GET /api/federation/sessions/:id/presence ─────────────────────────────

  it("returns presence entries for a session", async () => {
    const res = await request(app)
      .get("/api/federation/sessions/session-1/presence");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].userId).toBe("user-1");
  });

  // ── POST /api/federation/sessions/:id/presence ────────────────────────────

  it("records presence heartbeat using authenticated user", async () => {
    const res = await request(app)
      .post("/api/federation/sessions/session-1/presence")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // userId comes from req.user.id (set by mock middleware), not request body
    expect(sessionSharing.recordPresence).toHaveBeenCalledWith("session-1", "user-1");
  });

  it("rejects presence heartbeat when user not authenticated", async () => {
    // Build app without mock auth middleware
    const noAuthApp = express();
    noAuthApp.use(express.json());
    registerFederationRoutes(noAuthApp, sessionSharing, createMockFederationManager());
    const res = await request(noAuthApp)
      .post("/api/federation/sessions/session-1/presence")
      .send({});

    expect(res.status).toBe(401);
  });

  // ── 503 when federation disabled ──────────────────────────────────────────

  it("returns 503 for handoff when federation disabled", async () => {
    const disabledApp = buildApp(null, null);

    const res = await request(disabledApp)
      .post("/api/federation/sessions/session-1/handoff")
      .send({ targetPeerId: "peer-2", notes: "test" });

    expect(res.status).toBe(503);
  });

  it("returns 503 for handoff/accept when federation disabled", async () => {
    const disabledApp = buildApp(null, null);

    const res = await request(disabledApp)
      .post("/api/federation/sessions/handoff/accept")
      .send({ bundleToken: "t" });

    expect(res.status).toBe(503);
  });

  it("returns 503 for handoffs list when federation disabled", async () => {
    const disabledApp = buildApp(null, null);

    const res = await request(disabledApp)
      .get("/api/federation/sessions/handoffs");

    expect(res.status).toBe(503);
  });

  it("returns 503 for presence GET when federation disabled", async () => {
    const disabledApp = buildApp(null, null);

    const res = await request(disabledApp)
      .get("/api/federation/sessions/session-1/presence");

    expect(res.status).toBe(503);
  });

  it("returns 503 for presence POST when federation disabled", async () => {
    const disabledApp = buildApp(null, null);

    const res = await request(disabledApp)
      .post("/api/federation/sessions/session-1/presence")
      .send({ userId: "u1" });

    expect(res.status).toBe(503);
  });
});
