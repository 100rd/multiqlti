import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionSharingService } from "../../server/federation/session-sharing";
import type { FederationManager } from "../../server/federation/index";
import type { FederationMessage, PeerInfo } from "../../server/federation/types";
import type { IStorage } from "../../server/storage";
import type { SharedSession, CreateSharedSessionInput } from "../../shared/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makePeer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    instanceId: "peer-1",
    instanceName: "Peer One",
    endpoint: "ws://peer-1:9100",
    connectedAt: new Date(),
    lastMessageAt: new Date(),
    status: "connected",
    ...overrides,
  };
}

function makeSession(overrides: Partial<SharedSession> = {}): SharedSession {
  return {
    id: "session-1",
    runId: "run-1",
    shareToken: "abc123",
    ownerInstanceId: "local-instance",
    createdBy: "user-1",
    expiresAt: null,
    isActive: true,
    createdAt: new Date(),
    ...overrides,
  };
}

function createMockFederation(): FederationManager & {
  _handlers: Map<string, Array<(msg: FederationMessage, peer: PeerInfo) => void | Promise<void>>>;
  _sentMessages: Array<{ type: string; payload: unknown; to?: string }>;
} {
  const handlers = new Map<string, Array<(msg: FederationMessage, peer: PeerInfo) => void | Promise<void>>>();
  const sentMessages: Array<{ type: string; payload: unknown; to?: string }> = [];

  return {
    _handlers: handlers,
    _sentMessages: sentMessages,
    on(type: string, handler: (msg: FederationMessage, peer: PeerInfo) => void | Promise<void>) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    send(type: string, payload: unknown, to?: string) {
      sentMessages.push({ type, payload, to });
    },
    getPeers: vi.fn(() => []),
    isEnabled: vi.fn(() => true),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as FederationManager & {
    _handlers: Map<string, Array<(msg: FederationMessage, peer: PeerInfo) => void | Promise<void>>>;
    _sentMessages: Array<{ type: string; payload: unknown; to?: string }>;
  };
}

function createMockStorage(): IStorage {
  const sessions = new Map<string, SharedSession>();

  return {
    createSharedSession: vi.fn(async (input: CreateSharedSessionInput): Promise<SharedSession> => {
      const s = makeSession({
        id: `session-${sessions.size + 1}`,
        runId: input.runId,
        shareToken: input.shareToken,
        ownerInstanceId: input.ownerInstanceId,
        createdBy: input.createdBy,
        expiresAt: input.expiresAt ?? null,
      });
      sessions.set(s.id, s);
      return s;
    }),
    getSharedSession: vi.fn(async (id: string) => sessions.get(id) ?? null),
    getSharedSessionByToken: vi.fn(async (token: string) => {
      for (const s of sessions.values()) {
        if (s.shareToken === token) return s;
      }
      return null;
    }),
    getSharedSessionsByRunId: vi.fn(async (runId: string) =>
      Array.from(sessions.values()).filter((s) => s.runId === runId && s.isActive),
    ),
    deactivateSharedSession: vi.fn(async (id: string) => {
      const s = sessions.get(id);
      if (s) sessions.set(id, { ...s, isActive: false });
    }),
    listActiveSharedSessions: vi.fn(async () =>
      Array.from(sessions.values()).filter((s) => s.isActive),
    ),
  } as unknown as IStorage;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("SessionSharingService", () => {
  let federation: ReturnType<typeof createMockFederation>;
  let storage: IStorage;
  let service: SessionSharingService;

  beforeEach(() => {
    federation = createMockFederation();
    storage = createMockStorage();
    service = new SessionSharingService(federation, storage, "local-instance");
  });

  // ── shareRun ────────────────────────────────────────────────────────────────

  it("creates a session and broadcasts offer on shareRun", async () => {
    const session = await service.shareRun("run-1", "user-1");

    expect(session.runId).toBe("run-1");
    expect(session.shareToken).toBeTruthy();
    expect(session.shareToken.length).toBe(48); // 24 bytes hex = 48 chars
    expect(session.ownerInstanceId).toBe("local-instance");
    expect(session.createdBy).toBe("user-1");
    expect(session.isActive).toBe(true);

    expect(storage.createSharedSession).toHaveBeenCalledTimes(1);

    // Check federation broadcast
    expect(federation._sentMessages).toHaveLength(1);
    expect(federation._sentMessages[0].type).toBe("session:offer");
    const payload = federation._sentMessages[0].payload as Record<string, unknown>;
    expect(payload.runId).toBe("run-1");
    expect(payload.shareToken).toBe(session.shareToken);
  });

  it("shareRun with expiresIn sets expiration date", async () => {
    const before = Date.now();
    const session = await service.shareRun("run-1", "user-1", 3600000);
    const after = Date.now();

    const call = (storage.createSharedSession as ReturnType<typeof vi.fn>).mock.calls[0][0] as CreateSharedSessionInput;
    expect(call.expiresAt).toBeDefined();
    const expiresMs = (call.expiresAt as Date).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 3600000);
    expect(expiresMs).toBeLessThanOrEqual(after + 3600000);
  });

  // ── subscribeToSession ──────────────────────────────────────────────────────

  it("sends session:subscribe via federation", () => {
    service.subscribeToSession("token-xyz");

    expect(federation._sentMessages).toHaveLength(1);
    expect(federation._sentMessages[0].type).toBe("session:subscribe");
    expect(federation._sentMessages[0].payload).toEqual({ shareToken: "token-xyz" });
  });

  // ── unsubscribeFromSession ──────────────────────────────────────────────────

  it("sends session:unsubscribe via federation", () => {
    service.unsubscribeFromSession("token-xyz");

    expect(federation._sentMessages).toHaveLength(1);
    expect(federation._sentMessages[0].type).toBe("session:unsubscribe");
    expect(federation._sentMessages[0].payload).toEqual({ shareToken: "token-xyz" });
  });

  // ── forwardEvent ────────────────────────────────────────────────────────────

  it("forwardEvent sends to subscribers only", () => {
    // Manually seed subscribers
    const subs = service._getSubscribers();
    subs.set("run-1", new Set(["peer-1", "peer-2"]));

    service.forwardEvent("run-1", { type: "stage:started", data: {} });

    expect(federation._sentMessages).toHaveLength(2);
    expect(federation._sentMessages[0].type).toBe("session:event");
    expect(federation._sentMessages[0].to).toBe("peer-1");
    expect(federation._sentMessages[1].to).toBe("peer-2");
  });

  it("forwardEvent does nothing when no subscribers", () => {
    service.forwardEvent("run-1", { type: "stage:started", data: {} });
    expect(federation._sentMessages).toHaveLength(0);
  });

  it("forwardEvent does nothing for unknown runId", () => {
    const subs = service._getSubscribers();
    subs.set("run-other", new Set(["peer-1"]));

    service.forwardEvent("run-1", { type: "stage:started", data: {} });
    expect(federation._sentMessages).toHaveLength(0);
  });

  // ── stopSharing ─────────────────────────────────────────────────────────────

  it("deactivates session and clears subscribers", async () => {
    // Create a session first
    const session = await service.shareRun("run-1", "user-1");
    federation._sentMessages.length = 0; // reset

    // Seed subscribers
    service._getSubscribers().set("run-1", new Set(["peer-1"]));

    await service.stopSharing(session.id);

    expect(storage.deactivateSharedSession).toHaveBeenCalledWith(session.id);
    expect(service._getSubscribers().has("run-1")).toBe(false);
  });

  // ── getActiveSessions ───────────────────────────────────────────────────────

  it("returns list from storage", async () => {
    await service.shareRun("run-1", "user-1");
    await service.shareRun("run-2", "user-2");

    const sessions = await service.getActiveSessions();
    expect(sessions).toHaveLength(2);
    expect(storage.listActiveSharedSessions).toHaveBeenCalled();
  });

  // ── handleSubscribe ─────────────────────────────────────────────────────────

  it("handleSubscribe adds peer to subscribers map", async () => {
    // Create a session so storage has it
    const session = await service.shareRun("run-1", "user-1");

    // Simulate incoming subscribe message
    const handler = federation._handlers.get("session:subscribe")![0];
    const msg: FederationMessage = {
      type: "session:subscribe",
      from: "peer-1",
      correlationId: "corr-1",
      payload: { shareToken: session.shareToken },
      hmac: "",
      timestamp: Date.now(),
    };
    await handler(msg, makePeer());

    const subs = service._getSubscribers().get("run-1");
    expect(subs).toBeDefined();
    expect(subs!.has("peer-1")).toBe(true);
  });

  // ── handleUnsubscribe ───────────────────────────────────────────────────────

  it("handleUnsubscribe removes peer from subscribers map", async () => {
    const session = await service.shareRun("run-1", "user-1");

    // Add subscriber first
    service._getSubscribers().set("run-1", new Set(["peer-1", "peer-2"]));

    const handler = federation._handlers.get("session:unsubscribe")![0];
    const msg: FederationMessage = {
      type: "session:unsubscribe",
      from: "peer-1",
      correlationId: "corr-2",
      payload: { shareToken: session.shareToken },
      hmac: "",
      timestamp: Date.now(),
    };
    await handler(msg, makePeer());

    const subs = service._getSubscribers().get("run-1");
    expect(subs).toBeDefined();
    expect(subs!.has("peer-1")).toBe(false);
    expect(subs!.has("peer-2")).toBe(true);
  });

  it("handleUnsubscribe cleans up empty subscriber set", async () => {
    const session = await service.shareRun("run-1", "user-1");
    service._getSubscribers().set("run-1", new Set(["peer-1"]));

    const handler = federation._handlers.get("session:unsubscribe")![0];
    const msg: FederationMessage = {
      type: "session:unsubscribe",
      from: "peer-1",
      correlationId: "corr-3",
      payload: { shareToken: session.shareToken },
      hmac: "",
      timestamp: Date.now(),
    };
    await handler(msg, makePeer());

    expect(service._getSubscribers().has("run-1")).toBe(false);
  });

  // ── expired sessions ────────────────────────────────────────────────────────

  it("handleSubscribe ignores expired sessions", async () => {
    // Create an expired session via mock
    const expiredSession = makeSession({
      shareToken: "expired-token",
      expiresAt: new Date(Date.now() - 1000), // 1s ago
    });
    (storage.getSharedSessionByToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce(expiredSession);

    const handler = federation._handlers.get("session:subscribe")![0];
    const msg: FederationMessage = {
      type: "session:subscribe",
      from: "peer-1",
      correlationId: "corr-exp",
      payload: { shareToken: "expired-token" },
      hmac: "",
      timestamp: Date.now(),
    };
    await handler(msg, makePeer());

    expect(service._getSubscribers().size).toBe(0);
  });

  // ── handleOffer ─────────────────────────────────────────────────────────────

  it("handleOffer stores remote offer", () => {
    const handler = federation._handlers.get("session:offer")![0];
    const msg: FederationMessage = {
      type: "session:offer",
      from: "peer-1",
      correlationId: "corr-offer",
      payload: {
        sessionId: "remote-session-1",
        runId: "remote-run-1",
        shareToken: "remote-token",
        ownerInstanceId: "peer-1",
        ownerName: "alice",
      },
      hmac: "",
      timestamp: Date.now(),
    };
    handler(msg, makePeer());

    const offers = service.getRemoteOffers();
    expect(offers).toHaveLength(1);
    expect(offers[0].shareToken).toBe("remote-token");
    expect(offers[0].ownerName).toBe("alice");
  });

  // ── shareToken uniqueness ───────────────────────────────────────────────────

  it("generates unique share tokens for each call", async () => {
    const s1 = await service.shareRun("run-1", "user-1");
    const s2 = await service.shareRun("run-1", "user-1");
    expect(s1.shareToken).not.toBe(s2.shareToken);
  });

  // ── handleSubscribe ignores inactive sessions ──────────────────────────────

  it("handleSubscribe ignores inactive sessions", async () => {
    const inactiveSession = makeSession({ shareToken: "inactive-token", isActive: false });
    (storage.getSharedSessionByToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce(inactiveSession);

    const handler = federation._handlers.get("session:subscribe")![0];
    const msg: FederationMessage = {
      type: "session:subscribe",
      from: "peer-1",
      correlationId: "corr-inactive",
      payload: { shareToken: "inactive-token" },
      hmac: "",
      timestamp: Date.now(),
    };
    await handler(msg, makePeer());

    expect(service._getSubscribers().size).toBe(0);
  });
});
