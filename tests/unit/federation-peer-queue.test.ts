import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PeerQueueService,
  InMemoryPeerQueueStore,
  makeSendEventFn,
  newEventId,
  DEFAULT_TTL_MS,
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  type PeerQueueOptions,
  type SendEventFn,
} from "../../server/federation/peer-queue";
import {
  ConfigSyncService,
  InMemoryConfigSyncStore,
} from "../../server/federation/config-sync";
import type { FederationManager } from "../../server/federation/index";
import type { FederationMessage, PeerInfo } from "../../server/federation/types";
import type { IStorage } from "../../server/storage";

// ─── Test helpers ──────────────────────────────────────────────────────────────

function makePeer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    instanceId: "peer-a",
    instanceName: "Peer Alpha",
    endpoint: "ws://peer-a:9100",
    connectedAt: new Date(),
    lastMessageAt: new Date(),
    status: "connected",
    ...overrides,
  };
}

type MockFederation = FederationManager & {
  _handlers: Map<string, Array<(msg: FederationMessage, peer: PeerInfo) => void | Promise<void>>>;
  _sentMessages: Array<{ type: string; payload: unknown; to?: string }>;
  _simulateIncoming: (type: string, payload: unknown, peer: PeerInfo) => Promise<void>;
};

function createMockFederation(connectedPeers: PeerInfo[] = []): MockFederation {
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

    getPeers: vi.fn(() => connectedPeers),
    isEnabled: vi.fn(() => true),
    start: vi.fn(),
    stop: vi.fn(),

    async _simulateIncoming(type: string, payload: unknown, peer: PeerInfo) {
      const list = handlers.get(type) ?? [];
      for (const h of list) {
        await h(
          {
            type,
            from: peer.instanceId,
            correlationId: crypto.randomUUID(),
            payload,
            hmac: "test-hmac",
            timestamp: Date.now(),
          },
          peer,
        );
      }
    },
  } as unknown as MockFederation;
}

function createMockStorage(): IStorage {
  return {
    getPipelines: vi.fn(async () => []),
    createPipeline: vi.fn(async () => ({ id: "p-1", name: "x", stages: [], createdAt: new Date() })),
    updatePipeline: vi.fn(async () => ({ id: "p-1", name: "x", stages: [], createdAt: new Date() })),
    createTrigger: vi.fn(async () => ({})),
    updateTrigger: vi.fn(async () => ({})),
    createSkill: vi.fn(async () => ({})),
    updateSkill: vi.fn(async () => ({})),
  } as unknown as IStorage;
}

function makeAlwaysSucceedSendFn(): SendEventFn {
  return vi.fn(async () => true);
}

function makeAlwaysFailSendFn(): SendEventFn {
  return vi.fn(async () => false);
}

// ─── InMemoryPeerQueueStore ─────────────────────────────────────────────────────

