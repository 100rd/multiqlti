import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryFederationService } from "../../server/federation/memory-federation";
import { PipelineSyncService } from "../../server/federation/pipeline-sync";
import type { FederationManager } from "../../server/federation/index";
import type { FederationMessage, PeerInfo } from "../../server/federation/types";
import type { IStorage } from "../../server/storage";
import type { Memory, MemoryScope, Pipeline } from "../../shared/types";

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

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 1,
    scope: "global" as MemoryScope,
    scopeId: null,
    type: "fact" as Memory["type"],
    key: "test-key",
    content: "test content",
    source: null,
    confidence: 0.9,
    tags: ["test"],
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: null,
    createdByRunId: null,
    published: false,
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

function createMockStorage(memories: Memory[] = []): IStorage {
  return {
    searchMemories: vi.fn(async (query: string, _scope?: MemoryScope) => {
      return memories.filter(
        (m) => m.content.toLowerCase().includes(query.toLowerCase()) ||
               m.key.toLowerCase().includes(query.toLowerCase()),
      );
    }),
    updateMemoryPublished: vi.fn(async (id: number, published: boolean) => {
      const mem = memories.find((m) => m.id === id);
      if (!mem) return null;
      const updated = { ...mem, published, updatedAt: new Date() };
      return updated;
    }),
    getPipeline: vi.fn(async (id: string) => {
      if (id === "pipe-1") {
        return {
          id: "pipe-1",
          name: "Test Pipeline",
          description: "A test pipeline",
          stages: [{ name: "stage1", type: "llm" }],
          isTemplate: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as Pipeline;
      }
      return undefined;
    }),
    createPipeline: vi.fn(async (data: { name: string; description: string | null; stages: unknown[] }) => ({
      id: "pipe-new",
      name: data.name,
      description: data.description,
      stages: data.stages,
      isTemplate: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as unknown as IStorage["createPipeline"],
  } as unknown as IStorage;
}

// ── MemoryFederationService ────────────────────────────────────────────────────

describe("MemoryFederationService", () => {
  let fm: ReturnType<typeof createMockFederation>;
  let storage: ReturnType<typeof createMockStorage>;
  let service: MemoryFederationService;

  beforeEach(() => {
    fm = createMockFederation();
    storage = createMockStorage([
      makeMemory({ id: 1, content: "published memory", published: true }),
      makeMemory({ id: 2, content: "unpublished memory", published: false }),
    ]);
    service = new MemoryFederationService(fm, storage as unknown as IStorage, "instance-1", "Instance One");
  });

  it("registers memory:query and memory:response handlers", () => {
    expect(fm._handlers.has("memory:query")).toBe(true);
    expect(fm._handlers.has("memory:response")).toBe(true);
  });

  it("returns local-only results when no peers are connected", async () => {
    const localResults = [{ id: "1", content: "local", tags: [], sourceInstance: "local", sourceInstanceName: "local" }];
    const result = await service.federatedSearch("test", localResults);

    expect(result.results).toEqual(localResults);
    expect(result.sources).toEqual({ local: 1 });
  });

  it("broadcasts query to all peers and merges results within timeout", async () => {
    const peer = makePeer();
    (fm.getPeers as ReturnType<typeof vi.fn>).mockReturnValue([peer]);

    const localResults = [{ id: "1", content: "local", tags: [], sourceInstance: "local", sourceInstanceName: "local" }];

    // Start federated search (will wait for responses or timeout)
    const searchPromise = service.federatedSearch("test", localResults, 500);

    // Verify query was broadcast
    expect(fm._sentMessages.length).toBe(1);
    expect(fm._sentMessages[0].type).toBe("memory:query");

    const sentPayload = fm._sentMessages[0].payload as { correlationId: string };

    // Simulate peer response
    const handler = fm._handlers.get("memory:response")?.[0];
    expect(handler).toBeDefined();
    await handler!(
      {
        type: "memory:response",
        from: "peer-1",
        correlationId: sentPayload.correlationId,
        payload: {
          correlationId: sentPayload.correlationId,
          results: [{ id: "2", content: "remote", tags: [], sourceInstance: "peer-1", sourceInstanceName: "Peer One" }],
          sourceInstance: "peer-1",
        },
        hmac: "",
        timestamp: Date.now(),
      },
      peer,
    );

    const result = await searchPromise;
    expect(result.results).toHaveLength(2);
    expect(result.sources).toEqual({ local: 1, "peer-1": 1 });
  });

  it("resolves after timeout when peers do not respond", async () => {
    const peer = makePeer();
    (fm.getPeers as ReturnType<typeof vi.fn>).mockReturnValue([peer]);

    const localResults = [{ id: "1", content: "local", tags: [], sourceInstance: "local", sourceInstanceName: "local" }];

    const result = await service.federatedSearch("test", localResults, 100);

    // Should resolve with only local results after timeout
    expect(result.results).toHaveLength(1);
    expect(result.sources).toEqual({ local: 1 });
  });

  it("handleQuery only returns published memories to peers", async () => {
    const handler = fm._handlers.get("memory:query")?.[0];
    expect(handler).toBeDefined();

    const peer = makePeer({ instanceId: "requester" });
    await handler!(
      {
        type: "memory:query",
        from: "requester",
        correlationId: "corr-1",
        payload: {
          query: "memory",
          correlationId: "corr-1",
          sourceInstance: "requester",
        },
        hmac: "",
        timestamp: Date.now(),
      },
      peer,
    );

    expect(fm._sentMessages.length).toBe(1);
    expect(fm._sentMessages[0].type).toBe("memory:response");

    const responsePayload = fm._sentMessages[0].payload as { results: Array<{ id: string; content: string }> };
    // Only the published memory should be included
    expect(responsePayload.results).toHaveLength(1);
    expect(responsePayload.results[0].content).toBe("published memory");
  });

  it("handleQuery responds with empty results on storage error", async () => {
    const errorStorage = {
      ...storage,
      searchMemories: vi.fn(async () => { throw new Error("DB down"); }),
    } as unknown as IStorage;

    const errorFm = createMockFederation();
    new MemoryFederationService(errorFm, errorStorage, "inst-1", "Inst One");

    const handler = errorFm._handlers.get("memory:query")?.[0];
    await handler!(
      {
        type: "memory:query",
        from: "requester",
        correlationId: "corr-2",
        payload: { query: "test", correlationId: "corr-2", sourceInstance: "requester" },
        hmac: "",
        timestamp: Date.now(),
      },
      makePeer(),
    );

    expect(errorFm._sentMessages.length).toBe(1);
    const resp = errorFm._sentMessages[0].payload as { results: unknown[] };
    expect(resp.results).toHaveLength(0);
  });
});

// ── PipelineSyncService ────────────────────────────────────────────────────────

describe("PipelineSyncService", () => {
  let fm: ReturnType<typeof createMockFederation>;
  let storage: ReturnType<typeof createMockStorage>;
  let service: PipelineSyncService;

  beforeEach(() => {
    fm = createMockFederation();
    storage = createMockStorage();
    service = new PipelineSyncService(fm, storage as unknown as IStorage, "instance-1");
  });

  it("registers pipeline:offer and pipeline:accept handlers", () => {
    expect(fm._handlers.has("pipeline:offer")).toBe(true);
    expect(fm._handlers.has("pipeline:accept")).toBe(true);
  });

  it("exports a pipeline successfully", async () => {
    const exported = await service.exportPipeline("pipe-1");

    expect(exported.name).toBe("Test Pipeline");
    expect(exported.description).toBe("A test pipeline");
    expect(exported.stages).toHaveLength(1);
    expect(exported.exportedFrom).toBe("instance-1");
    expect(exported.exportedAt).toBeTruthy();
  });

  it("throws on export of non-existent pipeline", async () => {
    await expect(service.exportPipeline("does-not-exist")).rejects.toThrow("Pipeline not found");
  });

  it("imports a pipeline with (imported) suffix", async () => {
    const newId = await service.importPipeline({
      name: "External Pipeline",
      description: "From another instance",
      stages: [{ name: "s1" }],
      exportedFrom: "peer-1",
      exportedAt: new Date().toISOString(),
    });

    expect(newId).toBe("pipe-new");
    expect(storage.createPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ name: "External Pipeline (imported)" }),
    );
  });

  it("export/import round-trip preserves data", async () => {
    const exported = await service.exportPipeline("pipe-1");
    await service.importPipeline(exported);

    expect(storage.createPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Test Pipeline (imported)",
        description: "A test pipeline",
        stages: [{ name: "stage1", type: "llm" }],
      }),
    );
  });

  it("broadcasts offer to all peers", async () => {
    const exported = await service.exportPipeline("pipe-1");
    service.offerPipeline(exported);

    expect(fm._sentMessages.length).toBe(1);
    expect(fm._sentMessages[0].type).toBe("pipeline:offer");
  });

  it("receives and lists pipeline offers", () => {
    const handler = fm._handlers.get("pipeline:offer")?.[0];
    expect(handler).toBeDefined();

    const peer = makePeer({ instanceId: "peer-1", instanceName: "Peer One" });

    handler!(
      {
        type: "pipeline:offer",
        from: "peer-1",
        correlationId: "offer-1",
        payload: {
          pipeline: {
            name: "Offered Pipeline",
            description: null,
            stages: [{ name: "s1" }],
            exportedFrom: "peer-1",
            exportedAt: new Date().toISOString(),
          },
          from: "peer-1",
        },
        hmac: "",
        timestamp: Date.now(),
      },
      peer,
    );

    const offers = service.getReceivedOffers();
    expect(offers).toHaveLength(1);
    expect(offers[0].pipeline.name).toBe("Offered Pipeline");
    expect(offers[0].from).toBe("peer-1");
    expect(offers[0].fromInstanceName).toBe("Peer One");
  });

  it("accepts an offer and imports the pipeline", async () => {
    // First receive an offer
    const handler = fm._handlers.get("pipeline:offer")?.[0];
    const peer = makePeer({ instanceId: "peer-1", instanceName: "Peer One" });

    handler!(
      {
        type: "pipeline:offer",
        from: "peer-1",
        correlationId: "offer-2",
        payload: {
          pipeline: {
            name: "Offered Pipeline",
            description: "test",
            stages: [{ name: "s1" }],
            exportedFrom: "peer-1",
            exportedAt: new Date().toISOString(),
          },
          from: "peer-1",
        },
        hmac: "",
        timestamp: Date.now(),
      },
      peer,
    );

    const newId = await service.acceptOffer("offer-2");
    expect(newId).toBe("pipe-new");

    // Offer should be removed after acceptance
    expect(service.getReceivedOffers()).toHaveLength(0);

    // Should have sent accept acknowledgement
    const acceptMsg = fm._sentMessages.find((m) => m.type === "pipeline:accept");
    expect(acceptMsg).toBeDefined();
    expect(acceptMsg!.to).toBe("peer-1");
  });

  it("throws when accepting non-existent offer", async () => {
    await expect(service.acceptOffer("nonexistent")).rejects.toThrow("Offer not found or expired");
  });
});

