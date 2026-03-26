import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionSharingService } from "../../server/federation/session-sharing";
import type { FederationManager } from "../../server/federation/index";
import type { FederationMessage, PeerInfo } from "../../server/federation/types";
import type { IStorage } from "../../server/storage";
import type { SharedSession, CreateSharedSessionInput, HandoffBundle } from "../../shared/types";

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
  const chatMessages: Array<Record<string, unknown>> = [];

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
    getPipelineRun: vi.fn(async (id: string) => ({
      id,
      pipelineId: "pipeline-1",
      status: "running",
      input: "test input",
      output: null,
      currentStageIndex: 0,
      startedAt: new Date(),
      completedAt: null,
      triggeredBy: "user-1",
      dagMode: false,
      createdAt: new Date(),
    })),
    getPipeline: vi.fn(async (id: string) => ({
      id,
      name: "Test Pipeline",
      description: "A test pipeline",
      stages: [],
      createdAt: new Date(),
      createdBy: "user-1",
    })),
    getStageExecutions: vi.fn(async () => [
      { id: "stage-exec-1", runId: "run-1", stageIndex: 0, status: "completed", teamId: "team-1" },
    ]),
    getChatMessages: vi.fn(async () => [
      { id: 1, runId: "run-1", role: "user", content: "Hello", agentTeam: null, modelSlug: null, metadata: null },
    ]),
    getMemories: vi.fn(async () => [
      { id: 1, content: "Memory 1", scope: "run", scopeId: "run-1", type: "fact" },
    ]),
    getLlmRequests: vi.fn(async () => ({
      rows: [{ id: 1, runId: "run-1", provider: "mock", status: "completed" }],
      total: 1,
    })),
    updatePipelineRun: vi.fn(async (id: string, updates: Record<string, unknown>) => ({
      id,
      pipelineId: "pipeline-1",
      status: updates.status ?? "running",
      input: "test input",
      output: null,
      currentStageIndex: 0,
      startedAt: new Date(),
      completedAt: updates.completedAt ?? null,
      triggeredBy: "user-1",
      dagMode: false,
      createdAt: new Date(),
    })),
    createPipelineRun: vi.fn(async (input: Record<string, unknown>) => ({
      id: "new-run-1",
      pipelineId: input.pipelineId as string,
      status: input.status as string,
      input: input.input as string,
      output: null,
      currentStageIndex: 0,
      startedAt: null,
      completedAt: null,
      triggeredBy: null,
      dagMode: false,
      createdAt: new Date(),
    })),
    createChatMessage: vi.fn(async (msg: Record<string, unknown>) => {
      chatMessages.push(msg);
      return { id: chatMessages.length, ...msg, createdAt: new Date() };
    }),
  } as unknown as IStorage;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("SessionSharingService -- Handoff", () => {
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

  // ── createHandoffBundle ──────────────────────────────────────────────────

  it("assembles a complete handoff bundle from storage", async () => {
    const bundle = await service.createHandoffBundle("run-1", "Taking over the task");

    expect(bundle.notes).toBe("Taking over the task");
    expect(bundle.run).toBeDefined();
    expect((bundle.run as Record<string, unknown>).id).toBe("run-1");
    expect(bundle.pipeline).toBeDefined();
    expect((bundle.pipeline as Record<string, unknown>).id).toBe("pipeline-1");
    expect(bundle.stages).toHaveLength(1);
    expect(bundle.chatHistory).toHaveLength(1);
    expect(bundle.memories).toHaveLength(1);
    expect(bundle.llmRequests).toHaveLength(1);
  });

  it("createHandoffBundle throws when run not found", async () => {
    (storage.getPipelineRun as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    await expect(service.createHandoffBundle("nonexistent", "notes"))
      .rejects.toThrow("Run nonexistent not found");
  });

  it("createHandoffBundle throws when pipeline not found", async () => {
    (storage.getPipeline as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    await expect(service.createHandoffBundle("run-1", "notes"))
      .rejects.toThrow("Pipeline pipeline-1 not found");
  });

  it("createHandoffBundle strips sensitive fields", async () => {
    (storage.getPipelineRun as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "run-1",
      pipelineId: "pipeline-1",
      status: "running",
      input: "test",
      apiKey: "sk-secret-123",
      password: "hunter2",
    });

    const bundle = await service.createHandoffBundle("run-1", "notes");
    expect(bundle.run).not.toHaveProperty("apiKey");
    expect(bundle.run).not.toHaveProperty("password");
    expect(bundle.run).toHaveProperty("id", "run-1");
  });

  // ── sendHandoff ───────────────────────────────────────────────────────────

  it("sends handoff bundle via federation to target peer", async () => {
    const session = await service.shareRun("run-1", "user-1");
    federation._sentMessages.length = 0;

    const token = await service.sendHandoff(session.id, "peer-2", "Please continue");

    expect(token).toBeTruthy();
    expect(token.length).toBe(48); // 24 bytes hex
    expect(federation._sentMessages).toHaveLength(1);
    expect(federation._sentMessages[0].type).toBe("session:handoff");
    expect(federation._sentMessages[0].to).toBe("peer-2");

    const payload = federation._sentMessages[0].payload as Record<string, unknown>;
    expect(payload.bundleToken).toBe(token);
    expect(payload.fromInstanceId).toBe("local-instance");
    expect(payload.bundle).toBeDefined();
  });

  it("sendHandoff throws when session not found", async () => {
    await expect(service.sendHandoff("nonexistent", "peer-2", "notes"))
      .rejects.toThrow("Session nonexistent not found");
  });

  // ── handleHandoffReceived + acceptHandoff ─────────────────────────────────

  it("receives handoff and stores as pending", () => {
    const handler = federation._handlers.get("session:handoff")![0];
    const bundle: HandoffBundle = {
      run: { id: "run-1", pipelineId: "pipeline-1", input: "test" },
      pipeline: { id: "pipeline-1", name: "Test" },
      stages: [],
      chatHistory: [{ role: "user", content: "Hello" }],
      memories: [],
      llmRequests: [],
      notes: "Handoff notes",
    };

    handler(
      {
        type: "session:handoff",
        from: "peer-1",
        correlationId: "c1",
        payload: { bundleToken: "token-abc", sessionId: "s1", bundle, fromInstanceId: "peer-1" },
        hmac: "",
        timestamp: Date.now(),
      },
      makePeer(),
    );

    const pending = service._getPendingHandoffs();
    expect(pending.has("token-abc")).toBe(true);
    expect(pending.get("token-abc")!.notes).toBe("Handoff notes");
  });

  it("acceptHandoff creates new run and marks original as handed_off", async () => {
    // Simulate receiving a handoff
    const handler = federation._handlers.get("session:handoff")![0];
    const bundle: HandoffBundle = {
      run: { id: "original-run", pipelineId: "pipeline-1", input: "original input" },
      pipeline: { id: "pipeline-1", name: "Test" },
      stages: [],
      chatHistory: [{ role: "user", content: "Hello", agentTeam: null, modelSlug: null, metadata: null }],
      memories: [],
      llmRequests: [],
      notes: "Take over please",
    };

    handler(
      {
        type: "session:handoff",
        from: "peer-1",
        correlationId: "c1",
        payload: { bundleToken: "accept-token", sessionId: "s1", bundle, fromInstanceId: "peer-1" },
        hmac: "",
        timestamp: Date.now(),
      },
      makePeer(),
    );

    federation._sentMessages.length = 0;
    const result = await service.acceptHandoff("accept-token");

    expect(result.runId).toBe("new-run-1");
    expect(storage.createPipelineRun).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: "pipeline-1",
        status: "pending",
      }),
    );
    expect(storage.updatePipelineRun).toHaveBeenCalledWith(
      "original-run",
      expect.objectContaining({ status: "handed_off" }),
    );
    expect(storage.createChatMessage).toHaveBeenCalled();

    // Check federation notification
    expect(federation._sentMessages).toHaveLength(1);
    expect(federation._sentMessages[0].type).toBe("session:handoff:accept");
  });

  it("acceptHandoff throws when bundle not found", async () => {
    await expect(service.acceptHandoff("nonexistent-token"))
      .rejects.toThrow("Handoff bundle not found or expired");
  });

  it("acceptHandoff removes bundle after acceptance", async () => {
    const handler = federation._handlers.get("session:handoff")![0];
    handler(
      {
        type: "session:handoff",
        from: "peer-1",
        correlationId: "c1",
        payload: {
          bundleToken: "one-time-token",
          sessionId: "s1",
          bundle: {
            run: { id: "r1", pipelineId: "p1", input: "test" },
            pipeline: { id: "p1", name: "T" },
            stages: [],
            chatHistory: [],
            memories: [],
            llmRequests: [],
            notes: "n",
          },
          fromInstanceId: "peer-1",
        },
        hmac: "",
        timestamp: Date.now(),
      },
      makePeer(),
    );

    await service.acceptHandoff("one-time-token");

    // Second acceptance should fail
    await expect(service.acceptHandoff("one-time-token"))
      .rejects.toThrow("Handoff bundle not found or expired");
  });

  // ── getPendingHandoffs ────────────────────────────────────────────────────

  it("getPendingHandoffs returns structured list", () => {
    const handler = federation._handlers.get("session:handoff")![0];

    handler(
      {
        type: "session:handoff",
        from: "peer-1",
        correlationId: "c1",
        payload: {
          bundleToken: "t1",
          sessionId: "s1",
          bundle: {
            run: { id: "r1", pipelineId: "p1", input: "i" },
            pipeline: { id: "p1", name: "P" },
            stages: [],
            chatHistory: [],
            memories: [],
            llmRequests: [],
            notes: "Note 1",
          },
          fromInstanceId: "peer-1",
        },
        hmac: "",
        timestamp: Date.now(),
      },
      makePeer(),
    );

    const handoffs = service.getPendingHandoffs();
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].bundleToken).toBe("t1");
    expect(handoffs[0].notes).toBe("Note 1");
    expect(handoffs[0].originalRunId).toBe("r1");
    expect(handoffs[0].pipelineId).toBe("p1");
  });

  // ── handleHandoffAccepted callback ────────────────────────────────────────

  it("handleHandoffAccepted triggers wsEventCallback", () => {
    const events: Array<Record<string, unknown>> = [];
    service.onWsEvent((_runId, event) => events.push(event));

    const handler = federation._handlers.get("session:handoff:accept")![0];
    handler(
      {
        type: "session:handoff:accept",
        from: "peer-2",
        correlationId: "c2",
        payload: { bundleToken: "bt", newRunId: "new-r", acceptedBy: "peer-2" },
        hmac: "",
        timestamp: Date.now(),
      },
      makePeer({ instanceId: "peer-2" }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("federation:handoff:accepted");
  });

  // ── Handoff to offline peer (edge case) ───────────────────────────────────

  it("sendHandoff sends even if target peer is offline (federation handles delivery)", async () => {
    const session = await service.shareRun("run-1", "user-1");
    federation._sentMessages.length = 0;

    // This just sends the message -- delivery is federation's responsibility
    const token = await service.sendHandoff(session.id, "offline-peer", "notes");
    expect(token).toBeTruthy();
    expect(federation._sentMessages[0].to).toBe("offline-peer");
  });

  // ── Empty bundle fields edge case ─────────────────────────────────────────

  it("handles bundle with empty arrays gracefully", async () => {
    (storage.getStageExecutions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (storage.getChatMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (storage.getMemories as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (storage.getLlmRequests as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], total: 0 });

    const bundle = await service.createHandoffBundle("run-1", "Empty run");
    expect(bundle.stages).toHaveLength(0);
    expect(bundle.chatHistory).toHaveLength(0);
    expect(bundle.memories).toHaveLength(0);
    expect(bundle.llmRequests).toHaveLength(0);
  });
});
