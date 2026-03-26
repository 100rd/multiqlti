import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
      });
      sessions.set(s.id, s);
      return s;
    }),
    getSharedSession: vi.fn(async (id: string) => sessions.get(id) ?? null),
    getSharedSessionByToken: vi.fn(async () => null),
    deactivateSharedSession: vi.fn(),
    listActiveSharedSessions: vi.fn(async () => []),
  } as unknown as IStorage;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("SessionSharingService -- Presence", () => {
  let federation: ReturnType<typeof createMockFederation>;
  let storage: IStorage;
  let service: SessionSharingService;

  beforeEach(() => {
    vi.useFakeTimers();
    federation = createMockFederation();
    storage = createMockStorage();
    service = new SessionSharingService(federation, storage, "local-instance");
  });

  afterEach(() => {
    service.stopPresenceSweep();
    vi.useRealTimers();
  });

  // ── recordPresence ────────────────────────────────────────────────────────

  it("records local presence and broadcasts via federation", () => {
    service.recordPresence("session-1", "user-alice");

    const entries = service.getSessionPresence("session-1");
    expect(entries).toHaveLength(1);
    expect(entries[0].userId).toBe("user-alice");
    expect(entries[0].instanceId).toBe("local-instance");

    // Check federation broadcast
    expect(federation._sentMessages).toHaveLength(1);
    expect(federation._sentMessages[0].type).toBe("session:presence");
    const payload = federation._sentMessages[0].payload as Record<string, unknown>;
    expect(payload.sessionId).toBe("session-1");
    expect(payload.userId).toBe("user-alice");
  });

  it("emits federation:user_joined on first heartbeat", () => {
    const events: Array<Record<string, unknown>> = [];
    service.onWsEvent((_runId, event) => events.push(event));

    service.recordPresence("session-1", "user-alice");

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("federation:user_joined");
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.userId).toBe("user-alice");
    expect(payload.sessionId).toBe("session-1");
  });

  it("does not emit join event on subsequent heartbeats", () => {
    const events: Array<Record<string, unknown>> = [];
    service.onWsEvent((_runId, event) => events.push(event));

    service.recordPresence("session-1", "user-alice");
    service.recordPresence("session-1", "user-alice");
    service.recordPresence("session-1", "user-alice");

    // Only one join event
    const joinEvents = events.filter((e) => e.type === "federation:user_joined");
    expect(joinEvents).toHaveLength(1);
  });

  // ── handlePresence (from remote peers) ────────────────────────────────────

  it("records presence from remote peer via federation message", () => {
    const handler = federation._handlers.get("session:presence")![0];
    handler(
      {
        type: "session:presence",
        from: "peer-1",
        correlationId: "c1",
        payload: { sessionId: "session-1", userId: "user-bob", instanceId: "peer-1" },
        hmac: "",
        timestamp: Date.now(),
      },
      makePeer(),
    );

    const entries = service.getSessionPresence("session-1");
    expect(entries).toHaveLength(1);
    expect(entries[0].userId).toBe("user-bob");
    expect(entries[0].instanceId).toBe("peer-1");
  });

  it("emits join event for remote presence", () => {
    const events: Array<Record<string, unknown>> = [];
    service.onWsEvent((_runId, event) => events.push(event));

    const handler = federation._handlers.get("session:presence")![0];
    handler(
      {
        type: "session:presence",
        from: "peer-1",
        correlationId: "c1",
        payload: { sessionId: "session-1", userId: "user-bob", instanceId: "peer-1" },
        hmac: "",
        timestamp: Date.now(),
      },
      makePeer(),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("federation:user_joined");
  });

  // ── getSessionPresence ────────────────────────────────────────────────────

  it("returns empty array for unknown session", () => {
    expect(service.getSessionPresence("nonexistent")).toEqual([]);
  });

  it("returns multiple users from different instances", () => {
    service.recordPresence("session-1", "user-alice");

    // Remote presence
    const handler = federation._handlers.get("session:presence")![0];
    handler(
      {
        type: "session:presence",
        from: "peer-1",
        correlationId: "c1",
        payload: { sessionId: "session-1", userId: "user-bob", instanceId: "peer-1" },
        hmac: "",
        timestamp: Date.now(),
      },
      makePeer(),
    );

    const entries = service.getSessionPresence("session-1");
    expect(entries).toHaveLength(2);
    const userIds = entries.map((e) => e.userId).sort();
    expect(userIds).toEqual(["user-alice", "user-bob"]);
  });

  // ── Presence timeout / sweep ──────────────────────────────────────────────

  it("sweeps expired entries after timeout", () => {
    const events: Array<Record<string, unknown>> = [];
    service.onWsEvent((_runId, event) => events.push(event));

    service.recordPresence("session-1", "user-alice");
    events.length = 0; // Clear join event

    // Advance past presence timeout (10s)
    vi.advanceTimersByTime(11_000);

    // Trigger manual sweep
    service._sweepExpiredPresence();

    const entries = service.getSessionPresence("session-1");
    expect(entries).toHaveLength(0);

    // Should have emitted a leave event
    const leaveEvents = events.filter((e) => e.type === "federation:user_left");
    expect(leaveEvents).toHaveLength(1);
    const payload = leaveEvents[0].payload as Record<string, unknown>;
    expect(payload.userId).toBe("user-alice");
  });

  it("keeps entries alive when heartbeat is refreshed", () => {
    service.recordPresence("session-1", "user-alice");

    // Advance 7 seconds (under 10s timeout)
    vi.advanceTimersByTime(7_000);

    // Refresh heartbeat
    service.recordPresence("session-1", "user-alice");

    // Advance another 7 seconds (14s total, but only 7s since last heartbeat)
    vi.advanceTimersByTime(7_000);
    service._sweepExpiredPresence();

    const entries = service.getSessionPresence("session-1");
    expect(entries).toHaveLength(1); // Still alive
  });

  it("cleans up empty session presence maps", () => {
    service.recordPresence("session-1", "user-alice");

    vi.advanceTimersByTime(11_000);
    service._sweepExpiredPresence();

    // The internal map for this session should be cleaned up
    const presenceMap = service._getPresenceMap();
    expect(presenceMap.has("session-1")).toBe(false);
  });

  // ── Automatic sweep interval ──────────────────────────────────────────────

  it("automatic sweep runs on interval", () => {
    const events: Array<Record<string, unknown>> = [];
    service.onWsEvent((_runId, event) => events.push(event));

    service.recordPresence("session-1", "user-alice");
    events.length = 0;

    // Advance past the sweep interval (5s) + timeout (10s)
    // At t=5s sweep runs but entry is fresh (5s < 10s timeout)
    // At t=10s sweep runs, entry is at 10s exactly (>= timeout), removed
    vi.advanceTimersByTime(15_000);

    const leaveEvents = events.filter((e) => e.type === "federation:user_left");
    expect(leaveEvents.length).toBeGreaterThanOrEqual(1);
  });

  // ── stopPresenceSweep ─────────────────────────────────────────────────────

  it("stops the sweep interval", () => {
    service.recordPresence("session-1", "user-alice");
    service.stopPresenceSweep();

    // Advance time -- no sweep should run
    vi.advanceTimersByTime(30_000);

    // The entry is stale but no sweep ran to clean it
    const presenceMap = service._getPresenceMap();
    expect(presenceMap.has("session-1")).toBe(true);
  });

  // ── Multiple sessions ─────────────────────────────────────────────────────

  it("tracks presence independently per session", () => {
    service.recordPresence("session-1", "user-alice");
    service.recordPresence("session-2", "user-bob");

    expect(service.getSessionPresence("session-1")).toHaveLength(1);
    expect(service.getSessionPresence("session-2")).toHaveLength(1);
    expect(service.getSessionPresence("session-1")[0].userId).toBe("user-alice");
    expect(service.getSessionPresence("session-2")[0].userId).toBe("user-bob");
  });
});
