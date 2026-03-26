import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApprovalVotingService } from "../../server/federation/approval-voting";
import type { ApprovalVote } from "../../shared/types";
import type { Gateway } from "../../server/gateway/index";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeVote(overrides: Partial<ApprovalVote> = {}): ApprovalVote {
  return {
    userId: "user-1",
    instanceId: "instance-1",
    vote: "approve",
    timestamp: Date.now(),
    ...overrides,
  };
}

function createMockGateway(response: string = "VERDICT: APPROVE\nREASONING: All arguments favor approval."): Gateway {
  return {
    complete: vi.fn(async () => ({
      content: response,
      tokensUsed: 50,
      modelSlug: "default",
      finishReason: "stop",
    })),
  } as unknown as Gateway;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("ApprovalVotingService", () => {
  let gateway: Gateway;
  let service: ApprovalVotingService;

  beforeEach(() => {
    vi.useFakeTimers();
    gateway = createMockGateway();
    service = new ApprovalVotingService(gateway);
  });

  // ── Unanimous approval ────────────────────────────────────────────────────

  it("resolves unanimously when all votes approve", async () => {
    const promise = service.requestVotes("run-1", 0, 2);

    await service.castVoteForStage("run-1", 0, makeVote({
      userId: "user-1", instanceId: "inst-1", vote: "approve",
    }));
    const resolution = await service.castVoteForStage("run-1", 0, makeVote({
      userId: "user-2", instanceId: "inst-2", vote: "approve",
    }));

    const result = await promise;
    expect(result.method).toBe("unanimous");
    expect(result.verdict).toBe("approve");
    expect(result.votes).toHaveLength(2);

    // castVoteForStage also returns the resolution on completion
    expect(resolution).toBeTruthy();
    expect(resolution!.method).toBe("unanimous");
  });

  // ── Unanimous rejection ───────────────────────────────────────────────────

  it("resolves unanimously when all votes reject", async () => {
    const promise = service.requestVotes("run-1", 0, 2);

    await service.castVoteForStage("run-1", 0, makeVote({
      userId: "user-1", instanceId: "inst-1", vote: "reject", reason: "Not ready",
    }));
    await service.castVoteForStage("run-1", 0, makeVote({
      userId: "user-2", instanceId: "inst-2", vote: "reject", reason: "Needs review",
    }));

    const result = await promise;
    expect(result.method).toBe("unanimous");
    expect(result.verdict).toBe("reject");
  });

  // ── Disagreement triggers arbitration ─────────────────────────────────────

  it("arbitrates when votes disagree", async () => {
    const promise = service.requestVotes("run-1", 0, 2);

    await service.castVoteForStage("run-1", 0, makeVote({
      userId: "user-1", instanceId: "inst-1", vote: "approve", reason: "Looks good",
    }));
    await service.castVoteForStage("run-1", 0, makeVote({
      userId: "user-2", instanceId: "inst-2", vote: "reject", reason: "Security concern",
    }));

    const result = await promise;
    expect(result.method).toBe("arbitration");
    expect(result.verdict).toBe("approve");
    expect(result.reasoning).toBeTruthy();
    expect(gateway.complete).toHaveBeenCalledTimes(1);
  });

  it("arbitration parses REJECT verdict correctly", async () => {
    const rejectGateway = createMockGateway(
      "VERDICT: REJECT\nREASONING: Security concerns outweigh the benefits.",
    );
    const rejectService = new ApprovalVotingService(rejectGateway);

    const promise = rejectService.requestVotes("run-1", 0, 2);

    await rejectService.castVoteForStage("run-1", 0, makeVote({
      userId: "user-1", instanceId: "inst-1", vote: "approve",
    }));
    await rejectService.castVoteForStage("run-1", 0, makeVote({
      userId: "user-2", instanceId: "inst-2", vote: "reject",
    }));

    const result = await promise;
    expect(result.method).toBe("arbitration");
    expect(result.verdict).toBe("reject");
    expect(result.reasoning).toContain("Security concerns");
  });

  // ── Escalation when no gateway ────────────────────────────────────────────

  it("escalates when no gateway is available for arbitration", async () => {
    const noGatewayService = new ApprovalVotingService(null);
    const promise = noGatewayService.requestVotes("run-1", 0, 2);

    await noGatewayService.castVoteForStage("run-1", 0, makeVote({
      userId: "user-1", instanceId: "inst-1", vote: "approve",
    }));
    await noGatewayService.castVoteForStage("run-1", 0, makeVote({
      userId: "user-2", instanceId: "inst-2", vote: "reject",
    }));

    const result = await promise;
    expect(result.method).toBe("escalation");
    expect(result.reasoning).toContain("No gateway available");
  });

  // ── Escalation when LLM fails ────────────────────────────────────────────

  it("escalates when gateway.complete throws", async () => {
    const failGateway = {
      complete: vi.fn(async () => { throw new Error("LLM unavailable"); }),
    } as unknown as Gateway;
    const failService = new ApprovalVotingService(failGateway);

    const promise = failService.requestVotes("run-1", 0, 2);

    await failService.castVoteForStage("run-1", 0, makeVote({
      userId: "user-1", instanceId: "inst-1", vote: "approve",
    }));
    await failService.castVoteForStage("run-1", 0, makeVote({
      userId: "user-2", instanceId: "inst-2", vote: "reject",
    }));

    const result = await promise;
    expect(result.method).toBe("escalation");
    expect(result.reasoning).toContain("Arbitration LLM call failed");
  });

  // ── Timeout handling ──────────────────────────────────────────────────────

  it("resolves via escalation when no votes received within timeout", async () => {
    const promise = service.requestVotes("run-1", 0, 3);

    // Advance past timeout
    vi.advanceTimersByTime(61_000);

    const result = await promise;
    expect(result.method).toBe("escalation");
    expect(result.reasoning).toContain("No votes received");
  });

  it("resolves with partial votes after timeout", async () => {
    const promise = service.requestVotes("run-1", 0, 3);

    await service.castVoteForStage("run-1", 0, makeVote({
      userId: "user-1", instanceId: "inst-1", vote: "approve",
    }));

    // Only 1 of 3 votes in -- advance past timeout
    vi.advanceTimersByTime(61_000);

    const result = await promise;
    expect(result.method).toBe("unanimous"); // Only approves so far
    expect(result.verdict).toBe("approve");
    expect(result.votes).toHaveLength(1);
  });

  // ── Duplicate vote prevention ─────────────────────────────────────────────

  it("ignores duplicate votes from same user+instance", async () => {
    const promise = service.requestVotes("run-1", 0, 2);

    await service.castVoteForStage("run-1", 0, makeVote({
      userId: "user-1", instanceId: "inst-1", vote: "approve",
    }));

    // Same user votes again -- should be ignored
    const result = await service.castVoteForStage("run-1", 0, makeVote({
      userId: "user-1", instanceId: "inst-1", vote: "reject",
    }));

    expect(result).toBeNull(); // Not resolved yet, duplicate was ignored
    const votes = service.getVotes("run-1", 0);
    expect(votes).toHaveLength(1);
    expect(votes[0].vote).toBe("approve"); // First vote stands

    // Advance timeout to clean up
    vi.advanceTimersByTime(61_000);
    await promise;
  });

  // ── hasPendingApproval ────────────────────────────────────────────────────

  it("returns true when approval is pending", async () => {
    const promise = service.requestVotes("run-1", 0, 1);
    expect(service.hasPendingApproval("run-1", 0)).toBe(true);
    expect(service.hasPendingApproval("run-1", 1)).toBe(false);

    await service.castVoteForStage("run-1", 0, makeVote());
    await promise;
    expect(service.hasPendingApproval("run-1", 0)).toBe(false);
  });

  // ── getVotes ──────────────────────────────────────────────────────────────

  it("returns empty array for non-existent approval", () => {
    expect(service.getVotes("run-1", 99)).toEqual([]);
  });

  // ── castVoteForStage returns null when no pending ─────────────────────────

  it("returns null when voting for non-existent approval", async () => {
    const result = await service.castVoteForStage("nonexistent", 0, makeVote());
    expect(result).toBeNull();
  });

  // ── Single voter ──────────────────────────────────────────────────────────

  it("resolves immediately with single expected voter", async () => {
    const promise = service.requestVotes("run-1", 0, 1);

    await service.castVoteForStage("run-1", 0, makeVote({
      userId: "user-1", vote: "approve",
    }));

    const result = await promise;
    expect(result.method).toBe("unanimous");
    expect(result.verdict).toBe("approve");
    expect(result.votes).toHaveLength(1);
  });
});
