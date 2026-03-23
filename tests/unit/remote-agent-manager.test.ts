import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { A2AMessage, AgentCard } from "@shared/types";

// ─── Mock DB ────────────────────────────────────────────────────────────────

const mockDb = {
  insert: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

vi.mock("../../server/db", () => ({
  db: mockDb,
}));

// Build a chainable query-builder mock that mimics drizzle's API
function createQueryChain(opts: {
  onReturning?: () => Record<string, unknown>[];
  onExecute?: () => Record<string, unknown>[];
}) {
  const chain: Record<string, unknown> = {};
  chain.values = vi.fn().mockReturnValue(chain);
  chain.set = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockImplementation(() => {
    if (opts.onExecute) {
      const result = opts.onExecute();
      (chain as any).then = (resolve: (v: unknown) => void) => {
        resolve(result);
        return chain;
      };
    }
    return chain;
  });
  chain.orderBy = vi.fn().mockImplementation(() => {
    return opts.onExecute?.() ?? [];
  });
  chain.returning = vi.fn().mockImplementation(() => {
    return opts.onReturning?.() ?? [];
  });
  return chain;
}

// ─── Mock A2AClient ─────────────────────────────────────────────────────────

const mockSendTask = vi.fn();

vi.mock("../../server/remote-agents/a2a-client", () => {
  return {
    A2AClient: class MockA2AClient {
      sendTask = mockSendTask;
      discover = vi.fn();
    },
  };
});

// ─── Mock AgentDiscoveryService ─────────────────────────────────────────────

const mockDiscoverEndpoint = vi.fn();
const mockHealthCheck = vi.fn();

vi.mock("../../server/remote-agents/agent-discovery", () => {
  return {
    AgentDiscoveryService: class MockAgentDiscoveryService {
      discoverEndpoint = mockDiscoverEndpoint;
      healthCheck = mockHealthCheck;
    },
  };
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const TEST_CARD: AgentCard = {
  name: "test-agent",
  version: "1.0.0",
  url: "https://agent.test",
  skills: [{ id: "code", name: "Code Generation" }],
};

const TEST_MESSAGE: A2AMessage = {
  role: "user",
  parts: [{ type: "text", text: "Hello agent" }],
};

let idCounter = 1;

function makeAgentRow(overrides: Partial<Record<string, unknown>> = {}) {
  const id = overrides.id ?? `test-id-${idCounter++}`;
  return {
    id,
    name: overrides.name ?? `agent-${id}`,
    environment: "kubernetes",
    transport: "a2a-http",
    endpoint: "https://agent.test",
    cluster: null,
    namespace: null,
    labels: null,
    authTokenEnc: null,
    enabled: true,
    autoConnect: false,
    status: "online",
    lastHeartbeatAt: null,
    healthError: null,
    agentCard: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  idCounter = 1;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function getManager() {
  const mod = await import(
    "../../server/remote-agents/remote-agent-manager.js"
  );
  return new mod.RemoteAgentManager();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("RemoteAgentManager", () => {
  // ── registerAgent ──────────────────────────────────────────────

  describe("registerAgent", () => {
    it("inserts agent into DB with discovered agent card", async () => {
      mockDiscoverEndpoint.mockResolvedValue({
        endpoint: "https://agent.test",
        agentCard: TEST_CARD,
        transport: "a2a-http",
      });

      const row = makeAgentRow({ status: "online", agentCard: TEST_CARD });
      const insertChain = createQueryChain({
        onReturning: () => [row],
      });
      mockDb.insert.mockReturnValue(insertChain);

      const mgr = await getManager();
      const result = await mgr.registerAgent({
        name: "my-agent",
        environment: "kubernetes",
        transport: "a2a-http",
        endpoint: "https://agent.test",
      });

      expect(mockDb.insert).toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "my-agent",
          environment: "kubernetes",
          status: "online",
        }),
      );
      expect(result.id).toBe(row.id);
    });

    it("registers agent as offline when discovery fails", async () => {
      mockDiscoverEndpoint.mockRejectedValue(new Error("unreachable"));

      const row = makeAgentRow({ status: "offline" });
      const insertChain = createQueryChain({
        onReturning: () => [row],
      });
      mockDb.insert.mockReturnValue(insertChain);

      const mgr = await getManager();
      const result = await mgr.registerAgent({
        name: "offline-agent",
        environment: "docker",
        transport: "a2a-http",
        endpoint: "https://down.test",
      });

      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ status: "offline" }),
      );
      expect(result.status).toBe("offline");
    });
  });

  // ── unregisterAgent ────────────────────────────────────────────

  describe("unregisterAgent", () => {
    it("removes client and deletes from DB", async () => {
      const deleteChain = createQueryChain({ onExecute: () => [] });
      mockDb.delete.mockReturnValue(deleteChain);

      const mgr = await getManager();
      (mgr as any).clients.set("agent-1", {});

      await mgr.unregisterAgent("agent-1");

      expect(mgr.getConnectionStatus("agent-1")).toBe(false);
      expect(mockDb.delete).toHaveBeenCalled();
    });
  });

  // ── connectAgent ───────────────────────────────────────────────

  describe("connectAgent", () => {
    it("creates client and updates DB with health status", async () => {
      const row = makeAgentRow({ id: "agent-1" });

      const selectChain = createQueryChain({ onExecute: () => [row] });
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue(selectChain),
      });

      mockHealthCheck.mockResolvedValue({
        status: "online",
        agentCard: TEST_CARD,
        latencyMs: 42,
      });

      const updateChain = createQueryChain({ onExecute: () => [] });
      mockDb.update.mockReturnValue(updateChain);

      const mgr = await getManager();
      await mgr.connectAgent("agent-1");

      expect(mgr.getConnectionStatus("agent-1")).toBe(true);
      expect(mockHealthCheck).toHaveBeenCalled();
      expect(mockDb.update).toHaveBeenCalled();
    });

    it("throws when agent not found", async () => {
      const selectChain = createQueryChain({ onExecute: () => [] });
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue(selectChain),
      });

      const mgr = await getManager();
      await expect(mgr.connectAgent("nonexistent")).rejects.toThrow(
        "Agent nonexistent not found",
      );
    });
  });

  // ── disconnectAgent ────────────────────────────────────────────

  describe("disconnectAgent", () => {
    it("removes client and sets status offline in DB", async () => {
      const updateChain = createQueryChain({ onExecute: () => [] });
      mockDb.update.mockReturnValue(updateChain);

      const mgr = await getManager();
      (mgr as any).clients.set("agent-2", {});

      await mgr.disconnectAgent("agent-2");

      expect(mgr.getConnectionStatus("agent-2")).toBe(false);
      expect(mockDb.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "offline" }),
      );
    });
  });

  // ── resolveAgent ───────────────────────────────────────────────

  describe("resolveAgent", () => {
    it("resolves by explicit agentId", async () => {
      const row = makeAgentRow({ id: "agent-x" });
      const selectChain = createQueryChain({ onExecute: () => [row] });
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue(selectChain),
      });

      const mgr = await getManager();
      const result = await mgr.resolveAgent({ agentId: "agent-x" });

      expect(result).not.toBeNull();
      expect(result!.id).toBe("agent-x");
    });

    it("resolves by label selector", async () => {
      const row1 = makeAgentRow({
        id: "a1",
        status: "offline",
        labels: { role: "coder" },
      });
      const row2 = makeAgentRow({
        id: "a2",
        status: "online",
        labels: { role: "coder" },
        enabled: true,
      });
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue([row1, row2]),
        }),
      });

      const mgr = await getManager();
      const result = await mgr.resolveAgent({
        agentSelector: { role: "coder" },
      });

      expect(result).not.toBeNull();
      expect(result!.id).toBe("a2");
    });

    it("returns null when no agent matches selector", async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue([]),
        }),
      });

      const mgr = await getManager();
      const result = await mgr.resolveAgent({
        agentSelector: { role: "nonexistent" },
      });

      expect(result).toBeNull();
    });

    it("falls back to any online agent when no selector given", async () => {
      const row = makeAgentRow({ id: "fallback", status: "online" });
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue([row]),
        }),
      });

      const mgr = await getManager();
      const result = await mgr.resolveAgent({});

      expect(result).not.toBeNull();
      expect(result!.id).toBe("fallback");
    });
  });

  // ── dispatchTask ───────────────────────────────────────────────

  describe("dispatchTask", () => {
    it("sends task via A2AClient and persists result", async () => {
      const taskRow = {
        id: "task-1",
        agentId: "agent-1",
        status: "submitted",
      };

      const insertChain = createQueryChain({
        onReturning: () => [taskRow],
      });
      mockDb.insert.mockReturnValue(insertChain);

      const updateChain = createQueryChain({ onExecute: () => [] });
      mockDb.update.mockReturnValue(updateChain);

      mockSendTask.mockResolvedValue({
        id: "task-1",
        status: "completed",
        output: { role: "agent", parts: [{ type: "text", text: "Done" }] },
      });

      const mgr = await getManager();
      (mgr as any).clients.set("agent-1", { sendTask: mockSendTask });

      const result = await mgr.dispatchTask("agent-1", TEST_MESSAGE, {
        skill: "code",
        runId: "run-1",
      });

      expect(result.taskId).toBe("task-1");
      expect(result.status).toBe("completed");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(mockSendTask).toHaveBeenCalledWith(
        expect.objectContaining({
          skill: "code",
          message: TEST_MESSAGE,
          taskId: "task-1",
        }),
      );
    });

    it("handles failure and updates task status to failed", async () => {
      const taskRow = {
        id: "task-2",
        agentId: "agent-1",
        status: "submitted",
      };

      const insertChain = createQueryChain({
        onReturning: () => [taskRow],
      });
      mockDb.insert.mockReturnValue(insertChain);

      const updateChain = createQueryChain({ onExecute: () => [] });
      mockDb.update.mockReturnValue(updateChain);

      mockSendTask.mockRejectedValue(new Error("connection refused"));

      const mgr = await getManager();
      (mgr as any).clients.set("agent-1", { sendTask: mockSendTask });

      const result = await mgr.dispatchTask("agent-1", TEST_MESSAGE);

      expect(result.taskId).toBe("task-2");
      expect(result.status).toBe("failed");
      expect(result.error).toBe("connection refused");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("throws when agent is not connected", async () => {
      const mgr = await getManager();

      await expect(
        mgr.dispatchTask("disconnected", TEST_MESSAGE),
      ).rejects.toThrow("Agent disconnected not connected");
    });
  });

  // ── getConnectionStatus ────────────────────────────────────────

  describe("getConnectionStatus", () => {
    it("returns true for connected agent", async () => {
      const mgr = await getManager();
      (mgr as any).clients.set("agent-c", {});
      expect(mgr.getConnectionStatus("agent-c")).toBe(true);
    });

    it("returns false for unknown agent", async () => {
      const mgr = await getManager();
      expect(mgr.getConnectionStatus("unknown")).toBe(false);
    });
  });

  // ── initialize ─────────────────────────────────────────────────

  describe("initialize", () => {
    it("auto-connects enabled agents with autoConnect flag", async () => {
      const row1 = makeAgentRow({
        id: "auto-1",
        autoConnect: true,
        enabled: true,
      });
      const row2 = makeAgentRow({
        id: "manual-1",
        autoConnect: false,
        enabled: true,
      });

      // listAgents call
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue([row1, row2]),
        }),
      });

      // connectAgent -> getAgent call
      const agentSelectChain = createQueryChain({
        onExecute: () => [row1],
      });
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue(agentSelectChain),
      });

      mockHealthCheck.mockResolvedValue({
        status: "online",
        agentCard: TEST_CARD,
        latencyMs: 10,
      });

      const updateChain = createQueryChain({ onExecute: () => [] });
      mockDb.update.mockReturnValue(updateChain);

      const mgr = await getManager();
      await mgr.initialize();

      expect(mgr.getConnectionStatus("auto-1")).toBe(true);
      expect(mgr.getConnectionStatus("manual-1")).toBe(false);

      await mgr.shutdown();
    });
  });

  // ── shutdown ───────────────────────────────────────────────────

  describe("shutdown", () => {
    it("clears heartbeat interval and all clients", async () => {
      const mgr = await getManager();
      (mgr as any).clients.set("a", {});
      (mgr as any).clients.set("b", {});
      (mgr as any).heartbeatInterval = setInterval(() => {}, 99999);

      await mgr.shutdown();

      expect(mgr.getConnectionStatus("a")).toBe(false);
      expect(mgr.getConnectionStatus("b")).toBe(false);
      expect((mgr as any).heartbeatInterval).toBeNull();
    });
  });

  // ── listAgents ─────────────────────────────────────────────────

  describe("listAgents", () => {
    it("returns mapped agent configs from DB rows", async () => {
      const row = makeAgentRow({ id: "list-1", name: "alpha" });
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue([row]),
        }),
      });

      const mgr = await getManager();
      const agents = await mgr.listAgents();

      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe("list-1");
      expect(agents[0].name).toBe("alpha");
    });
  });
});
