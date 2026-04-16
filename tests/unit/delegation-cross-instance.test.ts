/**
 * Unit tests for CrossInstanceDelegationService (issue #233).
 *
 * Tests policy enforcement, request/result lifecycle, timeout handling,
 * concurrency limits, cancellation, and handler registration.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CrossInstanceDelegationService,
  DelegationPolicyError,
  DelegationConcurrencyError,
  type LocalStageExecutor,
} from "../../server/federation/delegation.js";
import type { CrossDelegationPolicy, PipelineStageConfig } from "../../shared/types.js";
import type { FederationMessage, PeerInfo } from "../../server/federation/types.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

type Handler = (msg: FederationMessage, peer: PeerInfo) => void | Promise<void>;

function createMockFederation() {
  const handlers = new Map<string, Handler[]>();
  const sentMessages: Array<{ type: string; payload: unknown; to?: string }> = [];

  return {
    send(type: string, payload: unknown, to?: string): void {
      sentMessages.push({ type, payload, to });
    },
    on(type: string, handler: Handler): void {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    getPeers(): PeerInfo[] {
      return [
        {
          instanceId: "peer-gpu",
          instanceName: "GPU Peer",
          endpoint: "ws://gpu:5001",
          connectedAt: new Date(),
          lastMessageAt: new Date(),
          status: "connected" as const,
        },
        {
          instanceId: "peer-db",
          instanceName: "DB Peer",
          endpoint: "ws://db:5001",
          connectedAt: new Date(),
          lastMessageAt: new Date(),
          status: "connected" as const,
        },
      ];
    },
    isEnabled(): boolean {
      return true;
    },
    // Test helpers
    _handlers: handlers,
    _sentMessages: sentMessages,
    _dispatch(type: string, msg: FederationMessage, peer: PeerInfo): void {
      const list = handlers.get(type) ?? [];
      for (const h of list) {
        h(msg, peer);
      }
    },
  };
}

function defaultPolicy(overrides: Partial<CrossDelegationPolicy> = {}): CrossDelegationPolicy {
  return {
    enabled: true,
    allowedPeers: null,
    allowedStages: null,
    maxConcurrent: 5,
    timeoutSeconds: 10,
    ...overrides,
  };
}

function makeStage(teamId = "development"): PipelineStageConfig {
  return {
    teamId,
    modelSlug: "test-model",
    enabled: true,
  };
}

const DEFAULT_INSTANCE_ID = "instance-local";

function makePeerInfo(instanceId = "peer-gpu"): PeerInfo {
  return {
    instanceId,
    instanceName: "Test Peer",
    endpoint: "ws://test:5001",
    connectedAt: new Date(),
    lastMessageAt: new Date(),
    status: "connected",
  };
}

/** Swallow rejections from promises we intentionally let fail. */
function swallow(p: Promise<unknown>): void {
  p.catch(() => {});
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("CrossInstanceDelegationService", () => {
  let federation: ReturnType<typeof createMockFederation>;
  let service: CrossInstanceDelegationService;

  beforeEach(() => {
    vi.useFakeTimers();
    federation = createMockFederation();
    service = new CrossInstanceDelegationService(
      federation as unknown as import("../../server/federation/index.js").FederationManager,
      defaultPolicy(),
      DEFAULT_INSTANCE_ID,
    );
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });

  // ── Policy Tests ─────────────────────────────────────────────────────────

  describe("policy enforcement", () => {
    it("rejects when delegation is disabled", () => {
      service.updatePolicy(defaultPolicy({ enabled: false }));
      expect(() =>
        service.delegateStage("run-1", 0, "peer-gpu", makeStage(), "input", {}),
      ).toThrow(DelegationPolicyError);
    });

    it("rejects disallowed peer", () => {
      service.updatePolicy(defaultPolicy({ allowedPeers: ["peer-db"] }));
      expect(() =>
        service.delegateStage("run-1", 0, "peer-gpu", makeStage(), "input", {}),
      ).toThrow("peer \"peer-gpu\" is not allowed");
    });

    it("allows peer when in allowedPeers list", () => {
      service.updatePolicy(defaultPolicy({ allowedPeers: ["peer-gpu"] }));
      const id = service.delegateStage("run-1", 0, "peer-gpu", makeStage(), "input", {});
      expect(id).toBeTruthy();
    });

    it("allows any peer when allowedPeers is null", () => {
      service.updatePolicy(defaultPolicy({ allowedPeers: null }));
      const id = service.delegateStage("run-1", 0, "peer-gpu", makeStage(), "input", {});
      expect(id).toBeTruthy();
    });

    it("rejects disallowed stage", () => {
      service.updatePolicy(defaultPolicy({ allowedStages: ["testing"] }));
      expect(() =>
        service.delegateStage("run-1", 0, "peer-gpu", makeStage("development"), "input", {}),
      ).toThrow("stage \"development\" is not allowed");
    });

    it("allows stage when in allowedStages list", () => {
      service.updatePolicy(defaultPolicy({ allowedStages: ["development"] }));
      const id = service.delegateStage("run-1", 0, "peer-gpu", makeStage("development"), "input", {});
      expect(id).toBeTruthy();
    });

    it("allows any stage when allowedStages is null", () => {
      const id = service.delegateStage("run-1", 0, "peer-gpu", makeStage(), "input", {});
      expect(id).toBeTruthy();
    });
  });

  // ── canDelegate Tests ────────────────────────────────────────────────────

  describe("canDelegate", () => {
    it("returns false when disabled", () => {
      service.updatePolicy(defaultPolicy({ enabled: false }));
      expect(service.canDelegate("development", "peer-gpu")).toBe(false);
    });

    it("returns false for disallowed peer", () => {
      service.updatePolicy(defaultPolicy({ allowedPeers: ["peer-db"] }));
      expect(service.canDelegate("development", "peer-gpu")).toBe(false);
    });

    it("returns false for disallowed stage", () => {
      service.updatePolicy(defaultPolicy({ allowedStages: ["testing"] }));
      expect(service.canDelegate("development", "peer-gpu")).toBe(false);
    });

    it("returns false for unknown (disconnected) peer", () => {
      expect(service.canDelegate("development", "peer-unknown")).toBe(false);
    });

    it("returns true for valid peer and stage", () => {
      expect(service.canDelegate("development", "peer-gpu")).toBe(true);
    });
  });

  // ── Request Creation + Message Format ────────────────────────────────────

  describe("request creation", () => {
    it("sends stage:delegate message with correct payload", () => {
      const stage = makeStage();
      const variables = { API_KEY: "secret" };
      const id = service.delegateStage("run-42", 3, "peer-gpu", stage, "analyze this", variables);

      expect(federation._sentMessages).toHaveLength(1);
      const msg = federation._sentMessages[0];
      expect(msg.type).toBe("stage:delegate");
      expect(msg.to).toBe("peer-gpu");

      const payload = msg.payload as Record<string, unknown>;
      expect(payload.id).toBe(id);
      expect(payload.runId).toBe("run-42");
      expect(payload.stageIndex).toBe(3);
      expect(payload.input).toBe("analyze this");
      expect(payload.variables).toEqual(variables);
      expect(payload.fromInstanceId).toBe(DEFAULT_INSTANCE_ID);
    });

    it("returns unique delegation IDs", () => {
      const id1 = service.delegateStage("run-1", 0, "peer-gpu", makeStage(), "a", {});
      const id2 = service.delegateStage("run-1", 1, "peer-gpu", makeStage(), "b", {});
      expect(id1).not.toBe(id2);
    });
  });

  // ── Result Handling ──────────────────────────────────────────────────────

  describe("result handling", () => {
    it("resolves on completed result", async () => {
      const id = service.delegateStage("run-1", 0, "peer-gpu", makeStage(), "input", {});
      const resultPromise = service.waitForResult(id);

      // Simulate peer response
      federation._dispatch("stage:delegate:result", {
        type: "stage:delegate:result",
        from: "peer-gpu",
        correlationId: "corr-1",
        payload: {
          delegationId: id,
          status: "completed",
          output: "result output",
          tokensUsed: 150,
          executionMs: 1200,
        },
        hmac: "",
        timestamp: Date.now(),
      }, makePeerInfo());

      const result = await resultPromise;
      expect(result.status).toBe("completed");
      expect(result.output).toBe("result output");
      expect(result.tokensUsed).toBe(150);
      expect(result.executionMs).toBe(1200);
    });

    it("resolves on failed result", async () => {
      const id = service.delegateStage("run-1", 0, "peer-gpu", makeStage(), "input", {});
      const resultPromise = service.waitForResult(id);

      federation._dispatch("stage:delegate:result", {
        type: "stage:delegate:result",
        from: "peer-gpu",
        correlationId: "corr-1",
        payload: {
          delegationId: id,
          status: "failed",
          output: "",
          tokensUsed: 0,
          executionMs: 50,
          error: "Model unavailable",
        },
        hmac: "",
        timestamp: Date.now(),
      }, makePeerInfo());

      const result = await resultPromise;
      expect(result.status).toBe("failed");
      expect(result.error).toBe("Model unavailable");
    });

    it("resolves on timeout", async () => {
      const shortPolicy = defaultPolicy({ timeoutSeconds: 1 });
      service.updatePolicy(shortPolicy);

      const id = service.delegateStage("run-1", 0, "peer-gpu", makeStage(), "input", {});
      const resultPromise = service.waitForResult(id);

      // Advance time past timeout
      vi.advanceTimersByTime(1100);

      const result = await resultPromise;
      expect(result.status).toBe("timeout");
      expect(result.delegationId).toBe(id);
    });
  });

  // ── Concurrent Limit ────────────────────────────────────────────────────

  describe("concurrent limit enforcement", () => {
    it("rejects when max concurrent reached", () => {
      service.updatePolicy(defaultPolicy({ maxConcurrent: 2 }));

      // waitForResult creates the pending map entries that count toward concurrency
      const id1 = service.delegateStage("run-1", 0, "peer-gpu", makeStage(), "a", {});
      swallow(service.waitForResult(id1));

      const id2 = service.delegateStage("run-1", 1, "peer-gpu", makeStage(), "b", {});
      swallow(service.waitForResult(id2));

      // Third delegation should be blocked because pending.size == maxConcurrent
      expect(() =>
        service.delegateStage("run-1", 2, "peer-gpu", makeStage(), "c", {}),
      ).toThrow(DelegationConcurrencyError);
    });
  });

  // ── Cancel Delegation ────────────────────────────────────────────────────

  describe("cancel delegation", () => {
    it("cancels a pending delegation", async () => {
      const id = service.delegateStage("run-1", 0, "peer-gpu", makeStage(), "input", {});
      const resultPromise = service.waitForResult(id);

      const cancelled = service.cancelDelegation(id);
      expect(cancelled).toBe(true);

      await expect(resultPromise).rejects.toThrow(`Delegation ${id} cancelled`);
    });

    it("returns false for unknown delegation", () => {
      expect(service.cancelDelegation("nonexistent")).toBe(false);
    });

    it("removes delegation from active list after cancel", () => {
      const id = service.delegateStage("run-1", 0, "peer-gpu", makeStage(), "input", {});
      swallow(service.waitForResult(id));
      expect(service.getActiveDelegations()).toHaveLength(1);

      service.cancelDelegation(id);
      expect(service.getActiveDelegations()).toHaveLength(0);
    });
  });

  // ── Token / Metrics Tracking ─────────────────────────────────────────────

  describe("token tracking", () => {
    it("propagates tokensUsed from peer result", async () => {
      const id = service.delegateStage("run-1", 0, "peer-gpu", makeStage(), "input", {});
      const resultPromise = service.waitForResult(id);

      federation._dispatch("stage:delegate:result", {
        type: "stage:delegate:result",
        from: "peer-gpu",
        correlationId: "corr-1",
        payload: {
          delegationId: id,
          status: "completed",
          output: "done",
          tokensUsed: 4200,
          executionMs: 8500,
        },
        hmac: "",
        timestamp: Date.now(),
      }, makePeerInfo());

      const result = await resultPromise;
      expect(result.tokensUsed).toBe(4200);
      expect(result.executionMs).toBe(8500);
    });
  });

  // ── Unknown Peer Rejection ───────────────────────────────────────────────

  describe("unknown peer rejection", () => {
    it("rejects delegation to peer not in connected list", () => {
      // peer-unknown is not returned by getPeers()
      expect(service.canDelegate("development", "peer-unknown")).toBe(false);
    });
  });

  // ── Handler Registration ─────────────────────────────────────────────────

  describe("handler registration", () => {
    it("registers stage:delegate handler", () => {
      expect(federation._handlers.has("stage:delegate")).toBe(true);
    });

    it("registers stage:delegate:result handler", () => {
      expect(federation._handlers.has("stage:delegate:result")).toBe(true);
    });
  });

  // ── Incoming Delegation (handler) ────────────────────────────────────────

  describe("incoming delegation handler", () => {
    it("executes locally and sends result back", async () => {
      const executor: LocalStageExecutor = vi.fn().mockResolvedValue({
        output: "computed result",
        tokensUsed: 500,
        executionMs: 2000,
      });
      service.setLocalExecutor(executor);

      const requestPayload = {
        id: "deleg-incoming-1",
        runId: "run-remote",
        stageIndex: 2,
        stage: makeStage(),
        input: "do the thing",
        variables: { KEY: "val" },
        fromInstanceId: "peer-gpu",
      };

      federation._dispatch("stage:delegate", {
        type: "stage:delegate",
        from: "peer-gpu",
        correlationId: "corr-x",
        payload: requestPayload,
        hmac: "",
        timestamp: Date.now(),
      }, makePeerInfo("peer-gpu"));

      // Allow async handler to complete
      await vi.advanceTimersByTimeAsync(0);

      expect(executor).toHaveBeenCalledWith(
        "run-remote", 2, expect.any(Object), "do the thing", { KEY: "val" },
      );

      // Check that result was sent back
      const resultMsg = federation._sentMessages.find((m) => m.type === "stage:delegate:result");
      expect(resultMsg).toBeDefined();
      const resultPayload = resultMsg!.payload as Record<string, unknown>;
      expect(resultPayload.delegationId).toBe("deleg-incoming-1");
      expect(resultPayload.status).toBe("completed");
      expect(resultPayload.output).toBe("computed result");
      expect(resultPayload.tokensUsed).toBe(500);
    });

    it("sends failure when no executor is configured", async () => {
      // No executor set
      federation._dispatch("stage:delegate", {
        type: "stage:delegate",
        from: "peer-gpu",
        correlationId: "corr-y",
        payload: {
          id: "deleg-no-exec",
          runId: "run-x",
          stageIndex: 0,
          stage: makeStage(),
          input: "test",
          variables: {},
          fromInstanceId: "peer-gpu",
        },
        hmac: "",
        timestamp: Date.now(),
      }, makePeerInfo("peer-gpu"));

      await vi.advanceTimersByTimeAsync(0);

      const resultMsg = federation._sentMessages.find((m) => m.type === "stage:delegate:result");
      expect(resultMsg).toBeDefined();
      const payload = resultMsg!.payload as Record<string, unknown>;
      expect(payload.status).toBe("failed");
      expect(payload.error).toContain("No local executor");
    });

    it("sends failure when delegation is disabled on receiver", async () => {
      service.updatePolicy(defaultPolicy({ enabled: false }));
      service.setLocalExecutor(vi.fn());

      federation._dispatch("stage:delegate", {
        type: "stage:delegate",
        from: "peer-gpu",
        correlationId: "corr-z",
        payload: {
          id: "deleg-disabled",
          runId: "run-x",
          stageIndex: 0,
          stage: makeStage(),
          input: "test",
          variables: {},
          fromInstanceId: "peer-gpu",
        },
        hmac: "",
        timestamp: Date.now(),
      }, makePeerInfo("peer-gpu"));

      await vi.advanceTimersByTimeAsync(0);

      const resultMsg = federation._sentMessages.find((m) => m.type === "stage:delegate:result");
      expect(resultMsg).toBeDefined();
      const payload = resultMsg!.payload as Record<string, unknown>;
      expect(payload.status).toBe("failed");
      expect(payload.error).toContain("disabled");
    });

    it("sends failure when executor throws", async () => {
      service.setLocalExecutor(vi.fn().mockRejectedValue(new Error("GPU OOM")));

      federation._dispatch("stage:delegate", {
        type: "stage:delegate",
        from: "peer-gpu",
        correlationId: "corr-err",
        payload: {
          id: "deleg-err",
          runId: "run-x",
          stageIndex: 0,
          stage: makeStage(),
          input: "test",
          variables: {},
          fromInstanceId: "peer-gpu",
        },
        hmac: "",
        timestamp: Date.now(),
      }, makePeerInfo("peer-gpu"));

      await vi.advanceTimersByTimeAsync(0);

      const resultMsg = federation._sentMessages.find((m) => m.type === "stage:delegate:result");
      expect(resultMsg).toBeDefined();
      const payload = resultMsg!.payload as Record<string, unknown>;
      expect(payload.status).toBe("failed");
      expect(payload.error).toBe("GPU OOM");
    });
  });

  // ── delegateAndWait ──────────────────────────────────────────────────────

  describe("delegateAndWait", () => {
    it("sends and waits for result in one call", async () => {
      const promise = service.delegateAndWait(
        "run-1", 0, "peer-gpu", makeStage(), "input", {},
      );

      // Get the delegation ID from the sent message
      const sentPayload = federation._sentMessages[0].payload as { id: string };

      federation._dispatch("stage:delegate:result", {
        type: "stage:delegate:result",
        from: "peer-gpu",
        correlationId: "corr-1",
        payload: {
          delegationId: sentPayload.id,
          status: "completed",
          output: "quick result",
          tokensUsed: 100,
          executionMs: 500,
        },
        hmac: "",
        timestamp: Date.now(),
      }, makePeerInfo());

      const result = await promise;
      expect(result.status).toBe("completed");
      expect(result.output).toBe("quick result");
    });
  });

  // ── getActiveDelegations ─────────────────────────────────────────────────

  describe("getActiveDelegations", () => {
    it("returns empty when no delegations", () => {
      expect(service.getActiveDelegations()).toEqual([]);
    });

    it("tracks pending delegations", () => {
      const id = service.delegateStage("run-1", 0, "peer-gpu", makeStage(), "input", {});
      swallow(service.waitForResult(id));

      const active = service.getActiveDelegations();
      expect(active).toHaveLength(1);
      expect(active[0].delegationId).toBe(id);
    });

    it("removes completed delegations", async () => {
      const id = service.delegateStage("run-1", 0, "peer-gpu", makeStage(), "input", {});
      const promise = service.waitForResult(id);

      federation._dispatch("stage:delegate:result", {
        type: "stage:delegate:result",
        from: "peer-gpu",
        correlationId: "corr-1",
        payload: {
          delegationId: id,
          status: "completed",
          output: "done",
          tokensUsed: 0,
          executionMs: 0,
        },
        hmac: "",
        timestamp: Date.now(),
      }, makePeerInfo());

      await promise;
      expect(service.getActiveDelegations()).toHaveLength(0);
    });
  });

  // ── getPolicy / updatePolicy ─────────────────────────────────────────────

  describe("policy management", () => {
    it("returns current policy", () => {
      const policy = service.getPolicy();
      expect(policy.enabled).toBe(true);
      expect(policy.maxConcurrent).toBe(5);
    });

    it("updates policy", () => {
      service.updatePolicy(defaultPolicy({ maxConcurrent: 10 }));
      expect(service.getPolicy().maxConcurrent).toBe(10);
    });

    it("returns a copy, not a reference", () => {
      const policy = service.getPolicy();
      policy.enabled = false;
      expect(service.getPolicy().enabled).toBe(true);
    });
  });

  // ── dispose ──────────────────────────────────────────────────────────────

  describe("dispose", () => {
    it("rejects all pending delegations", async () => {
      const id = service.delegateStage("run-1", 0, "peer-gpu", makeStage(), "input", {});
      const promise = service.waitForResult(id);

      service.dispose();

      await expect(promise).rejects.toThrow("Service shutting down");
      expect(service.getActiveDelegations()).toHaveLength(0);
    });
  });
});