describe("InMemoryPeerQueueStore", () => {
  let store: InMemoryPeerQueueStore;

  beforeEach(() => {
    store = new InMemoryPeerQueueStore();
  });

  it("enqueues a new event and returns false (not coalesced)", async () => {
    const result = await store.coalesceAndEnqueue("peer-1", "evt-1", "pipeline", "p-1");
    expect(result).toBe(false);
    const rows = await store.getPendingEvents("peer-1", 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe("evt-1");
    expect(rows[0].status).toBe("pending");
  });

  it("coalesces a second event for the same entity and returns true", async () => {
    await store.coalesceAndEnqueue("peer-1", "evt-1", "pipeline", "p-1");
    const result = await store.coalesceAndEnqueue("peer-1", "evt-2", "pipeline", "p-1");
    expect(result).toBe(true); // coalesced
    const rows = await store.getPendingEvents("peer-1", 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe("evt-2"); // newest kept
  });

  it("does not coalesce events for different entities", async () => {
    await store.coalesceAndEnqueue("peer-1", "evt-1", "pipeline", "p-1");
    await store.coalesceAndEnqueue("peer-1", "evt-2", "pipeline", "p-2");
    const rows = await store.getPendingEvents("peer-1", 100);
    expect(rows).toHaveLength(2);
  });

  it("does not coalesce events for different peers", async () => {
    await store.coalesceAndEnqueue("peer-1", "evt-1", "pipeline", "p-1");
    await store.coalesceAndEnqueue("peer-2", "evt-2", "pipeline", "p-1");
    const rows1 = await store.getPendingEvents("peer-1", 100);
    const rows2 = await store.getPendingEvents("peer-2", 100);
    expect(rows1).toHaveLength(1);
    expect(rows2).toHaveLength(1);
  });

  it("returns events ordered by enqueuedAt ASC", async () => {
    await store.coalesceAndEnqueue("peer-1", "evt-a", "pipeline", "p-a");
    // Force different timestamps by delaying slightly
    await new Promise((r) => setTimeout(r, 2));
    await store.coalesceAndEnqueue("peer-1", "evt-b", "trigger", "t-b");
    const rows = await store.getPendingEvents("peer-1", 100);
    expect(rows[0].eventId).toBe("evt-a");
    expect(rows[1].eventId).toBe("evt-b");
  });

  it("markSent transitions status to sent and removes from pending", async () => {
    await store.coalesceAndEnqueue("peer-1", "evt-1", "pipeline", "p-1");
    await store.markSent("peer-1", ["evt-1"]);
    const rows = await store.getPendingEvents("peer-1", 100);
    expect(rows).toHaveLength(0);
    expect(store.allRows()[0].status).toBe("sent");
  });

  it("recordRetryFailure increments retry_count and sets last_retry_at", async () => {
    await store.coalesceAndEnqueue("peer-1", "evt-1", "pipeline", "p-1");
    await store.recordRetryFailure("peer-1", ["evt-1"]);
    const row = store.allRows()[0];
    expect(row.retryCount).toBe(1);
    expect(row.lastRetryAt).toBeInstanceOf(Date);
  });

  it("deleteExpiredRows removes rows older than cutoff and returns affected peers", async () => {
    const oldDate = new Date(Date.now() - 10_000);
    await store.coalesceAndEnqueue("peer-1", "evt-1", "pipeline", "p-1");
    // Manually set enqueuedAt to past
    const row = store.allRows()[0];
    row.enqueuedAt = oldDate;

    const cutoff = new Date(Date.now() - 5_000);
    const affected = await store.deleteExpiredRows(cutoff);
    expect(affected.has("peer-1")).toBe(true);
    expect(store.allRows()).toHaveLength(0);
  });

  it("deleteExpiredRows does not remove rows newer than cutoff", async () => {
    await store.coalesceAndEnqueue("peer-1", "evt-1", "pipeline", "p-1");
    const cutoff = new Date(Date.now() - 10_000);
    const affected = await store.deleteExpiredRows(cutoff);
    expect(affected.size).toBe(0);
    expect(store.allRows()).toHaveLength(1);
  });

  it("countPending counts only pending rows for the given peer", async () => {
    await store.coalesceAndEnqueue("peer-1", "evt-1", "pipeline", "p-1");
    await store.coalesceAndEnqueue("peer-1", "evt-2", "pipeline", "p-2");
    await store.coalesceAndEnqueue("peer-2", "evt-3", "pipeline", "p-1");
    expect(await store.countPending("peer-1")).toBe(2);
    expect(await store.countPending("peer-2")).toBe(1);
  });

  it("oldestPendingEnqueuedAt returns oldest date for peer", async () => {
    const first = new Date(Date.now() - 5_000);
    await store.coalesceAndEnqueue("peer-1", "evt-1", "pipeline", "p-1");
    store.allRows()[0].enqueuedAt = first;
    await store.coalesceAndEnqueue("peer-1", "evt-2", "trigger", "t-1");

    const oldest = await store.oldestPendingEnqueuedAt("peer-1");
    expect(oldest?.getTime()).toBe(first.getTime());
  });

  it("oldestPendingEnqueuedAt returns null when queue is empty", async () => {
    const oldest = await store.oldestPendingEnqueuedAt("peer-1");
    expect(oldest).toBeNull();
  });
});

// ─── PeerQueueService — enqueue ───────────────────────────────────────────────

describe("PeerQueueService.enqueue", () => {
  let store: InMemoryPeerQueueStore;
  let service: PeerQueueService;

  beforeEach(() => {
    store = new InMemoryPeerQueueStore();
    service = new PeerQueueService(store);
  });

  it("enqueues a new event and returns 'enqueued'", async () => {
    const result = await service.enqueue("peer-1", "evt-1", "pipeline", "p-1");
    expect(result).toBe("enqueued");
  });

  it("coalesces a second event for the same entity and returns 'coalesced'", async () => {
    await service.enqueue("peer-1", "evt-1", "pipeline", "p-1");
    const result = await service.enqueue("peer-1", "evt-2", "pipeline", "p-1");
    expect(result).toBe("coalesced");
  });

  it("returns 'circuit_open' when circuit breaker is open", async () => {
    const alert = vi.fn();
    const lowThresholdService = new PeerQueueService(store, {
      circuitBreakerThreshold: 1,
      onCircuitOpen: alert,
    });
    await lowThresholdService.enqueue("peer-1", "evt-1", "pipeline", "p-1");
    // Threshold (1) reached — circuit opens
    expect(alert).toHaveBeenCalledWith("peer-1", 1);
    expect(lowThresholdService.isCircuitOpen("peer-1")).toBe(true);

    const result = await lowThresholdService.enqueue("peer-1", "evt-2", "trigger", "t-1");
    expect(result).toBe("circuit_open");
  });

  it("opens circuit breaker when queue depth exceeds threshold", async () => {
    const alert = vi.fn();
    const thresholdService = new PeerQueueService(store, {
      circuitBreakerThreshold: 2,
      onCircuitOpen: alert,
    });
    await thresholdService.enqueue("peer-1", "evt-1", "pipeline", "p-1");
    await thresholdService.enqueue("peer-1", "evt-2", "trigger", "t-1");
    expect(alert).toHaveBeenCalled();
    expect(thresholdService.isCircuitOpen("peer-1")).toBe(true);
  });

  it("does not open circuit for a different peer", async () => {
    const alert = vi.fn();
    const thresholdService = new PeerQueueService(store, {
      circuitBreakerThreshold: 1,
      onCircuitOpen: alert,
    });
    await thresholdService.enqueue("peer-1", "evt-1", "pipeline", "p-1");
    expect(thresholdService.isCircuitOpen("peer-2")).toBe(false);
  });
});

// ─── PeerQueueService — flush ─────────────────────────────────────────────────

describe("PeerQueueService.flush", () => {
  let store: InMemoryPeerQueueStore;
  let service: PeerQueueService;

  beforeEach(() => {
    store = new InMemoryPeerQueueStore();
    service = new PeerQueueService(store);
  });

  it("returns zeros when queue is empty", async () => {
    const result = await service.flush("peer-1", makeAlwaysSucceedSendFn());
    expect(result).toEqual({ sent: 0, failed: 0 });
  });

  it("sends pending events and marks them sent", async () => {
    await service.enqueue("peer-1", "evt-1", "pipeline", "p-1");
    await service.enqueue("peer-1", "evt-2", "trigger", "t-1");

    const result = await service.flush("peer-1", makeAlwaysSucceedSendFn());
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);

    const rows = await store.getPendingEvents("peer-1", 100);
    expect(rows).toHaveLength(0);
  });

  it("records retry failure when send fails", async () => {
    await service.enqueue("peer-1", "evt-1", "pipeline", "p-1");

    const result = await service.flush("peer-1", makeAlwaysFailSendFn());
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);

    const row = store.allRows()[0];
    expect(row.retryCount).toBe(1);
    expect(row.lastRetryAt).toBeInstanceOf(Date);
    expect(row.status).toBe("pending"); // still pending, not sent
  });

  it("flushes events in enqueued_at ASC order", async () => {
    const callOrder: string[] = [];
    const sendFn: SendEventFn = vi.fn(async (_peerId, eventId) => {
      callOrder.push(eventId);
      return true;
    });

    await store.coalesceAndEnqueue("peer-1", "evt-early", "pipeline", "p-1");
    await new Promise((r) => setTimeout(r, 2));
    await store.coalesceAndEnqueue("peer-1", "evt-later", "trigger", "t-1");

    await service.flush("peer-1", sendFn);
    expect(callOrder).toEqual(["evt-early", "evt-later"]);
  });

  it("resets the circuit breaker on flush (reconnect)", async () => {
    const thresholdService = new PeerQueueService(store, {
      circuitBreakerThreshold: 1,
    });
    await thresholdService.enqueue("peer-1", "evt-1", "pipeline", "p-1");
    expect(thresholdService.isCircuitOpen("peer-1")).toBe(true);

    await thresholdService.flush("peer-1", makeAlwaysSucceedSendFn());
    expect(thresholdService.isCircuitOpen("peer-1")).toBe(false);
  });

  it("only flushes the target peer's events", async () => {
    await service.enqueue("peer-1", "evt-1", "pipeline", "p-1");
    await service.enqueue("peer-2", "evt-2", "pipeline", "p-1");

    const result = await service.flush("peer-1", makeAlwaysSucceedSendFn());
    expect(result.sent).toBe(1);

    const peer2Rows = await store.getPendingEvents("peer-2", 100);
    expect(peer2Rows).toHaveLength(1); // peer-2 queue untouched
  });
});

