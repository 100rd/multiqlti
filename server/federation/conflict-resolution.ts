/**
 * Subjective Conflict Resolution Service (issue #229)
 *
 * Handles disputes in shared sessions where correctness is subjective and
 * cannot be determined by simple approve/reject arbitration.
 *
 * Supported resolution strategies:
 *   structured_debate    -- participants argue positions; optional LLM judge evaluates
 *   quorum_vote          -- N participants vote; configurable threshold decides winner
 *   parallel_experiment  -- both approaches run as pipeline branches; best result wins
 *   defer_to_owner       -- session owner's choice is final (used as fallback)
 *
 * All resolved conflicts are appended to the decision log for organisational learning.
 */
import crypto from "crypto";
import type { Gateway } from "../gateway/index.js";
import type {
  SessionConflict,
  ConflictProposal,
  ConflictVote,
  DebateJudgement,
  ExperimentBranchResult,
  ResolutionOutcome,
  SubjectiveResolutionStrategy,
  ConflictStatus,
  RaiseConflictInput,
  CastConflictVoteInput,
  DecisionLogEntry,
} from "@shared/types";

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_QUORUM_THRESHOLD = 0.67;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_PROPOSALS_PER_CONFLICT = 10;
const MAX_CONFLICTS_IN_MEMORY = 500;
const JUDGE_MODEL_SLUG = "default";

// ─── Pending resolution promise handle ─────────────────────────────────────────

interface PendingResolution {
  conflict: SessionConflict;
  createdAt: number;
  resolve: (outcome: ResolutionOutcome) => void;
  reject: (err: Error) => void;
}

// ─── Service ───────────────────────────────────────────────────────────────────

/**
 * ConflictResolutionService manages the full lifecycle of subjective disputes
 * in shared federation sessions.
 */
export class ConflictResolutionService {
  /** Active conflicts keyed by conflict ID. */
  private conflicts = new Map<string, SessionConflict>();

  /** Pending resolution promises keyed by conflict ID. */
  private pending = new Map<string, PendingResolution>();

  /** Timeout handles keyed by conflict ID. */
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  /** Decision log (in-memory; PgStorage persists to DB). */
  private log: DecisionLogEntry[] = [];

  /** Optional storage sink injected for persistence. */
  private storageSink?: ConflictStorageSink;

