import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ConfigSyncService,
  InMemoryConfigSyncStore,
  makeEnqueuer,
  defaultApplyOne,
  type ConfigEventPayload,
  type ApplyOneFn,
} from "../../server/federation/config-sync";
import type { FederationManager } from "../../server/federation/index";
import type { FederationMessage, PeerInfo } from "../../server/federation/types";
import type { IStorage } from "../../server/storage";
import type { ConfigEventOperation } from "../../shared/schema";

// ── Test helpers ───────────────────────────────────────────────────────────────

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

type MockFederation = FederationManager & {
  _handlers: Map<string, Array<(msg: FederationMessage, peer: PeerInfo) => void | Promise<void>>>;
  _sentMessages: Array<{ type: string; payload: unknown; to?: string }>;
  _simulateIncoming: (type: string, payload: unknown, peer: PeerInfo) => Promise<void>;
};

function createMockFederation(connectedPeers: PeerInfo[] = []): MockFederation {
  const handlers = new Map<string, Array<(msg: FederationMessage, peer: PeerInfo) => void | Promise<void>>>();
  const sentMessages: Array<{ type: string; payload: unknown; to?: string }> = [];

  const fm = {
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

  return fm;
}

function createMockStorage(): IStorage {
  return {
    getPipelines: vi.fn(async () => []),
    createPipeline: vi.fn(async (data: { name: string }) => ({
      id: crypto.randomUUID(),
      name: data.name,
      description: null,
      stages: [],
      dag: null,
      isTemplate: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    updatePipeline: vi.fn(async () => undefined),
    deletePipeline: vi.fn(async () => undefined),
    createTrigger: vi.fn(async () => ({ id: crypto.randomUUID() })),
    updateTrigger: vi.fn(async () => undefined),
    createSkill: vi.fn(async () => ({ id: crypto.randomUUID() })),
    updateSkill: vi.fn(async () => undefined),
    deleteSkill: vi.fn(async () => undefined),
  } as unknown as IStorage;
}

// ── InMemoryConfigSyncStore ────────────────────────────────────────────────────

describe("InMemoryConfigSyncStore", () => {
  let store: InMemoryConfigSyncStore;

  beforeEach(() => {
    store = new InMemoryConfigSyncStore();
  });

  it("insertConfigEvent assigns a unique id and stores the row", async () => {
    const id = await store.insertConfigEvent("pipeline", "pipe-1", "create", { name: "P1" });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const rows = store.getAllOutboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].entityKind).toBe("pipeline");
    expect(rows[0].operation).toBe("create");
    expect(rows[0].sentAt).toBeNull();
  });

  it("getUnsentConfigEvents returns only unsent rows ordered by createdAt", async () => {
    await store.insertConfigEvent("pipeline", "p1", "create", {});
    await store.insertConfigEvent("trigger", "t1", "update", {});

    const unsent = await store.getUnsentConfigEvents(10);
    expect(unsent).toHaveLength(2);
    expect(unsent[0].entityKind).toBe("pipeline");
    expect(unsent[1].entityKind).toBe("trigger");
  });

  it("getUnsentConfigEvents respects the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await store.insertConfigEvent("pipeline", `p-${i}`, "create", {});
    }
    const unsent = await store.getUnsentConfigEvents(3);
    expect(unsent).toHaveLength(3);
  });

  it("markConfigEventsSent stamps sent_at and excludes from future unsent queries", async () => {
    const id1 = await store.insertConfigEvent("pipeline", "p1", "create", {});
    const id2 = await store.insertConfigEvent("pipeline", "p2", "update", {});

    await store.markConfigEventsSent([id1]);

    const unsent = await store.getUnsentConfigEvents(10);
    expect(unsent).toHaveLength(1);
    expect(unsent[0].id).toBe(id2);

    const row = store.getAllOutboxRows().find((r) => r.id === id1);
    expect(row?.sentAt).not.toBeNull();
  });

  it("markConfigEventsSent with empty array is a no-op", async () => {
    await store.insertConfigEvent("pipeline", "p1", "create", {});
    await store.markConfigEventsSent([]);
    const unsent = await store.getUnsentConfigEvents(10);
    expect(unsent).toHaveLength(1);
  });

  it("recordConfigEventReceived returns true for first occurrence", async () => {
    const result = await store.recordConfigEventReceived("peer-1", "pipeline", "p1", "v1");
    expect(result).toBe(true);
  });

  it("recordConfigEventReceived returns false for duplicate key", async () => {
    await store.recordConfigEventReceived("peer-1", "pipeline", "p1", "v1");
    const result = await store.recordConfigEventReceived("peer-1", "pipeline", "p1", "v1");
    expect(result).toBe(false);
  });

  it("different version is treated as a new event (not a duplicate)", async () => {
    await store.recordConfigEventReceived("peer-1", "pipeline", "p1", "v1");
    const result = await store.recordConfigEventReceived("peer-1", "pipeline", "p1", "v2");
    expect(result).toBe(true);
  });

  it("same key from different peer is not a duplicate", async () => {
    await store.recordConfigEventReceived("peer-1", "pipeline", "p1", "v1");
    const result = await store.recordConfigEventReceived("peer-2", "pipeline", "p1", "v1");
    expect(result).toBe(true);
  });

  it("reset clears all state", async () => {
    await store.insertConfigEvent("pipeline", "p1", "create", {});
    await store.recordConfigEventReceived("peer-1", "pipeline", "p1", "v1");

    store.reset();

    expect(store.getAllOutboxRows()).toHaveLength(0);
    const result = await store.recordConfigEventReceived("peer-1", "pipeline", "p1", "v1");
    expect(result).toBe(true);
  });
});

