/**
 * Unit tests for DelegationService — Phase 6.4
 *
 * Covers: depth enforcement, circular detection, timeout, blocking vs async modes,
 * error handling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DelegationService,
  DelegationDepthError,
  DelegationCircularError,
  DelegationTimeoutError,
} from "../../../server/pipeline/delegation-service.js";
import { MAX_DELEGATION_DEPTH } from "../../../shared/types.js";
import type { DelegationRequest, TeamId } from "../../../shared/types.js";
import type { IStorage } from "../../../server/storage.js";
import type { TeamRegistry } from "../../../server/teams/registry.js";
import type { WsManager } from "../../../server/ws/manager.js";
import type { Gateway } from "../../../server/gateway/index.js";
import type { DelegationRequestRow } from "../../../shared/schema.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  return {
    fromStage: "architecture" as TeamId,
    toStage: "development" as TeamId,
    task: "Generate PoC",
    context: {},
    priority: "blocking",
    timeout: 5000,
    ...overrides,
  };
}

function makeRow(id = "row-1"): DelegationRequestRow {
  return {
    id,
    runId: "run-1",
    fromStage: "architecture",
    toStage: "development",
    task: "Generate PoC",
    context: {},
    priority: "blocking",
    timeout: 5000,
    depth: 0,
    status: "running",
    result: null,
    errorMessage: null,
    startedAt: new Date(),
    completedAt: null,
    createdAt: new Date(),
  };
}

function makeStorage(row = makeRow()): IStorage {
  return {
    createDelegationRequest: vi.fn().mockResolvedValue(row),
    getDelegationRequests: vi.fn().mockResolvedValue([row]),
    updateDelegationRequest: vi.fn().mockResolvedValue(row),
  } as unknown as IStorage;
}

function makeTeam() {
  return {
    execute: vi.fn().mockResolvedValue({
      output: { answer: "hello" },
      raw: "hello",
      tokensUsed: 10,
    }),
  };
}

function makeRegistry(team = makeTeam()): TeamRegistry {
  return {
    getTeam: vi.fn().mockReturnValue(team),
  } as unknown as TeamRegistry;
}

function makeWsManager(): WsManager {
  return {
    broadcastToRun: vi.fn(),
  } as unknown as WsManager;
}

function makeGateway(): Gateway {
  return {} as unknown as Gateway;
}

function makeService(overrides: {
  storage?: IStorage;
  registry?: TeamRegistry;
  ws?: WsManager;
} = {}): DelegationService {
  return new DelegationService(
    overrides.storage ?? makeStorage(),
    overrides.registry ?? makeRegistry(),
    overrides.ws ?? makeWsManager(),
    makeGateway(),
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DelegationService", () => {
  describe("depth enforcement", () => {
    it("uses named constant MAX_DELEGATION_DEPTH, not magic number", () => {
      expect(MAX_DELEGATION_DEPTH).toBe(2);
    });

    it("allows delegation when callChain is empty", async () => {
      const svc = makeService();
      const result = await svc.delegate("run-1", makeRequest(), []);
      expect(result.output).toEqual({ answer: "hello" });
    });

    it("allows delegation when callChain has one entry (depth 1)", async () => {
      const svc = makeService();
      const result = await svc.delegate("run-1", makeRequest(), ["planning"]);
      expect(result.output).toEqual({ answer: "hello" });
    });

    it("rejects when callChain.length >= MAX_DELEGATION_DEPTH", async () => {
      const svc = makeService();
      const chain: TeamId[] = ["planning", "architecture"];
      await expect(svc.delegate("run-1", makeRequest(), chain))
        .rejects.toBeInstanceOf(DelegationDepthError);
    });

    it("includes depth in error message", async () => {
      const svc = makeService();
      const chain: TeamId[] = ["planning", "architecture"];
      await expect(svc.delegate("run-1", makeRequest(), chain))
        .rejects.toThrow(String(chain.length));
    });
  });

  describe("circular detection", () => {
    it("allows A→B when B is not in callChain", async () => {
      const svc = makeService();
      await expect(
        svc.delegate("run-1", makeRequest({ fromStage: "architecture", toStage: "development" }), ["architecture"]),
      ).resolves.toBeDefined();
    });

    it("rejects A→B when B is already in callChain", async () => {
      const svc = makeService();
      const chain: TeamId[] = ["development"];
      await expect(
        svc.delegate("run-1", makeRequest({ toStage: "development" }), chain),
      ).rejects.toBeInstanceOf(DelegationCircularError);
    });

    it("circular error message contains the chain", async () => {
      const svc = makeService();
      await expect(
        svc.delegate("run-1", makeRequest({ toStage: "development" }), ["development"]),
      ).rejects.toThrow("development");
    });

    it("rejects A→B→A scenario at second delegation", async () => {
      // First call: architecture→development (chain=["architecture"])
      // Inside development's execution, it would call development→architecture
      // callChain at that point would be ["architecture", "development"]
      // and toStage="architecture" which IS in callChain
      const svc = makeService();
      const chain: TeamId[] = ["architecture", "development"];
      await expect(
        svc.delegate("run-1", makeRequest({ toStage: "architecture" }), chain),
      ).rejects.toBeInstanceOf(DelegationDepthError); // hits depth check first
    });
  });

  describe("timeout enforcement", () => {
    it("rejects blocking call that exceeds timeout ms", async () => {
      vi.useFakeTimers();

      const slowTeam = {
        execute: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({
            output: {}, raw: "", tokensUsed: 0
          }), 10000)),
        ),
      };
      const storage = makeStorage();
      const svc = makeService({
        storage,
        registry: makeRegistry(slowTeam),
      });

      const promise = svc.delegate("run-1", makeRequest({ timeout: 100 }), []);
      vi.advanceTimersByTime(200);

      await expect(promise).rejects.toBeInstanceOf(DelegationTimeoutError);
      vi.useRealTimers();
    });

    it("updates DB record status to timeout on timeout", async () => {
      vi.useFakeTimers();

      const slowTeam = {
        execute: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({
            output: {}, raw: "", tokensUsed: 0
          }), 10000)),
        ),
      };
      const storage = makeStorage();
      const svc = makeService({
        storage,
        registry: makeRegistry(slowTeam),
      });

      const promise = svc.delegate("run-1", makeRequest({ timeout: 100 }), []);
      vi.advanceTimersByTime(200);

      await expect(promise).rejects.toBeInstanceOf(DelegationTimeoutError);

      expect(storage.updateDelegationRequest).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "timeout" }),
      );

      vi.useRealTimers();
    });

    it("broadcasts delegation:failed on timeout", async () => {
      vi.useFakeTimers();

      const slowTeam = {
        execute: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({
            output: {}, raw: "", tokensUsed: 0
          }), 10000)),
        ),
      };
      const ws = makeWsManager();
      const svc = makeService({
        registry: makeRegistry(slowTeam),
        ws,
      });

      const promise = svc.delegate("run-1", makeRequest({ timeout: 100 }), []);
      vi.advanceTimersByTime(200);

      await expect(promise).rejects.toBeInstanceOf(DelegationTimeoutError);

      expect(ws.broadcastToRun).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({ type: "delegation:failed" }),
      );

      vi.useRealTimers();
    });
  });

  describe("blocking mode", () => {
    it("returns DelegationResult on successful execution", async () => {
      const svc = makeService();
      const result = await svc.delegate("run-1", makeRequest(), []);
      expect(result).toMatchObject({
        output: { answer: "hello" },
        raw: "hello",
        tokensUsed: 10,
      });
      expect(typeof result.durationMs).toBe("number");
    });

    it("persists delegation_requests row with status completed", async () => {
      const storage = makeStorage();
      const svc = makeService({ storage });
      await svc.delegate("run-1", makeRequest(), []);
      expect(storage.updateDelegationRequest).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "completed" }),
      );
    });

    it("broadcasts delegation:requested then delegation:completed", async () => {
      const ws = makeWsManager();
      const svc = makeService({ ws });
      await svc.delegate("run-1", makeRequest(), []);

      const calls = (ws.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls;
      const types = calls.map((c) => (c[1] as { type: string }).type);
      expect(types).toContain("delegation:requested");
      expect(types).toContain("delegation:completed");
    });
  });

  describe("async mode", () => {
    it("delegateAsync returns void immediately", () => {
      const svc = makeService();
      const result = svc.delegateAsync("run-1", makeRequest(), []);
      expect(result).toBeUndefined();
    });

    it("does not throw synchronously even on validation pass", () => {
      const svc = makeService();
      expect(() => svc.delegateAsync("run-1", makeRequest(), [])).not.toThrow();
    });

    it("throws synchronously when depth limit exceeded", () => {
      const svc = makeService();
      const chain: TeamId[] = ["planning", "architecture"];
      expect(() => svc.delegateAsync("run-1", makeRequest(), chain))
        .toThrow(DelegationDepthError);
    });

    it("throws synchronously when circular delegation detected", () => {
      const svc = makeService();
      expect(() => svc.delegateAsync("run-1", makeRequest({ toStage: "development" }), ["development"]))
        .toThrow(DelegationCircularError);
    });
  });

  describe("error handling", () => {
    it("sets status to failed when team.execute throws", async () => {
      const failingTeam = {
        execute: vi.fn().mockRejectedValue(new Error("model failure")),
      };
      const storage = makeStorage();
      const svc = makeService({
        storage,
        registry: makeRegistry(failingTeam),
      });

      await expect(svc.delegate("run-1", makeRequest(), [])).rejects.toThrow("model failure");

      expect(storage.updateDelegationRequest).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "failed" }),
      );
    });

    it("broadcasts delegation:failed on team execute error", async () => {
      const failingTeam = {
        execute: vi.fn().mockRejectedValue(new Error("model failure")),
      };
      const ws = makeWsManager();
      const svc = makeService({
        registry: makeRegistry(failingTeam),
        ws,
      });

      await expect(svc.delegate("run-1", makeRequest(), [])).rejects.toThrow();

      expect(ws.broadcastToRun).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({ type: "delegation:failed" }),
      );
    });

    it("re-throws error from delegate() in blocking mode", async () => {
      const failingTeam = {
        execute: vi.fn().mockRejectedValue(new Error("unique-failure-xyz")),
      };
      const svc = makeService({ registry: makeRegistry(failingTeam) });
      await expect(svc.delegate("run-1", makeRequest(), []))
        .rejects.toThrow("unique-failure-xyz");
    });
  });
});