  constructor(
    private readonly gateway: Gateway | null,
    storageSink?: ConflictStorageSink,
  ) {
    this.storageSink = storageSink;
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Raise a new conflict in a shared session.
   * Returns the conflict ID and a promise that resolves with the outcome.
   */
  async raiseConflict(
    input: RaiseConflictInput,
  ): Promise<{ conflictId: string; resolution: Promise<ResolutionOutcome> }> {
    const conflictId = crypto.randomBytes(16).toString("hex");
    const now = Date.now();

    const conflict: SessionConflict = {
      id: conflictId,
      sessionId: input.sessionId,
      raisedBy: input.raisedBy,
      raisedByInstance: input.raisedByInstance,
      question: input.question,
      context: input.context,
      strategy: input.strategy,
      status: "open",
      proposals: [],
      votes: [],
      quorumThreshold: input.quorumThreshold ?? DEFAULT_QUORUM_THRESHOLD,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      createdAt: now,
      updatedAt: now,
    };

    this.enforceCapacityLimit();
    this.conflicts.set(conflictId, conflict);

    if (this.storageSink) {
      await this.storageSink.saveConflict(conflict);
    }

    const resolution = new Promise<ResolutionOutcome>((resolve, reject) => {
      this.pending.set(conflictId, {
        conflict,
        createdAt: now,
        resolve,
        reject,
      });
    });

    const handle = setTimeout(
      () => this.handleTimeout(conflictId),
      conflict.timeoutMs,
    );
    this.timeouts.set(conflictId, handle);

    // For defer_to_owner, resolve immediately with the raiser as owner
    if (input.strategy === "defer_to_owner") {
      await this.resolveWithOutcome(conflictId, {
        strategy: "defer_to_owner",
        reasoning: `Deferred to session owner (${input.raisedBy}) by design.`,
        decidedBy: "owner",
        decidedAt: now,
      });
    }

    return { conflictId, resolution };
  }

  /**
   * Add a proposal to an open conflict.
   * Returns the updated conflict.
   */
  async addProposal(
    conflictId: string,
    proposal: Omit<ConflictProposal, "id" | "submittedAt">,
  ): Promise<SessionConflict> {
    const conflict = this.requireOpenConflict(conflictId);

    if (conflict.proposals.length >= MAX_PROPOSALS_PER_CONFLICT) {
      throw new Error(
        `Conflict ${conflictId} already has the maximum of ${MAX_PROPOSALS_PER_CONFLICT} proposals.`,
      );
    }

    const newProposal: ConflictProposal = {
      ...proposal,
      id: crypto.randomBytes(8).toString("hex"),
      submittedAt: Date.now(),
    };

    conflict.proposals = [...conflict.proposals, newProposal];
    conflict.updatedAt = Date.now();

    if (conflict.strategy === "structured_debate") {
      conflict.status = "debate_in_progress";
    } else if (conflict.strategy === "quorum_vote") {
      conflict.status = "voting_in_progress";
    } else if (conflict.strategy === "parallel_experiment") {
      conflict.status = "experiment_in_progress";
      // Initialise branch result stubs for each proposal
      conflict.experimentResults = conflict.proposals.map((p) => ({
        proposalId: p.id,
        runId: "",
        status: "pending",
      }));
    }

    await this.persistConflict(conflict);
    return conflict;
  }

  /**
   * Cast a vote for a proposal in a quorum-vote conflict.
   * When the quorum threshold is reached, the conflict resolves automatically.
   */
  async castVote(
    conflictId: string,
    voteInput: CastConflictVoteInput,
  ): Promise<SessionConflict> {
    const conflict = this.requireConflictForVoting(conflictId);

    // Prevent duplicate votes from the same participant
    const alreadyVoted = conflict.votes.some(
      (v) => v.participantId === voteInput.participantId &&
             v.instanceId === voteInput.instanceId,
    );
    if (alreadyVoted) {
      throw new Error(
        `Participant ${voteInput.participantId} has already voted on conflict ${conflictId}.`,
      );
    }

    // Validate proposal exists
    const proposalExists = conflict.proposals.some((p) => p.id === voteInput.proposalId);
    if (!proposalExists) {
      throw new Error(`Proposal ${voteInput.proposalId} not found in conflict ${conflictId}.`);
    }

    const vote: ConflictVote = {
      participantId: voteInput.participantId,
      instanceId: voteInput.instanceId,
      proposalId: voteInput.proposalId,
      anonymous: voteInput.anonymous ?? false,
      submittedAt: Date.now(),
    };

    conflict.votes = [...conflict.votes, vote];
    conflict.updatedAt = Date.now();

    await this.persistConflict(conflict);

    // Check if quorum is met
    await this.checkQuorum(conflict);

    return conflict;
  }

  /**
   * Submit the LLM judge's verdict for a structured debate.
   * Triggers automatic resolution.
   */
  async submitDebateJudgement(
    conflictId: string,
    judgement: DebateJudgement,
  ): Promise<SessionConflict> {
    const conflict = this.requireConflictWithStrategy(conflictId, "structured_debate");

    conflict.judgement = judgement;
    conflict.updatedAt = Date.now();

    await this.persistConflict(conflict);

    // Resolve using judge's verdict
    const winnerProposal = judgement.winner
      ? conflict.proposals.find((p) => p.id === judgement.winner)
      : undefined;

    await this.resolveWithOutcome(conflictId, {
      strategy: "structured_debate",
      winningProposalId: winnerProposal?.id,
      reasoning: judgement.reasoning,
      decidedBy: "judge",
      decidedAt: Date.now(),
    });

    return this.conflicts.get(conflictId)!;
  }

  /**
   * Update an experiment branch result and check if all branches have completed.
   */
  async updateExperimentBranch(
    conflictId: string,
    result: ExperimentBranchResult,
  ): Promise<SessionConflict> {
    const conflict = this.requireConflictWithStrategy(conflictId, "parallel_experiment");

    const branches = conflict.experimentResults ?? [];
    const idx = branches.findIndex((b) => b.proposalId === result.proposalId);
    if (idx === -1) {
      throw new Error(`Branch for proposal ${result.proposalId} not found.`);
    }

    const updated = [...branches];
    updated[idx] = { ...updated[idx], ...result };
    conflict.experimentResults = updated;
    conflict.updatedAt = Date.now();

    await this.persistConflict(conflict);

    // If all branches are done, resolve with the completed one(s)
    const allDone = updated.every((b) => b.status !== "pending");
    if (allDone) {
      const winner = updated.find((b) => b.status === "completed") ?? updated[0];
      await this.resolveWithOutcome(conflictId, {
        strategy: "parallel_experiment",
        winningProposalId: winner?.proposalId,
        reasoning: "Parallel experiment completed; first successful branch adopted.",
        decidedBy: "owner",
        decidedAt: Date.now(),
      });
    }

    return this.conflicts.get(conflictId)!;
  }

  /**
   * Manually resolve a conflict (e.g., owner override).
   */
  async forceResolve(
    conflictId: string,
    winningProposalId: string | undefined,
    reasoning: string,
    decidedBy: ResolutionOutcome["decidedBy"] = "owner",
  ): Promise<SessionConflict> {
    const conflict = this.requireOpenConflict(conflictId);

    await this.resolveWithOutcome(conflictId, {
      strategy: conflict.strategy,
      winningProposalId,
      reasoning,
      decidedBy,
      decidedAt: Date.now(),
    });

    return this.conflicts.get(conflictId)!;
  }

  /**
   * Run the LLM judge on a structured debate, if a gateway is available.
   * This is a convenience method called explicitly (not automatically triggered).
   */
  async runDebateJudge(conflictId: string): Promise<DebateJudgement> {
    const conflict = this.requireConflictWithStrategy(conflictId, "structured_debate");

    if (!this.gateway) {
      throw new Error("No LLM gateway available for debate judgement.");
    }

    if (conflict.proposals.length < 2) {
      throw new Error("Structured debate requires at least 2 proposals before judging.");
    }

    const prompt = buildDebateJudgePrompt(conflict);

    let responseContent: string;
    try {
      const response = await this.gateway.complete({
        modelSlug: JUDGE_MODEL_SLUG,
        messages: [{ role: "user", content: prompt }],
      });
      responseContent = response.content;
    } catch (err) {
      throw new Error(`LLM judge call failed: ${(err as Error).message}`);
    }

    const judgement = parseJudgeResponse(responseContent, conflictId);
    await this.submitDebateJudgement(conflictId, judgement);

    return judgement;
  }

  // ── Query API ─────────────────────────────────────────────────────────────────

  /** Get a conflict by ID. */
  getConflict(conflictId: string): SessionConflict | null {
    return this.conflicts.get(conflictId) ?? null;
  }

  /** List all conflicts for a session. */
  getSessionConflicts(sessionId: string): SessionConflict[] {
    return Array.from(this.conflicts.values()).filter(
      (c) => c.sessionId === sessionId,
    );
  }

  /** Get all decision log entries (in-memory). */
  getDecisionLog(): DecisionLogEntry[] {
    return [...this.log];
  }

  /** Get decision log entries for a specific session. */
  getSessionDecisionLog(sessionId: string): DecisionLogEntry[] {
    return this.log.filter((e) => e.sessionId === sessionId);
  }

  // ── Internal resolution machinery ─────────────────────────────────────────────

  private async resolveWithOutcome(
    conflictId: string,
    outcome: ResolutionOutcome,
  ): Promise<void> {
    const conflict = this.conflicts.get(conflictId);
    if (!conflict) return;
    if (conflict.status === "resolved") return;

    conflict.outcome = outcome;
    conflict.status = "resolved";
    conflict.updatedAt = Date.now();

    this.clearTimeout(conflictId);
    await this.persistConflict(conflict);
    await this.appendDecisionLog(conflict, outcome);

    const pending = this.pending.get(conflictId);
    if (pending) {
      this.pending.delete(conflictId);
      pending.resolve(outcome);
    }
  }

  private async checkQuorum(conflict: SessionConflict): Promise<void> {
    if (conflict.proposals.length === 0) return;

    const totalVotes = conflict.votes.length;
    // Require at least 2 votes so a single participant cannot unilaterally form a quorum.
    if (totalVotes < 2) return;

    // Count votes per proposal
    const voteCounts = new Map<string, number>();
    for (const v of conflict.votes) {
      voteCounts.set(v.proposalId, (voteCounts.get(v.proposalId) ?? 0) + 1);
    }

    // Find proposal with the highest vote share
    let winnerProposalId: string | undefined;
    let maxShare = 0;

    for (const [proposalId, count] of voteCounts) {
      const share = count / totalVotes;
      if (share > maxShare) {
        maxShare = share;
        winnerProposalId = proposalId;
      }
    }

    if (winnerProposalId && maxShare >= conflict.quorumThreshold) {
      const winnerProposal = conflict.proposals.find((p) => p.id === winnerProposalId);
      await this.resolveWithOutcome(conflict.id, {
        strategy: "quorum_vote",
        winningProposalId: winnerProposalId,
        reasoning: `Quorum reached: proposal "${winnerProposal?.title ?? winnerProposalId}" received ${(maxShare * 100).toFixed(0)}% of votes (threshold: ${(conflict.quorumThreshold * 100).toFixed(0)}%).`,
        decidedBy: "quorum",
        decidedAt: Date.now(),
      });
    }
  }

  private async handleTimeout(conflictId: string): Promise<void> {
    const conflict = this.conflicts.get(conflictId);
    if (!conflict || conflict.status === "resolved") return;

    // On timeout: try to salvage with current votes (partial quorum) or escalate to owner
    if (
      conflict.strategy === "quorum_vote" &&
      conflict.votes.length > 0
    ) {
      // Resolve with the leading proposal even if threshold not reached
      const voteCounts = new Map<string, number>();
      for (const v of conflict.votes) {
        voteCounts.set(v.proposalId, (voteCounts.get(v.proposalId) ?? 0) + 1);
      }

      let bestId: string | undefined;
      let bestCount = 0;
      for (const [id, count] of voteCounts) {
        if (count > bestCount) {
          bestCount = count;
          bestId = id;
        }
      }

      await this.resolveWithOutcome(conflictId, {
        strategy: conflict.strategy,
        winningProposalId: bestId,
        reasoning: `Timeout reached with ${conflict.votes.length} votes cast. Plurality winner adopted.`,
        decidedBy: "timeout",
        decidedAt: Date.now(),
      });
      return;
    }

    conflict.status = "expired";
    conflict.updatedAt = Date.now();
    await this.persistConflict(conflict);

    // Append a no-decision log entry
    await this.appendDecisionLog(conflict, {
      strategy: conflict.strategy,
      reasoning: "Conflict expired without resolution.",
      decidedBy: "timeout",
      decidedAt: Date.now(),
    });

    const pending = this.pending.get(conflictId);
    if (pending) {
      this.pending.delete(conflictId);
      pending.reject(new Error(`Conflict ${conflictId} expired without resolution.`));
    }
  }

  private clearTimeout(conflictId: string): void {
    const handle = this.timeouts.get(conflictId);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.timeouts.delete(conflictId);
    }
  }