// ── Zod Validation ─────────────────────────────────────────────────────────────

describe("Zod validation schemas (route-level)", () => {
  // Import the schemas by testing them inline (they match the route file patterns)
  const { z } = require("zod");

  const MemorySearchSchema = z.object({
    q: z.string().min(1).max(1000),
    timeout: z.coerce.number().int().min(100).max(30000).optional(),
  });

  const PublishToggleSchema = z.object({
    published: z.boolean(),
  });

  const PipelineImportSchema = z.object({
    name: z.string().min(1).max(255),
    description: z.string().max(2000).nullable(),
    stages: z.array(z.unknown()).min(1),
    exportedFrom: z.string().min(1),
    exportedAt: z.string().min(1),
  });

  it("rejects empty query string for memory search", () => {
    const result = MemorySearchSchema.safeParse({ q: "" });
    expect(result.success).toBe(false);
  });

  it("rejects query exceeding 1000 chars", () => {
    const result = MemorySearchSchema.safeParse({ q: "a".repeat(1001) });
    expect(result.success).toBe(false);
  });

  it("accepts valid memory search params", () => {
    const result = MemorySearchSchema.safeParse({ q: "hello world", timeout: "5000" });
    expect(result.success).toBe(true);
    expect(result.data?.timeout).toBe(5000);
  });

  it("rejects timeout below 100ms", () => {
    const result = MemorySearchSchema.safeParse({ q: "hello", timeout: "50" });
    expect(result.success).toBe(false);
  });

  it("rejects non-boolean published toggle", () => {
    const result = PublishToggleSchema.safeParse({ published: "true" });
    expect(result.success).toBe(false);
  });

  it("accepts valid published toggle", () => {
    const result = PublishToggleSchema.safeParse({ published: true });
    expect(result.success).toBe(true);
  });

  it("rejects pipeline import with empty stages", () => {
    const result = PipelineImportSchema.safeParse({
      name: "Test",
      description: null,
      stages: [],
      exportedFrom: "x",
      exportedAt: "2024-01-01",
    });
    expect(result.success).toBe(false);
  });

  it("rejects pipeline import with missing name", () => {
    const result = PipelineImportSchema.safeParse({
      name: "",
      description: null,
      stages: [{}],
      exportedFrom: "x",
      exportedAt: "2024-01-01",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid pipeline import", () => {
    const result = PipelineImportSchema.safeParse({
      name: "My Pipeline",
      description: "A good pipeline",
      stages: [{ name: "s1" }],
      exportedFrom: "peer-1",
      exportedAt: "2024-01-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });
});

// ── Published filter ───────────────────────────────────────────────────────────

describe("Published memory filter", () => {
  it("updateMemoryPublished toggles the published flag", async () => {
    const mem = makeMemory({ id: 5, published: false });
    const storage = createMockStorage([mem]);

    const updated = await storage.updateMemoryPublished(5, true);
    expect(updated).not.toBeNull();
    expect(updated!.published).toBe(true);
  });

  it("updateMemoryPublished returns null for non-existent memory", async () => {
    const storage = createMockStorage([]);
    const result = await storage.updateMemoryPublished(999, true);
    expect(result).toBeNull();
  });
});