// ─── PeerQueueService — TTL pruning ───────────────────────────────────────────

describe("PeerQueueService.pruneTTL", () => {
  it("prunes expired events and signals affected peers", async () => {
    const store = new InMemoryPeerQueueStore();
    const resyncSignals: string[] = [];
    const service = new PeerQueueService(store, {
      ttlMs: 1_000, // 1 second TTL for testing
      onResyncRequired: (signal) => resyncSignals.push(signal.peerId),
    });

    await service.enqueue("peer-1", "evt-1", "pipeline", "p-1");
    // Age the event past the TTL
    store.allRows()[0].enqueuedAt = new Date(Date.now() - 2_000);

    const affected = await service.pruneTTL();
    expect(affected.has("peer-1")).toBe(true);
    expect(resyncSignals).toContain("peer-1");
    expect(store.allRows()).toHaveLength(0);
  });

  it("does not prune events within TTL", async () => {
    const store = new InMemoryPeerQueueStore();
    const service = new PeerQueueService(store, { ttlMs: DEFAULT_TTL_MS });
    await service.enqueue("peer-1", "evt-1", "pipeline", "p-1");

    const affected = await service.pruneTTL();
    expect(affected.size).toBe(0);
    expect(store.allRows()).toHaveLength(1);
  });

  it("sends resync signal once per peer even with multiple expired events", async () => {
    const store = new InMemoryPeerQueueStore();
    const resyncSignals: string[] = [];
    const service = new PeerQueueService(store, {
      ttlMs: 1_000,
      onResyncRequired: (s) => resyncSignals.push(s.peerId),
    });

    await service.enqueue("peer-1", "evt-1", "pipeline", "p-1");
    await service.enqueue("peer-1", "evt-2", "trigger", "t-1");

    for (const row of store.allRows()) {
      row.enqueuedAt = new Date(Date.now() - 2_000);
    }

    await service.pruneTTL();
    // Should have signalled peer-1 exactly once (Set deduplication in store return)
    expect(resyncSignals.filter((p) => p === "peer-1")).toHaveLength(1);
  });
});

