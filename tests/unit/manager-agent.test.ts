import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import {
  ManagerAgent,
  ManagerMaxIterationsError,
  ManagerInvalidTeamError,
  ManagerInvalidResponseError,
} from "../../server/pipeline/manager-agent";
import type { IStorage } from "../../server/storage";
import type { TeamRegistry } from "../../server/teams/registry";
import type { WsManager } from "../../server/ws/manager";
import type { Gateway } from "../../server/gateway/index";
import type { DelegationService } from "../../server/pipeline/delegation-service";
import type { ManagerConfig } from "../../shared/types";

const makeConfig = (overrides?: Partial<ManagerConfig>): ManagerConfig => ({
  managerModel: "mock-model",
  availableTeams: ["development", "testing"],
  maxIterations: 5,
  goal: "Write and test a hello world function",
  ...overrides,
});

const makeAbortSignal = (aborted = false): AbortSignal =>
  ({
    aborted,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onabort: null,
    reason: undefined,
    throwIfAborted: vi.fn(),
  } as unknown as AbortSignal);

function buildMocks(llmResponses: string[]) {
  let callIndex = 0;
  const storage = {
    createManagerIteration: vi.fn().mockResolvedValue({ id: "iter-1" }),
    updateManagerIteration: vi.fn().mockResolvedValue(undefined),
    getManagerIterations: vi.fn().mockResolvedValue([]),
    countManagerIterations: vi.fn().mockResolvedValue(0),
  } as unknown as IStorage;
  const teamRegistry = {
    getTeam: vi.fn().mockReturnValue({ config: { description: "A team" } }),
    getAll: vi.fn().mockReturnValue(new Map([["development", {}], ["testing", {}]])),
  } as unknown as TeamRegistry;
  const wsManager = {
    broadcastToRun: vi.fn(),
  } as unknown as WsManager;
  const gateway = {
    complete: vi.fn().mockImplementation(() => {
      const response = llmResponses[callIndex++];
      return Promise.resolve({ content: response, tokensUsed: 100 });
    }),
  } as unknown as Gateway;
  const delegationService = {
    delegate: vi.fn().mockResolvedValue({ raw: "Team output here" }),
  } as unknown as DelegationService;
  return { storage, teamRegistry, wsManager, gateway, delegationService };
}