  private async persistConflict(conflict: SessionConflict): Promise<void> {
    this.conflicts.set(conflict.id, conflict);
    if (this.storageSink) {
      await this.storageSink.saveConflict(conflict);
    }
  }

  private async appendDecisionLog(
    conflict: SessionConflict,
    outcome: ResolutionOutcome,
  ): Promise<void> {
    const entry: DecisionLogEntry = {
      id: crypto.randomBytes(16).toString("hex"),
      sessionId: conflict.sessionId,
      conflictId: conflict.id,
      question: conflict.question,
      strategy: conflict.strategy,
      outcome,
      participantCount: new Set([
        ...conflict.votes.map((v) => v.participantId),
        ...conflict.proposals.map((p) => p.authorId),
      ]).size,
      proposalCount: conflict.proposals.length,
      durationMs: Date.now() - conflict.createdAt,
      recordedAt: Date.now(),
    };

    this.log.push(entry);

    if (this.storageSink) {
      await this.storageSink.appendDecisionLog(entry);
    }
  }

  private requireOpenConflict(conflictId: string): SessionConflict {
    const conflict = this.conflicts.get(conflictId);
    if (!conflict) throw new Error(`Conflict ${conflictId} not found.`);
    if (conflict.status === "resolved" || conflict.status === "expired") {
      throw new Error(`Conflict ${conflictId} is already ${conflict.status}.`);
    }
    return conflict;
  }