// ── ConfigSyncService — enqueueConfigEvent ────────────────────────────────────

describe("ConfigSyncService.enqueueConfigEvent", () => {
  let fm: MockFederation;
  let store: InMemoryConfigSyncStore;
  let storage: IStorage;
  let service: ConfigSyncService;

  beforeEach(() => {
    fm = createMockFederation();
    store = new InMemoryConfigSyncStore();
    storage = createMockStorage();
    service = new ConfigSyncService(fm, storage, store, "instance-1");
  });

  it("inserts an outbox row and returns its id", async () => {
    const id = await service.enqueueConfigEvent("pipeline", "pipe-1", "create", { name: "P1" });
    expect(typeof id).toBe("string");
    expect(store.getAllOutboxRows()).toHaveLength(1);
  });

  it("enqueues multiple events independently", async () => {
    await service.enqueueConfigEvent("pipeline", "p1", "create", {});
    await service.enqueueConfigEvent("trigger", "t1", "update", {});
    await service.enqueueConfigEvent("pipeline", "p1", "delete", {});
    expect(store.getAllOutboxRows()).toHaveLength(3);
  });
});

// ── ConfigSyncService — publisher loop ───────────────────────────────────────

describe("ConfigSyncService.publishPending", () => {
  let fm: MockFederation;
  let store: InMemoryConfigSyncStore;
  let storage: IStorage;
  let service: ConfigSyncService;
  const peer = makePeer();

  beforeEach(() => {
    fm = createMockFederation([peer]);
    store = new InMemoryConfigSyncStore();
    storage = createMockStorage();
    service = new ConfigSyncService(fm, storage, store, "instance-1");
  });

  it("does nothing when there are no peers", async () => {
    const noFm = createMockFederation([]);
    const svc = new ConfigSyncService(noFm, storage, store, "instance-1");
    await svc.enqueueConfigEvent("pipeline", "p1", "create", {});
    await svc.publishPending();
    expect(noFm._sentMessages).toHaveLength(0);
    const unsent = await store.getUnsentConfigEvents(10);
    expect(unsent).toHaveLength(1);
  });

  it("does nothing when outbox is empty", async () => {
    await service.publishPending();
    expect(fm._sentMessages).toHaveLength(0);
  });

  it("broadcasts unsent events and marks them as sent", async () => {
    await service.enqueueConfigEvent("pipeline", "p1", "create", { name: "P1" });
    await service.enqueueConfigEvent("trigger", "t1", "update", { pipelineId: "p1" });

    await service.publishPending();

    expect(fm._sentMessages).toHaveLength(2);
    expect(fm._sentMessages[0].type).toBe("config:event");
    expect(fm._sentMessages[1].type).toBe("config:event");

    const unsent = await store.getUnsentConfigEvents(10);
    expect(unsent).toHaveLength(0);
  });

  it("event payload contains correct structure", async () => {
    await service.enqueueConfigEvent("pipeline", "p1", "create", { name: "TestPipeline" });
    await service.publishPending();

    expect(fm._sentMessages).toHaveLength(1);
    const sent = fm._sentMessages[0].payload as {
      from: string;
      event: ConfigEventPayload;
    };
    expect(sent.from).toBe("instance-1");
    expect(sent.event.entityKind).toBe("pipeline");
    expect(sent.event.entityId).toBe("p1");
    expect(sent.event.operation).toBe("create");
    expect(sent.event.payload).toEqual({ name: "TestPipeline" });
    expect(typeof sent.event.version).toBe("string");
    expect(typeof sent.event.issuedAt).toBe("string");
  });

  it("does not re-publish already-sent events", async () => {
    await service.enqueueConfigEvent("pipeline", "p1", "create", {});
    await service.publishPending();
    fm._sentMessages.length = 0;

    await service.publishPending();
    expect(fm._sentMessages).toHaveLength(0);
  });

  it("start/stop controls the polling timer", () => {
    service.start();
    expect(() => service.start()).not.toThrow(); // double-start is safe
    service.stop();
    expect(() => service.stop()).not.toThrow(); // double-stop is safe
  });
});