describe("ManagerAgent", () => {
  describe("normal flow", () => {
    it("completes when LLM returns complete action", async () => {
      const mocks = buildMocks([
        JSON.stringify({ action: "dispatch", teamId: "development", task: "Write code", reasoning: "Need code" }),
        JSON.stringify({ action: "complete", reasoning: "Done", outcome: "Success" }),
      ]);
      const agent = new ManagerAgent(mocks.storage, mocks.teamRegistry, mocks.wsManager, mocks.gateway, mocks.delegationService);
      const result = await agent.run("run-1", "Write hello world", makeConfig(), makeAbortSignal());
      expect(result.status).toBe("completed");
      expect(result.iterations).toBe(2);
      expect(mocks.delegationService.delegate).toHaveBeenCalledTimes(1);
    });

    it("fails when LLM returns fail action", async () => {
      const mocks = buildMocks([
        JSON.stringify({ action: "fail", reasoning: "Cannot do it", outcome: "Impossible" }),
      ]);
      const agent = new ManagerAgent(mocks.storage, mocks.teamRegistry, mocks.wsManager, mocks.gateway, mocks.delegationService);
      const result = await agent.run("run-1", "input", makeConfig(), makeAbortSignal());
      expect(result.status).toBe("failed");
      expect(mocks.delegationService.delegate).not.toHaveBeenCalled();
    });
  });

  describe("iteration limit", () => {
    it("throws ManagerMaxIterationsError when maxIterations is reached", async () => {
      const mocks = buildMocks(Array(10).fill(JSON.stringify({ action: "dispatch", teamId: "development", task: "Work", reasoning: "Working" })));
      const agent = new ManagerAgent(mocks.storage, mocks.teamRegistry, mocks.wsManager, mocks.gateway, mocks.delegationService);
      await expect(agent.run("run-1", "input", makeConfig({ maxIterations: 3 }), makeAbortSignal())).rejects.toThrow(ManagerMaxIterationsError);
      expect(mocks.gateway.complete).toHaveBeenCalledTimes(3);
    });

    it("caps maxIterations at 20 even when config requests more", async () => {
      const mocks = buildMocks(Array(25).fill(JSON.stringify({ action: "dispatch", teamId: "development", task: "Work", reasoning: "Working" })));
      const agent = new ManagerAgent(mocks.storage, mocks.teamRegistry, mocks.wsManager, mocks.gateway, mocks.delegationService);
      await expect(agent.run("run-1", "input", makeConfig({ maxIterations: 100 }), makeAbortSignal())).rejects.toThrow(ManagerMaxIterationsError);
      expect(mocks.gateway.complete).toHaveBeenCalledTimes(20);
    });
  });

  describe("security — teamId allowlist", () => {
    it("throws ManagerInvalidTeamError when LLM returns unlisted teamId", async () => {
      const mocks = buildMocks([JSON.stringify({ action: "dispatch", teamId: "deployment", task: "Deploy", reasoning: "Inject" })]);
      const agent = new ManagerAgent(mocks.storage, mocks.teamRegistry, mocks.wsManager, mocks.gateway, mocks.delegationService);
      await expect(agent.run("run-1", "input", makeConfig(), makeAbortSignal())).rejects.toThrow(ManagerInvalidTeamError);
      expect(mocks.delegationService.delegate).not.toHaveBeenCalled();
    });
  });

  describe("input validation", () => {
    it("throws ManagerInvalidResponseError on invalid JSON", async () => {
      const mocks = buildMocks(["not json"]);
      const agent = new ManagerAgent(mocks.storage, mocks.teamRegistry, mocks.wsManager, mocks.gateway, mocks.delegationService);
      await expect(agent.run("run-1", "input", makeConfig(), makeAbortSignal())).rejects.toThrow(ManagerInvalidResponseError);
    });

    it("throws ManagerInvalidResponseError on missing reasoning", async () => {
      const mocks = buildMocks([JSON.stringify({ action: "dispatch", teamId: "development", task: "Work" })]);
      const agent = new ManagerAgent(mocks.storage, mocks.teamRegistry, mocks.wsManager, mocks.gateway, mocks.delegationService);
      await expect(agent.run("run-1", "input", makeConfig(), makeAbortSignal())).rejects.toThrow(ManagerInvalidResponseError);
    });

    it("throws ManagerInvalidResponseError on dispatch without teamId", async () => {
      const mocks = buildMocks([JSON.stringify({ action: "dispatch", task: "Work", reasoning: "Reason" })]);
      const agent = new ManagerAgent(mocks.storage, mocks.teamRegistry, mocks.wsManager, mocks.gateway, mocks.delegationService);
      await expect(agent.run("run-1", "input", makeConfig(), makeAbortSignal())).rejects.toThrow(ManagerInvalidResponseError);
    });

    it("throws ManagerInvalidResponseError on complete without outcome", async () => {
      const mocks = buildMocks([JSON.stringify({ action: "complete", reasoning: "Done" })]);
      const agent = new ManagerAgent(mocks.storage, mocks.teamRegistry, mocks.wsManager, mocks.gateway, mocks.delegationService);
      await expect(agent.run("run-1", "input", makeConfig(), makeAbortSignal())).rejects.toThrow(ManagerInvalidResponseError);
    });
  });

  describe("AbortSignal", () => {
    it("throws when already aborted before first iteration", async () => {
      const mocks = buildMocks([]);
      const agent = new ManagerAgent(mocks.storage, mocks.teamRegistry, mocks.wsManager, mocks.gateway, mocks.delegationService);
      await expect(agent.run("run-1", "input", makeConfig(), makeAbortSignal(true))).rejects.toThrow("Manager run cancelled");
      expect(mocks.gateway.complete).not.toHaveBeenCalled();
    });
  });

  describe("WebSocket events", () => {
    it("broadcasts manager:decision for each iteration", async () => {
      const mocks = buildMocks([
        JSON.stringify({ action: "dispatch", teamId: "development", task: "Work", reasoning: "Need to code" }),
        JSON.stringify({ action: "complete", reasoning: "Done", outcome: "Success" }),
      ]);
      const agent = new ManagerAgent(mocks.storage, mocks.teamRegistry, mocks.wsManager, mocks.gateway, mocks.delegationService);
      await agent.run("run-1", "input", makeConfig(), makeAbortSignal());
      const decisionCalls = (mocks.wsManager.broadcastToRun as Mock).mock.calls.filter(([, event]) => event.type === "manager:decision");
      expect(decisionCalls).toHaveLength(2);
      expect(decisionCalls[0][1].payload.iterationNumber).toBe(1);
    });

    it("broadcasts manager:complete on finish", async () => {
      const mocks = buildMocks([JSON.stringify({ action: "complete", reasoning: "Done", outcome: "All good" })]);
      const agent = new ManagerAgent(mocks.storage, mocks.teamRegistry, mocks.wsManager, mocks.gateway, mocks.delegationService);
      await agent.run("run-1", "input", makeConfig(), makeAbortSignal());
      const completeCalls = (mocks.wsManager.broadcastToRun as Mock).mock.calls.filter(([, event]) => event.type === "manager:complete");
      expect(completeCalls).toHaveLength(1);
      expect(completeCalls[0][1].payload.status).toBe("completed");
    });
  });

  describe("storage", () => {
    it("stores each iteration in DB", async () => {
      const mocks = buildMocks([
        JSON.stringify({ action: "dispatch", teamId: "development", task: "Work", reasoning: "Step 1" }),
        JSON.stringify({ action: "complete", reasoning: "Done", outcome: "Success" }),
      ]);
      const agent = new ManagerAgent(mocks.storage, mocks.teamRegistry, mocks.wsManager, mocks.gateway, mocks.delegationService);
      await agent.run("run-1", "input", makeConfig(), makeAbortSignal());
      expect(mocks.storage.createManagerIteration).toHaveBeenCalledTimes(2);
      expect(mocks.storage.updateManagerIteration).toHaveBeenCalledTimes(1);
    });
  });
});