  private requireConflictForVoting(conflictId: string): SessionConflict {
    const conflict = this.requireOpenConflict(conflictId);
    if (conflict.strategy !== "quorum_vote") {
      throw new Error(
        `Conflict ${conflictId} uses strategy "${conflict.strategy}", not "quorum_vote".`,
      );
    }
    return conflict;
  }

  private requireConflictWithStrategy(
    conflictId: string,
    strategy: SubjectiveResolutionStrategy,
  ): SessionConflict {
    const conflict = this.requireOpenConflict(conflictId);
    if (conflict.strategy !== strategy) {
      throw new Error(
        `Conflict ${conflictId} uses strategy "${conflict.strategy}", expected "${strategy}".`,
      );
    }
    return conflict;
  }

  private enforceCapacityLimit(): void {
    if (this.conflicts.size >= MAX_CONFLICTS_IN_MEMORY) {
      // Remove the oldest resolved/expired conflict to make space
      for (const [id, c] of this.conflicts) {
        if (c.status === "resolved" || c.status === "expired") {
          this.conflicts.delete(id);
          return;
        }
      }
      // If no resolved conflicts, evict the oldest one
      const oldest = this.conflicts.keys().next().value;
      if (oldest !== undefined) {
        this.conflicts.delete(oldest);
        this.pending.delete(oldest);
        this.clearTimeout(oldest);
      }
    }
  }

