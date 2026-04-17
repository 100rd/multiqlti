/**
 * Tests for ConflictResolutionService (issue #229)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ConflictResolutionService,
  type ConflictStorageSink,
} from "../../server/federation/conflict-resolution";
import type { Gateway } from "../../server/gateway/index";
import type {
  SessionConflict,
  DecisionLogEntry,
  ResolutionOutcome,
} from "../../shared/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function createMockGateway(
  response: string = '{"winner":"p1","reasoning":"Proposal 1 is superior.","confidence":0.9}',
): Gateway {
  return {
    complete: vi.fn(async () => ({
      content: response,
      tokensUsed: 50,
      modelSlug: "default",
      finishReason: "stop",
    })),
  } as unknown as Gateway;
}

function createMockSink(): ConflictStorageSink & {
  _conflicts: Map<string, SessionConflict>;
  _log: DecisionLogEntry[];
} {
  const _conflicts = new Map<string, SessionConflict>();
  const _log: DecisionLogEntry[] = [];

  return {
    _conflicts,
    _log,
    async saveConflict(c: SessionConflict) {
      _conflicts.set(c.id, { ...c });
    },
    async appendDecisionLog(e: DecisionLogEntry) {
      _log.push({ ...e });
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("ConflictResolutionService", () => {
  let gateway: Gateway;
  let sink: ReturnType<typeof createMockSink>;
  let service: ConflictResolutionService;

  beforeEach(() => {
    vi.useFakeTimers();
    gateway = createMockGateway();
    sink = createMockSink();
    service = new ConflictResolutionService(gateway, sink);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── raiseConflict ─────────────────────────────────────────────────────────────

  describe("raiseConflict", () => {
    it("creates a conflict with correct initial state", async () => {
      const { conflictId } = await service.raiseConflict({
        sessionId: "session-1",
        raisedBy: "user-1",
        raisedByInstance: "instance-1",
        question: "Should we use REST or GraphQL?",
        strategy: "quorum_vote",
      });

      const conflict = service.getConflict(conflictId);
      expect(conflict).not.toBeNull();
      expect(conflict!.sessionId).toBe("session-1");
      expect(conflict!.question).toBe("Should we use REST or GraphQL?");
      expect(conflict!.status).toBe("open");
      expect(conflict!.strategy).toBe("quorum_vote");
      expect(conflict!.proposals).toHaveLength(0);
      expect(conflict!.votes).toHaveLength(0);
    });

    it("persists the conflict to the sink", async () => {
      const { conflictId } = await service.raiseConflict({
        sessionId: "session-1",
        raisedBy: "user-1",
        raisedByInstance: "instance-1",
        question: "Microservices vs monolith?",
        strategy: "structured_debate",
      });

      expect(sink._conflicts.has(conflictId)).toBe(true);
    });

    it("uses default quorum threshold when not provided", async () => {
      const { conflictId } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "quorum_vote",
      });

      expect(service.getConflict(conflictId)!.quorumThreshold).toBe(0.67);
    });

    it("applies custom quorum threshold", async () => {
      const { conflictId } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "quorum_vote",
        quorumThreshold: 0.75,
      });

      expect(service.getConflict(conflictId)!.quorumThreshold).toBe(0.75);
    });

    it("defer_to_owner resolves immediately", async () => {
      const { resolution } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "defer_to_owner",
      });

      const outcome = await resolution;
      expect(outcome.strategy).toBe("defer_to_owner");
      expect(outcome.decidedBy).toBe("owner");
    });

    it("returns a resolution promise that resolves after quorum", async () => {
      // Threshold=0.8, minimum 2 votes required.
      // Strategy: 1 vote for B (minority), then 4 votes for A.
      // After 5 total votes, A has 4/5=80% → quorum met.
      const { conflictId, resolution } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "quorum_vote",
        quorumThreshold: 0.8,
      });

      // Add two competing proposals
      await service.addProposal(conflictId, {
        authorId: "u1",
        instanceId: "i1",
        title: "Option A",
        description: "Use REST",
      });
      await service.addProposal(conflictId, {
        authorId: "u2",
        instanceId: "i2",
        title: "Option B",
        description: "Use GraphQL",
      });

      const proposals = service.getConflict(conflictId)!.proposals;

      // Cast first vote for B (minority), then three for A
      await service.castVote(conflictId, { participantId: "user-4", instanceId: "i4", proposalId: proposals[1].id });
      await service.castVote(conflictId, { participantId: "user-1", instanceId: "i1", proposalId: proposals[0].id });
      await service.castVote(conflictId, { participantId: "user-2", instanceId: "i2", proposalId: proposals[0].id });
      await service.castVote(conflictId, { participantId: "user-3", instanceId: "i3", proposalId: proposals[0].id });

      // 4 total: A=3/4=75% < 80% — not resolved yet
      expect(service.getConflict(conflictId)!.status).not.toBe("resolved");

      // 5th vote pushes A to 4/5=80% → quorum met
      await service.castVote(conflictId, { participantId: "user-5", instanceId: "i5", proposalId: proposals[0].id });

      const outcome = await resolution;
      expect(outcome.strategy).toBe("quorum_vote");
      expect(outcome.winningProposalId).toBe(proposals[0].id);
      expect(outcome.decidedBy).toBe("quorum");
    });
  });

  // ── addProposal ──────────────────────────────────────────────────────────────

  describe("addProposal", () => {
    it("adds a proposal to the conflict", async () => {
      const { conflictId } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "structured_debate",
      });

      const updated = await service.addProposal(conflictId, {
        authorId: "u1",
        instanceId: "i1",
        title: "Use DDD",
        description: "Domain-driven design approach",
        arguments: "Better separation of concerns",
      });

      expect(updated.proposals).toHaveLength(1);
      expect(updated.proposals[0].title).toBe("Use DDD");
      expect(updated.proposals[0].id).toBeTruthy();
    });

    it("transitions debate conflict to debate_in_progress", async () => {
      const { conflictId } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "structured_debate",
      });

      const updated = await service.addProposal(conflictId, {
        authorId: "u1",
        instanceId: "i1",
        title: "Proposal 1",
        description: "First proposal",
      });

      expect(updated.status).toBe("debate_in_progress");
    });

    it("transitions quorum conflict to voting_in_progress", async () => {
      const { conflictId } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "quorum_vote",
      });

      const updated = await service.addProposal(conflictId, {
        authorId: "u1",
        instanceId: "i1",
        title: "Vote target",
        description: "Option to vote on",
      });

      expect(updated.status).toBe("voting_in_progress");
    });

    it("transitions parallel_experiment conflict and creates branch stubs", async () => {
      const { conflictId } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "parallel_experiment",
      });

      const updated = await service.addProposal(conflictId, {
        authorId: "u1",
        instanceId: "i1",
        title: "Branch A",
        description: "First branch",
      });

      expect(updated.status).toBe("experiment_in_progress");
      expect(updated.experimentResults).toHaveLength(1);
      expect(updated.experimentResults![0].status).toBe("pending");
    });

    it("throws when conflict is resolved", async () => {
      const { conflictId } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "defer_to_owner",
      });

      // defer_to_owner resolves immediately
      await expect(
        service.addProposal(conflictId, {
          authorId: "u1",
          instanceId: "i1",
          title: "Too late",
          description: "Already resolved",
        }),
      ).rejects.toThrow("already resolved");
    });

    it("enforces max proposals limit", async () => {
      const { conflictId } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "structured_debate",
      });

      for (let i = 0; i < 10; i++) {
        await service.addProposal(conflictId, {
          authorId: "u1",
          instanceId: "i1",
          title: `Proposal ${i}`,
          description: "desc",
        });
      }

      await expect(
        service.addProposal(conflictId, {
          authorId: "u1",
          instanceId: "i1",
          title: "Too many",
          description: "Over limit",
        }),
      ).rejects.toThrow("maximum");
    });
  });

  // ── castVote ─────────────────────────────────────────────────────────────────

  describe("castVote", () => {
    // Use threshold=1.0 (100% unanimous) so individual votes during setup
    // don't accidentally trigger quorum resolution.
    async function setupVotingConflict(threshold = 1.0) {
      const { conflictId, resolution } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "quorum_vote",
        quorumThreshold: threshold,
      });

      await service.addProposal(conflictId, {
        authorId: "u1",
        instanceId: "i1",
        title: "Option A",
        description: "A",
      });

      await service.addProposal(conflictId, {
        authorId: "u2",
        instanceId: "i2",
        title: "Option B",
        description: "B",
      });

      const proposals = service.getConflict(conflictId)!.proposals;
      return { conflictId, resolution, proposals };
    }

    it("records a vote without auto-resolving", async () => {
      const { conflictId, proposals } = await setupVotingConflict(1.0);

      const updated = await service.castVote(conflictId, {
        participantId: "user-1",
        instanceId: "i1",
        proposalId: proposals[0].id,
      });

      expect(updated.votes).toHaveLength(1);
      expect(updated.votes[0].proposalId).toBe(proposals[0].id);
      // Not resolved yet — unanimity (1.0) requires all votes
      expect(updated.status).not.toBe("resolved");
    });

    it("prevents duplicate votes from the same participant", async () => {
      const { conflictId, proposals } = await setupVotingConflict(1.0);

      await service.castVote(conflictId, {
        participantId: "user-1",
        instanceId: "i1",
        proposalId: proposals[0].id,
      });

      await expect(
        service.castVote(conflictId, {
          participantId: "user-1",
          instanceId: "i1",
          proposalId: proposals[1].id,
        }),
      ).rejects.toThrow("already voted");
    });

    it("rejects vote for unknown proposal", async () => {
      const { conflictId } = await setupVotingConflict(1.0);

      await expect(
        service.castVote(conflictId, {
          participantId: "user-1",
          instanceId: "i1",
          proposalId: "nonexistent-proposal",
        }),
      ).rejects.toThrow("not found");
    });

    it("rejects vote on non-quorum_vote conflict", async () => {
      const { conflictId } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "structured_debate",
      });

      await service.addProposal(conflictId, {
        authorId: "u1",
        instanceId: "i1",
        title: "P",
        description: "D",
      });

      const proposalId = service.getConflict(conflictId)!.proposals[0].id;

      await expect(
        service.castVote(conflictId, {
          participantId: "user-1",
          instanceId: "i1",
          proposalId,
        }),
      ).rejects.toThrow('strategy "structured_debate"');
    });

    it("resolves when quorum threshold is met", async () => {
      // Use threshold=0.6: need 3 of 4 votes (75%) on one proposal to cross it
      const { conflictId, resolution, proposals } = await setupVotingConflict(0.6);

      // First 2 votes split evenly: 50% each — no resolution
      await service.castVote(conflictId, { participantId: "u1", instanceId: "i1", proposalId: proposals[0].id });
      await service.castVote(conflictId, { participantId: "u2", instanceId: "i2", proposalId: proposals[1].id });

      expect(service.getConflict(conflictId)!.status).not.toBe("resolved");

      // 3rd vote pushes proposals[0] to 2/3 ≈ 67% > 60% → quorum
      await service.castVote(conflictId, { participantId: "u3", instanceId: "i3", proposalId: proposals[0].id });

      const outcome = await resolution;
      expect(outcome.decidedBy).toBe("quorum");
      expect(outcome.winningProposalId).toBe(proposals[0].id);
    });

    it("does not resolve when quorum threshold is not reached", async () => {
      // Use threshold=0.75: need 3 of 4 votes to resolve
      const { conflictId, proposals } = await setupVotingConflict(0.75);

      // 2 votes split 50/50 — no proposal reaches 75%
      await service.castVote(conflictId, { participantId: "u1", instanceId: "i1", proposalId: proposals[0].id });
      await service.castVote(conflictId, { participantId: "u2", instanceId: "i2", proposalId: proposals[1].id });

      const conflict = service.getConflict(conflictId);
      expect(conflict!.status).not.toBe("resolved");
    });
  });

  // ── structured debate ─────────────────────────────────────────────────────────

  describe("structured_debate", () => {
    async function setupDebateConflict() {
      const { conflictId, resolution } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "REST vs GraphQL?",
        strategy: "structured_debate",
      });

      await service.addProposal(conflictId, {
        authorId: "u1",
        instanceId: "i1",
        title: "REST",
        description: "Use REST API",
        arguments: "Simpler, more cacheable",
      });

      await service.addProposal(conflictId, {
        authorId: "u2",
        instanceId: "i2",
        title: "GraphQL",
        description: "Use GraphQL API",
        arguments: "Flexible, fewer round-trips",
      });

      const proposals = service.getConflict(conflictId)!.proposals;
      return { conflictId, resolution, proposals };
    }

    it("runDebateJudge calls gateway and resolves conflict", async () => {
      const { conflictId, resolution, proposals } = await setupDebateConflict();

      // Mock gateway to return winner as first proposal
      (gateway.complete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: `{"winner":"${proposals[0].id}","reasoning":"REST is better here.","confidence":0.85}`,
        tokensUsed: 60,
        modelSlug: "default",
        finishReason: "stop",
      });

      const judgement = await service.runDebateJudge(conflictId);

      expect(judgement.winner).toBe(proposals[0].id);
      expect(judgement.reasoning).toContain("REST");
      expect(judgement.confidence).toBe(0.85);

      const outcome = await resolution;
      expect(outcome.strategy).toBe("structured_debate");
      expect(outcome.winningProposalId).toBe(proposals[0].id);
      expect(outcome.decidedBy).toBe("judge");
    });

    it("runDebateJudge fails gracefully when gateway throws", async () => {
      const { conflictId } = await setupDebateConflict();

      (gateway.complete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("LLM unavailable"),
      );

      await expect(service.runDebateJudge(conflictId)).rejects.toThrow(
        "LLM judge call failed",
      );
    });

    it("runDebateJudge requires at least 2 proposals", async () => {
      const { conflictId } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "structured_debate",
      });

      await service.addProposal(conflictId, {
        authorId: "u1",
        instanceId: "i1",
        title: "Solo proposal",
        description: "Only one",
      });

      await expect(service.runDebateJudge(conflictId)).rejects.toThrow(
        "at least 2 proposals",
      );
    });

    it("runDebateJudge throws when no gateway is available", async () => {
      const noGatewayService = new ConflictResolutionService(null);
      const { conflictId } = await noGatewayService.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "structured_debate",
      });

      await noGatewayService.addProposal(conflictId, {
        authorId: "u1",
        instanceId: "i1",
        title: "P1",
        description: "D1",
      });
      await noGatewayService.addProposal(conflictId, {
        authorId: "u2",
        instanceId: "i2",
        title: "P2",
        description: "D2",
      });

      await expect(noGatewayService.runDebateJudge(conflictId)).rejects.toThrow(
        "No LLM gateway",
      );
    });

    it("handles malformed judge JSON response gracefully", async () => {
      const { conflictId, resolution, proposals } = await setupDebateConflict();

      (gateway.complete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: "This is not JSON at all",
        tokensUsed: 30,
        modelSlug: "default",
        finishReason: "stop",
      });

      const judgement = await service.runDebateJudge(conflictId);
      expect(judgement.confidence).toBe(0);
      expect(judgement.winner).toBeUndefined();

      const outcome = await resolution;
      expect(outcome.decidedBy).toBe("judge");
      expect(outcome.winningProposalId).toBeUndefined();
    });

    it("submitDebateJudgement directly resolves with judge winner", async () => {
      const { conflictId, resolution, proposals } = await setupDebateConflict();

      const conflict = await service.submitDebateJudgement(conflictId, {
        judgeModelSlug: "custom-model",
        winner: proposals[1].id,
        reasoning: "GraphQL wins for this use case.",
        confidence: 0.92,
        evaluatedAt: Date.now(),
      });

      expect(conflict.status).toBe("resolved");
      expect(conflict.judgement?.winner).toBe(proposals[1].id);

      const outcome = await resolution;
      expect(outcome.winningProposalId).toBe(proposals[1].id);
    });
  });

  // ── parallel_experiment ───────────────────────────────────────────────────────

  describe("parallel_experiment", () => {
    it("resolves when all branches complete", async () => {
      const { conflictId, resolution } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Which DB schema is better?",
        strategy: "parallel_experiment",
      });

      await service.addProposal(conflictId, {
        authorId: "u1",
        instanceId: "i1",
        title: "Schema A",
        description: "Normalised",
      });
      await service.addProposal(conflictId, {
        authorId: "u2",
        instanceId: "i2",
        title: "Schema B",
        description: "Denormalised",
      });

      const proposals = service.getConflict(conflictId)!.proposals;

      // Complete first branch
      await service.updateExperimentBranch(conflictId, {
        proposalId: proposals[0].id,
        runId: "run-a",
        status: "completed",
        outcome: "3.2ms avg query",
        completedAt: Date.now(),
      });

      // Still pending (1 of 2 done)
      expect(service.getConflict(conflictId)!.status).toBe("experiment_in_progress");

      // Complete second branch
      await service.updateExperimentBranch(conflictId, {
        proposalId: proposals[1].id,
        runId: "run-b",
        status: "failed",
      });

      const outcome = await resolution;
      expect(outcome.strategy).toBe("parallel_experiment");
      expect(outcome.winningProposalId).toBe(proposals[0].id); // first completed
    });

    it("throws when updating branch on wrong strategy conflict", async () => {
      const { conflictId } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "quorum_vote",
      });

      await service.addProposal(conflictId, {
        authorId: "u1",
        instanceId: "i1",
        title: "P",
        description: "D",
      });

      const proposalId = service.getConflict(conflictId)!.proposals[0].id;

      await expect(
        service.updateExperimentBranch(conflictId, {
          proposalId,
          runId: "run-x",
          status: "completed",
        }),
      ).rejects.toThrow('expected "parallel_experiment"');
    });
  });

  // ── forceResolve ─────────────────────────────────────────────────────────────

  describe("forceResolve", () => {
    it("resolves an open conflict immediately", async () => {
      const { conflictId, resolution } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "quorum_vote",
      });

      await service.addProposal(conflictId, {
        authorId: "u1",
        instanceId: "i1",
        title: "P",
        description: "D",
      });

      const proposals = service.getConflict(conflictId)!.proposals;

      await service.forceResolve(
        conflictId,
        proposals[0].id,
        "Owner decided.",
        "owner",
      );

      const outcome = await resolution;
      expect(outcome.decidedBy).toBe("owner");
      expect(outcome.winningProposalId).toBe(proposals[0].id);
      expect(service.getConflict(conflictId)!.status).toBe("resolved");
    });

    it("throws when conflict is already resolved", async () => {
      const { conflictId } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "defer_to_owner",
      });

      await expect(
        service.forceResolve(conflictId, undefined, "Again?"),
      ).rejects.toThrow("already resolved");
    });
  });

  // ── timeout ───────────────────────────────────────────────────────────────────

  describe("timeout handling", () => {
    it("resolves quorum_vote with plurality winner on timeout", async () => {
      const { conflictId, resolution } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "quorum_vote",
        quorumThreshold: 0.9,
        timeoutMs: 10_000,
      });

      await service.addProposal(conflictId, {
        authorId: "u1",
        instanceId: "i1",
        title: "A",
        description: "D",
      });
      await service.addProposal(conflictId, {
        authorId: "u2",
        instanceId: "i2",
        title: "B",
        description: "D",
      });

      const proposals = service.getConflict(conflictId)!.proposals;

      // Cast minority vote for proposals[1] first, then 2 for proposals[0].
      // With min-2-vote quorum and threshold=0.9:
      // After 3 votes: proposals[0]=2/3=67% < 90% → no auto-resolve.
      await service.castVote(conflictId, { participantId: "u1", instanceId: "i1", proposalId: proposals[1].id });
      await service.castVote(conflictId, { participantId: "u2", instanceId: "i2", proposalId: proposals[0].id });
      await service.castVote(conflictId, { participantId: "u3", instanceId: "i3", proposalId: proposals[0].id });

      // Manually trigger timeout — plurality winner is proposals[0] (2/3 votes)
      await service._triggerTimeout(conflictId);

      const outcome = await resolution;
      expect(outcome.decidedBy).toBe("timeout");
      expect(outcome.winningProposalId).toBe(proposals[0].id); // plurality
    });

    it("expires without resolution when no votes were cast", async () => {
      const { conflictId, resolution } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "quorum_vote",
        timeoutMs: 10_000,
      });

      await service._triggerTimeout(conflictId);

      await expect(resolution).rejects.toThrow("expired without resolution");

      const conflict = service.getConflict(conflictId);
      expect(conflict!.status).toBe("expired");
    });

    it("timer fires automatically after timeoutMs", async () => {
      const { conflictId, resolution } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "structured_debate",
        timeoutMs: 30_000,
      });

      vi.advanceTimersByTime(30_001);

      await expect(resolution).rejects.toThrow("expired");
      expect(service.getConflict(conflictId)!.status).toBe("expired");
    });
  });

  // ── decision log ─────────────────────────────────────────────────────────────

  describe("decision log", () => {
    it("appends log entry on resolution", async () => {
      const { conflictId } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Should we cache?",
        strategy: "defer_to_owner",
      });

      const log = service.getDecisionLog();
      expect(log).toHaveLength(1);
      expect(log[0].question).toBe("Should we cache?");
      expect(log[0].strategy).toBe("defer_to_owner");
      expect(log[0].conflictId).toBe(conflictId);
    });

    it("filters decision log by session ID", async () => {
      await service.raiseConflict({
        sessionId: "session-A",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q1",
        strategy: "defer_to_owner",
      });

      await service.raiseConflict({
        sessionId: "session-B",
        raisedBy: "u2",
        raisedByInstance: "i2",
        question: "Q2",
        strategy: "defer_to_owner",
      });

      expect(service.getSessionDecisionLog("session-A")).toHaveLength(1);
      expect(service.getSessionDecisionLog("session-B")).toHaveLength(1);
      expect(service.getDecisionLog()).toHaveLength(2);
    });

    it("persists log entries to the sink", async () => {
      await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "To cache or not?",
        strategy: "defer_to_owner",
      });

      expect(sink._log).toHaveLength(1);
      expect(sink._log[0].question).toBe("To cache or not?");
    });

    it("records participant and proposal counts in log entry", async () => {
      const { conflictId, resolution } = await service.raiseConflict({
        sessionId: "s1",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q",
        strategy: "quorum_vote",
        quorumThreshold: 0.5,
      });

      await service.addProposal(conflictId, {
        authorId: "u1",
        instanceId: "i1",
        title: "P",
        description: "D",
      });

      const proposal = service.getConflict(conflictId)!.proposals[0];

      await service.castVote(conflictId, { participantId: "u1", instanceId: "i1", proposalId: proposal.id });
      await service.castVote(conflictId, { participantId: "u2", instanceId: "i2", proposalId: proposal.id });

      await resolution;

      const log = service.getDecisionLog();
      expect(log[0].proposalCount).toBe(1);
      expect(log[0].participantCount).toBeGreaterThanOrEqual(2);
    });
  });

  // ── getSessionConflicts ───────────────────────────────────────────────────────

  describe("getSessionConflicts", () => {
    it("returns all conflicts for a session", async () => {
      await service.raiseConflict({
        sessionId: "sess-X",
        raisedBy: "u1",
        raisedByInstance: "i1",
        question: "Q1",
        strategy: "quorum_vote",
      });

      await service.raiseConflict({
        sessionId: "sess-X",
        raisedBy: "u2",
        raisedByInstance: "i2",
        question: "Q2",
        strategy: "quorum_vote",
      });

      await service.raiseConflict({
        sessionId: "sess-Y",
        raisedBy: "u3",
        raisedByInstance: "i3",
        question: "Q3",
        strategy: "quorum_vote",
      });

      expect(service.getSessionConflicts("sess-X")).toHaveLength(2);
      expect(service.getSessionConflicts("sess-Y")).toHaveLength(1);
    });

    it("returns empty array for unknown session", () => {
      expect(service.getSessionConflicts("no-such-session")).toHaveLength(0);
    });
  });
});