// ── ConfigSyncService — subscriber handler ────────────────────────────────────

describe("ConfigSyncService subscriber", () => {
  let fm: MockFederation;
  let store: InMemoryConfigSyncStore;
  let storage: IStorage;
  let applyOne: ReturnType<typeof vi.fn>;
  let service: ConfigSyncService;
  const peer = makePeer();

  beforeEach(() => {
    fm = createMockFederation([peer]);
    store = new InMemoryConfigSyncStore();
    storage = createMockStorage();
    applyOne = vi.fn(async () => {});
    service = new ConfigSyncService(fm, storage, store, "instance-1", applyOne as ApplyOneFn);
  });

  function buildEventMessage(event: Partial<ConfigEventPayload> = {}): Record<string, unknown> {
    return {
      from: peer.instanceId,
      event: {
        entityKind: "pipeline",
        entityId: "pipe-1",
        operation: "create",
        payload: { name: "P1" },
        version: new Date().toISOString(),
        issuedAt: new Date().toISOString(),
        ...event,
      },
    };
  }

  it("applies a valid incoming event", async () => {
    await fm._simulateIncoming("config:event", buildEventMessage(), peer);
    expect(applyOne).toHaveBeenCalledTimes(1);
    expect(applyOne).toHaveBeenCalledWith(
      "pipeline",
      "pipe-1",
      "create",
      { name: "P1" },
      storage,
    );
  });

  it("deduplicates: second event with same key is ignored", async () => {
    const msg = buildEventMessage({ version: "v-fixed" });
    await fm._simulateIncoming("config:event", msg, peer);
    await fm._simulateIncoming("config:event", msg, peer);
    expect(applyOne).toHaveBeenCalledTimes(1);
  });

  it("applies event with different version as a new event", async () => {
    await fm._simulateIncoming("config:event", buildEventMessage({ version: "v1" }), peer);
    await fm._simulateIncoming("config:event", buildEventMessage({ version: "v2" }), peer);
    expect(applyOne).toHaveBeenCalledTimes(2);
  });

  it("records idempotency key after first application", async () => {
    const version = new Date().toISOString();
    await fm._simulateIncoming("config:event", buildEventMessage({ version }), peer);

    // Verify the key was recorded
    const isNew = await store.recordConfigEventReceived("peer-1", "pipeline", "pipe-1", version);
    expect(isNew).toBe(false);
  });

  it("ignores messages with missing event wrapper", async () => {
    await fm._simulateIncoming("config:event", { from: "peer-1" }, peer);
    expect(applyOne).not.toHaveBeenCalled();
  });

  it("ignores messages with null payload", async () => {
    await fm._simulateIncoming("config:event", null, peer);
    expect(applyOne).not.toHaveBeenCalled();
  });

  it("ignores events with missing entityKind", async () => {
    const msg = buildEventMessage({ entityKind: "" });
    await fm._simulateIncoming("config:event", msg, peer);
    expect(applyOne).not.toHaveBeenCalled();
  });

  it("ignores events with invalid operation", async () => {
    const msg = buildEventMessage({ operation: "upsert" as ConfigEventOperation });
    await fm._simulateIncoming("config:event", msg, peer);
    expect(applyOne).not.toHaveBeenCalled();
  });

  it("ignores events with empty version string", async () => {
    const msg = buildEventMessage({ version: "" });
    await fm._simulateIncoming("config:event", msg, peer);
    expect(applyOne).not.toHaveBeenCalled();
  });

  it("events from different peers with same key are both applied", async () => {
    const peer2 = makePeer({ instanceId: "peer-2" });
    const version = "v-same";

    await fm._simulateIncoming("config:event", buildEventMessage({ version }), peer);
    await fm._simulateIncoming("config:event", buildEventMessage({ version }), peer2);

    expect(applyOne).toHaveBeenCalledTimes(2);
  });
});

// ── makeEnqueuer helper ────────────────────────────────────────────────────────

describe("makeEnqueuer", () => {
  it("returns a no-op function when service is null", async () => {
    const enqueue = makeEnqueuer(null);
    await expect(enqueue("pipeline", "p1", "create", {})).resolves.toBeUndefined();
  });

  it("delegates to service.enqueueConfigEvent", async () => {
    const fm = createMockFederation();
    const store = new InMemoryConfigSyncStore();
    const storage = createMockStorage();
    const service = new ConfigSyncService(fm, storage, store, "instance-1");

    const enqueue = makeEnqueuer(service);
    await enqueue("pipeline", "p1", "create", { name: "P1" });

    expect(store.getAllOutboxRows()).toHaveLength(1);
  });
});