  // ── Internal helpers exposed for testing ─────────────────────────────────────

  /** Visible for testing — trigger a timeout immediately. */
  _triggerTimeout(conflictId: string): Promise<void> {
    return this.handleTimeout(conflictId);
  }

  /** Visible for testing — return the pending map size. */
  _getPendingCount(): number {
    return this.pending.size;
  }
}

// ─── Storage sink interface ───────────────────────────────────────────────────

/**
 * Minimal persistence interface the service uses.
 * Implemented by IStorage in storage.ts; a no-op stub is used in tests.
 */
export interface ConflictStorageSink {
  saveConflict(conflict: SessionConflict): Promise<void>;
  appendDecisionLog(entry: DecisionLogEntry): Promise<void>;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function buildDebateJudgePrompt(conflict: SessionConflict): string {
  const proposalText = conflict.proposals
    .map(
      (p, i) =>
        `### Proposal ${i + 1} (ID: ${p.id})\n` +
        `Author: ${p.authorId}\n` +
        `Title: ${p.title}\n` +
        `Description: ${p.description}\n` +
        (p.arguments ? `Arguments: ${p.arguments}` : ""),
    )
    .join("\n\n---\n\n");

  return `You are an impartial judge evaluating proposals for a subjective architectural/design dispute.

Question:
${conflict.question}

${conflict.context ? `Context:\n${conflict.context}\n\n` : ""}Proposals:
${proposalText}

Evaluate each proposal and select the winner.
Respond with a valid JSON object only (no markdown, no prose outside JSON):
{
  "winner": "<proposal_id>",
  "reasoning": "<explanation of your decision>",
  "confidence": 0.85
}`;
}

function parseJudgeResponse(
  content: string,
  conflictId: string,
): DebateJudgement {
  const jsonStr = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  try {
    const parsed = JSON.parse(jsonStr) as {
      winner?: string;
      reasoning?: string;
      confidence?: number;
    };

    return {
      judgeModelSlug: JUDGE_MODEL_SLUG,
      winner: typeof parsed.winner === "string" ? parsed.winner : undefined,
      reasoning: typeof parsed.reasoning === "string"
        ? parsed.reasoning
        : "No reasoning provided.",
      confidence: typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5,
      evaluatedAt: Date.now(),
    };
  } catch {
    return {
      judgeModelSlug: JUDGE_MODEL_SLUG,
      reasoning: `Failed to parse judge response for conflict ${conflictId}.`,
      confidence: 0,
      evaluatedAt: Date.now(),
    };
  }
}