// ─── PeerQueueService — circuit breaker ──────────────────────────────────────

describe("PeerQueueService circuit breaker", () => {
  it("isCircuitOpen returns false by default", () => {
    const store = new InMemoryPeerQueueStore();
    const service = new PeerQueueService(store);
    expect(service.isCircuitOpen("peer-1")).toBe(false);
  });

  it("resetCircuit closes an open circuit", async () => {
    const store = new InMemoryPeerQueueStore();
    const service = new PeerQueueService(store, { circuitBreakerThreshold: 1 });
    await service.enqueue("peer-1", "evt-1", "pipeline", "p-1");
    expect(service.isCircuitOpen("peer-1")).toBe(true);

    service.resetCircuit("peer-1");
    expect(service.isCircuitOpen("peer-1")).toBe(false);
  });

  it("circuit open for peer-1 does not affect peer-2", async () => {
    const store = new InMemoryPeerQueueStore();
    // threshold=2: peer-1 will get 2 events (opens circuit), peer-2 gets 1 (stays under)
    const service = new PeerQueueService(store, { circuitBreakerThreshold: 2 });
    await service.enqueue("peer-1", "evt-1", "pipeline", "p-1");
    await service.enqueue("peer-1", "evt-2", "trigger", "t-1");
    expect(service.isCircuitOpen("peer-1")).toBe(true);

    const result = await service.enqueue("peer-2", "evt-3", "pipeline", "p-1");
    expect(result).toBe("enqueued");
    expect(service.isCircuitOpen("peer-2")).toBe(false);
  });
});