// ── defaultApplyOne — pipeline routing ────────────────────────────────────────

describe("defaultApplyOne — pipeline", () => {
  let storage: IStorage;

  beforeEach(() => {
    storage = createMockStorage();
  });

  it("creates a pipeline on create operation", async () => {
    await defaultApplyOne(
      "pipeline",
      "p1",
      "create",
      { name: "My Pipeline", stages: [], isTemplate: false },
      storage,
    );
    expect(storage.createPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ name: "My Pipeline" }),
    );
  });

  it("updates existing pipeline on update operation", async () => {
    const mockStorage = {
      ...storage,
      getPipelines: vi.fn(async () => [
        { id: "pipe-existing", name: "My Pipeline", stages: [], isTemplate: false, createdAt: new Date(), updatedAt: new Date() },
      ]),
      updatePipeline: vi.fn(async () => undefined),
    } as unknown as IStorage;

    await defaultApplyOne(
      "pipeline",
      "pipe-existing",
      "update",
      { name: "My Pipeline", description: "Updated" },
      mockStorage,
    );
    expect(mockStorage.updatePipeline).toHaveBeenCalledWith(
      "pipe-existing",
      expect.objectContaining({ name: "My Pipeline" }),
    );
  });

  it("skips delete operation without error", async () => {
    await expect(
      defaultApplyOne("pipeline", "p1", "delete", {}, storage),
    ).resolves.toBeUndefined();
    expect(storage.createPipeline).not.toHaveBeenCalled();
  });

  it("skips create when name is missing", async () => {
    await defaultApplyOne("pipeline", "p1", "create", {}, storage);
    expect(storage.createPipeline).not.toHaveBeenCalled();
  });

  it("silently ignores unknown entity kind", async () => {
    await expect(
      defaultApplyOne("unknown-kind", "id-1", "create", {}, storage),
    ).resolves.toBeUndefined();
  });
});

// ── defaultApplyOne — trigger routing ────────────────────────────────────────

describe("defaultApplyOne — trigger", () => {
  let storage: IStorage;

  beforeEach(() => {
    storage = createMockStorage();
  });

  it("creates a trigger on create operation", async () => {
    await defaultApplyOne(
      "trigger",
      "t1",
      "create",
      { pipelineId: "pipe-1", enabled: true, config: { type: "webhook" } },
      storage,
    );
    expect(storage.createTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ pipelineId: "pipe-1", enabled: true }),
    );
  });

  it("updates a trigger on update operation with id", async () => {
    await defaultApplyOne(
      "trigger",
      "t1",
      "update",
      { id: "trigger-abc", pipelineId: "pipe-1", enabled: false, config: { type: "webhook" } },
      storage,
    );
    expect(storage.updateTrigger).toHaveBeenCalledWith(
      "trigger-abc",
      expect.objectContaining({ enabled: false }),
    );
  });

  it("skips trigger create without pipelineId", async () => {
    await defaultApplyOne("trigger", "t1", "create", {}, storage);
    expect(storage.createTrigger).not.toHaveBeenCalled();
  });
});

// ── Full publish/subscribe round-trip ─────────────────────────────────────────

describe("publish/subscribe round-trip", () => {
  it("event enqueued by sender is received and applied by subscriber", async () => {
    const senderPeer = makePeer({ instanceId: "sender" });
    const receiverPeer = makePeer({ instanceId: "receiver" });

    // Sender setup
    const senderFm = createMockFederation([receiverPeer]);
    const senderStore = new InMemoryConfigSyncStore();
    const senderStorage = createMockStorage();
    const sender = new ConfigSyncService(senderFm, senderStorage, senderStore, "sender");

    // Receiver setup
    const receiverFm = createMockFederation([senderPeer]);
    const receiverStore = new InMemoryConfigSyncStore();
    const receiverStorage = createMockStorage();
    const receivedApplyOne = vi.fn(async () => {});
    new ConfigSyncService(receiverFm, receiverStorage, receiverStore, "receiver", receivedApplyOne as ApplyOneFn);

    // Sender enqueues an event
    await sender.enqueueConfigEvent("pipeline", "pipe-1", "create", { name: "Shared Pipeline" });

    // Sender publishes
    await sender.publishPending();

    // Verify sender broadcast the message
    expect(senderFm._sentMessages).toHaveLength(1);
    const sentMsg = senderFm._sentMessages[0];

    // Receiver simulates receiving the message
    await receiverFm._simulateIncoming("config:event", sentMsg.payload, senderPeer);

    // Verify applyOne was called on the receiver side
    expect(receivedApplyOne).toHaveBeenCalledTimes(1);
    expect(receivedApplyOne).toHaveBeenCalledWith(
      "pipeline",
      "pipe-1",
      "create",
      { name: "Shared Pipeline" },
      receiverStorage,
    );
  });
});