// ─── PeerQueueService — metrics ───────────────────────────────────────────────

describe("PeerQueueService.getMetrics", () => {
  it("returns zero metrics for an empty queue", async () => {
    const store = new InMemoryPeerQueueStore();
    const service = new PeerQueueService(store);
    const m = await service.getMetrics("peer-1");
    expect(m.peerId).toBe("peer-1");
    expect(m.pendingDepth).toBe(0);
    expect(m.oldestEventAgeMs).toBe(0);
    expect(m.coalesceRatio).toBe(0);
    expect(m.circuitOpen).toBe(false);
  });

  it("reflects queue depth after enqueueing", async () => {
    const store = new InMemoryPeerQueueStore();
    const service = new PeerQueueService(store);
    await service.enqueue("peer-1", "evt-1", "pipeline", "p-1");
    await service.enqueue("peer-1", "evt-2", "trigger", "t-1");
    const m = await service.getMetrics("peer-1");
    expect(m.pendingDepth).toBe(2);
  });

  it("reports non-zero oldestEventAgeMs when queue has items", async () => {
    const store = new InMemoryPeerQueueStore();
    const service = new PeerQueueService(store);
    await service.enqueue("peer-1", "evt-1", "pipeline", "p-1");
    // Age the event
    store.allRows()[0].enqueuedAt = new Date(Date.now() - 5_000);
    const m = await service.getMetrics("peer-1");
    expect(m.oldestEventAgeMs).toBeGreaterThan(4_000);
  });

  it("calculates coalesceRatio correctly", async () => {
    const store = new InMemoryPeerQueueStore();
    const service = new PeerQueueService(store);
    await service.enqueue("peer-1", "evt-1", "pipeline", "p-1"); // enqueued
    await service.enqueue("peer-1", "evt-2", "pipeline", "p-1"); // coalesced
    await service.enqueue("peer-1", "evt-3", "trigger", "t-1"); // enqueued
    const m = await service.getMetrics("peer-1");
    // 3 enqueued total, 1 coalesced
    expect(m.coalesceRatio).toBeCloseTo(1 / 3, 5);
  });

  it("reflects circuit open state in metrics", async () => {
    const store = new InMemoryPeerQueueStore();
    const service = new PeerQueueService(store, { circuitBreakerThreshold: 1 });
    await service.enqueue("peer-1", "evt-1", "pipeline", "p-1");
    const m = await service.getMetrics("peer-1");
    expect(m.circuitOpen).toBe(true);
  });
});

// ─── ConfigSyncService integration with PeerQueueService ──────────────────────

describe("ConfigSyncService + PeerQueueService integration", () => {
  let syncStore: InMemoryConfigSyncStore;
  let queueStore: InMemoryPeerQueueStore;
  let peerQueue: PeerQueueService;
  let federation: MockFederation;
  let storage: IStorage;
  let service: ConfigSyncService;
  const peer = makePeer({ instanceId: "peer-a" });

  beforeEach(() => {
    syncStore = new InMemoryConfigSyncStore();
    queueStore = new InMemoryPeerQueueStore();
    peerQueue = new PeerQueueService(queueStore);
    federation = createMockFederation([peer]);
    storage = createMockStorage();
    service = new ConfigSyncService(
      federation as unknown as FederationManager,
      storage,
      syncStore,
      "local",
      undefined,
      { peerQueue },
    );
  });

  it("enqueues event in offline queue when peer send fails", async () => {
    // Simulate send failure by making federation.send throw
    vi.spyOn(federation, "send").mockImplementationOnce(() => {
      throw new Error("peer unreachable");
    });

    const eventId = await service.enqueueConfigEvent("pipeline", "p-1", "update", { name: "test" });
    await service.publishPending();

    const pending = await queueStore.getPendingEvents("peer-a", 100);
    expect(pending).toHaveLength(1);
    expect(pending[0].eventId).toBe(eventId);
  });

  it("does not enqueue in offline queue when peer send succeeds", async () => {
    await service.enqueueConfigEvent("pipeline", "p-1", "update", { name: "test" });
    await service.publishPending();

    const pending = await queueStore.getPendingEvents("peer-a", 100);
    expect(pending).toHaveLength(0);
  });

  it("marks outbox sent_at only when delivered to all peers", async () => {
    await service.enqueueConfigEvent("pipeline", "p-1", "update", { name: "test" });
    await service.publishPending();

    const outboxRows = syncStore.getAllOutboxRows();
    expect(outboxRows[0].sentAt).not.toBeNull();
  });

  it("does not mark outbox sent_at when at least one peer fails", async () => {
    vi.spyOn(federation, "send").mockImplementationOnce(() => {
      throw new Error("peer unreachable");
    });

    await service.enqueueConfigEvent("pipeline", "p-1", "update", { name: "test" });
    await service.publishPending();

    const outboxRows = syncStore.getAllOutboxRows();
    expect(outboxRows[0].sentAt).toBeNull();
  });

  it("flushes offline queue when heartbeat is received", async () => {
    // Put an event in the queue directly
    await queueStore.coalesceAndEnqueue("peer-a", "evt-manual", "pipeline", "p-1");

    // Provide a flush send fn that always succeeds
    const flushSendFn: SendEventFn = vi.fn(async () => true);
    const serviceWithFlush = new ConfigSyncService(
      federation as unknown as FederationManager,
      storage,
      syncStore,
      "local",
      undefined,
      { peerQueue, flushSendFn },
    );

    await federation._simulateIncoming("peer:heartbeat", {}, peer);
    // Heartbeat triggers flush — wait a tick for the async handler
    await new Promise((r) => setTimeout(r, 10));

    const pending = await queueStore.getPendingEvents("peer-a", 100);
    expect(pending).toHaveLength(0);

    // Suppress unused variable warning
    void serviceWithFlush;
  });

  it("flushPeer sends queued events and returns counts", async () => {
    await queueStore.coalesceAndEnqueue("peer-a", "evt-1", "pipeline", "p-1");
    await queueStore.coalesceAndEnqueue("peer-a", "evt-2", "trigger", "t-1");

    const flushSendFn: SendEventFn = vi.fn(async () => true);
    const serviceWithFlush = new ConfigSyncService(
      federation as unknown as FederationManager,
      storage,
      syncStore,
      "local",
      undefined,
      { peerQueue, flushSendFn },
    );

    const result = await serviceWithFlush.flushPeer("peer-a");
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("flushPeer returns zeros when no peerQueue is configured", async () => {
    const serviceNoQueue = new ConfigSyncService(
      federation as unknown as FederationManager,
      storage,
      syncStore,
      "local",
    );
    const result = await serviceNoQueue.flushPeer("peer-a");
    expect(result).toEqual({ sent: 0, failed: 0 });
  });
});

// ─── Coalesce — only latest event per entity is kept ────────────────────────────

describe("Coalesce: only latest event per entity is kept", () => {
  it("keeps only the most recent event after multiple updates to the same entity", async () => {
    const store = new InMemoryPeerQueueStore();
    const service = new PeerQueueService(store);

    await service.enqueue("peer-1", "evt-v1", "pipeline", "p-1");
    await service.enqueue("peer-1", "evt-v2", "pipeline", "p-1");
    await service.enqueue("peer-1", "evt-v3", "pipeline", "p-1");

    const rows = await store.getPendingEvents("peer-1", 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe("evt-v3");
  });

  it("different entity kinds do not coalesce with each other", async () => {
    const store = new InMemoryPeerQueueStore();
    const service = new PeerQueueService(store);

    await service.enqueue("peer-1", "evt-1", "pipeline", "e-1");
    await service.enqueue("peer-1", "evt-2", "trigger", "e-1"); // same entity id, different kind
    const rows = await store.getPendingEvents("peer-1", 100);
    expect(rows).toHaveLength(2);
  });
});

// ─── Full resync signal ────────────────────────────────────────────────────────

describe("Full resync signal on TTL expiry", () => {
  it("signals resync with reason ttl_expired", async () => {
    const store = new InMemoryPeerQueueStore();
    const signals: Array<{ peerId: string; reason: string }> = [];
    const service = new PeerQueueService(store, {
      ttlMs: 1_000,
      onResyncRequired: (s) => signals.push({ peerId: s.peerId, reason: s.reason }),
    });

    await service.enqueue("peer-1", "evt-1", "pipeline", "p-1");
    store.allRows()[0].enqueuedAt = new Date(Date.now() - 2_000);

    await service.pruneTTL();
    expect(signals).toHaveLength(1);
    expect(signals[0].reason).toBe("ttl_expired");
    expect(signals[0].peerId).toBe("peer-1");
  });

  it("no signal when no events expire", async () => {
    const store = new InMemoryPeerQueueStore();
    const signals: string[] = [];
    const service = new PeerQueueService(store, {
      ttlMs: DEFAULT_TTL_MS,
      onResyncRequired: (s) => signals.push(s.peerId),
    });

    await service.enqueue("peer-1", "evt-1", "pipeline", "p-1");
    await service.pruneTTL();
    expect(signals).toHaveLength(0);
  });
});

// ─── makeSendEventFn helper ───────────────────────────────────────────────────

describe("makeSendEventFn", () => {
  it("wraps a raw send function and passes correct arguments", async () => {
    const rawSend = vi.fn(async () => true);
    const sendFn = makeSendEventFn(rawSend);

    const ok = await sendFn(
      "peer-1",
      "evt-1",
      "pipeline",
      "p-1",
      "update",
      { name: "test" },
    );

    expect(ok).toBe(true);
    expect(rawSend).toHaveBeenCalledWith("peer-1", "config:event", {
      eventId: "evt-1",
      entityKind: "pipeline",
      entityId: "p-1",
      operation: "update",
      payload: { name: "test" },
    });
  });

  it("returns false when raw send fails", async () => {
    const rawSend = vi.fn(async () => false);
    const sendFn = makeSendEventFn(rawSend);
    const ok = await sendFn("peer-1", "evt-1", "pipeline", "p-1", "update", {});
    expect(ok).toBe(false);
  });
});
