import type { ApprovalVote, ConflictResolution, ConflictResolutionMethod } from "@shared/types";
import type { Gateway } from "../gateway/index.js";

const VOTE_TIMEOUT_MS = 60_000;
const ARBITRATION_MODEL_SLUG = "default";

interface PendingApproval {
  runId: string;
  stageIndex: number;
  expectedVoters: number;
  votes: ApprovalVote[];
  createdAt: number;
  resolve: (resolution: ConflictResolution) => void;
}

/**
 * Multi-user approval voting for shared sessions (issue #226).
 *
 * When a pipeline approval gate is reached in a shared session,
 * all session participants vote. Resolution follows:
 *   1. Unanimous  -- all agree -> proceed / reject
 *   2. Arbitration -- disagreement -> LLM evaluates arguments
 *   3. Escalation -- arbitration unclear -> flag for manual review
 */
export class ApprovalVotingService {
  private pending = new Map<string, PendingApproval>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly gateway: Gateway | null) {}

  /** Build the map key for a pending approval. */
  private makeKey(runId: string, stageIndex: number): string {
    return `${runId}::${stageIndex}`;
  }

  /**
   * Start collecting votes for a given approval gate.
   * Returns a promise that resolves with the final ConflictResolution.
   */
  requestVotes(
    runId: string,
    stageIndex: number,
    expectedVoters: number,
  ): Promise<ConflictResolution> {
    const key = this.makeKey(runId, stageIndex);

    return new Promise<ConflictResolution>((resolve) => {
      this.pending.set(key, {
        runId,
        stageIndex,
        expectedVoters: Math.max(expectedVoters, 1),
        votes: [],
        createdAt: Date.now(),
        resolve,
      });

      const timeout = setTimeout(() => {
        this.resolveWithCurrentVotes(key);
      }, VOTE_TIMEOUT_MS);

      this.timeouts.set(key, timeout);
    });
  }

  /** Submit a vote for a pending approval. */
  async castVote(vote: ApprovalVote): Promise<void> {
    // Find the pending approval for this vote
    for (const [key, approval] of this.pending) {
      if (approval.runId === vote.userId) continue; // skip mismatches
      // Match by checking all pending approvals
      const alreadyVoted = approval.votes.some(
        (v) => v.userId === vote.userId && v.instanceId === vote.instanceId,
      );
      if (alreadyVoted) continue;

      approval.votes.push(vote);

      if (approval.votes.length >= approval.expectedVoters) {
        this.clearTimeout(key);
        await this.resolveWithCurrentVotes(key);
        return;
      }
    }
  }

  /** Submit a vote for a specific run + stage. */
  async castVoteForStage(
    runId: string,
    stageIndex: number,
    vote: ApprovalVote,
  ): Promise<ConflictResolution | null> {
    const key = this.makeKey(runId, stageIndex);
    const approval = this.pending.get(key);
    if (!approval) return null;

    const alreadyVoted = approval.votes.some(
      (v) => v.userId === vote.userId && v.instanceId === vote.instanceId,
    );
    if (alreadyVoted) return null;

    approval.votes.push(vote);

    if (approval.votes.length >= approval.expectedVoters) {
      this.clearTimeout(key);
      return this.resolveWithCurrentVotes(key);
    }

    return null;
  }

  /** Get votes collected so far for a run + stage. */
  getVotes(runId: string, stageIndex: number): ApprovalVote[] {
    const key = this.makeKey(runId, stageIndex);
    return this.pending.get(key)?.votes ?? [];
  }

  /** Check if there is a pending approval for a run + stage. */
  hasPendingApproval(runId: string, stageIndex: number): boolean {
    return this.pending.has(this.makeKey(runId, stageIndex));
  }

  /** Resolve based on collected votes so far. */
  private async resolveWithCurrentVotes(key: string): Promise<ConflictResolution> {
    const approval = this.pending.get(key);
    if (!approval) {
      return { method: "unanimous", votes: [], verdict: "reject" };
    }

    this.pending.delete(key);
    this.clearTimeout(key);

    const { votes } = approval;
    if (votes.length === 0) {
      const resolution: ConflictResolution = {
        method: "escalation",
        votes: [],
        reasoning: "No votes received within timeout",
      };
      approval.resolve(resolution);
      return resolution;
    }

    const resolution = await this.determineResolution(votes);
    approval.resolve(resolution);
    return resolution;
  }

  /** Determine the resolution method and verdict. */
  private async determineResolution(
    votes: ApprovalVote[],
  ): Promise<ConflictResolution> {
    const approvals = votes.filter((v) => v.vote === "approve");
    const rejections = votes.filter((v) => v.vote === "reject");

    // Unanimous approval
    if (rejections.length === 0) {
      return { method: "unanimous", votes, verdict: "approve" };
    }

    // Unanimous rejection
    if (approvals.length === 0) {
      return { method: "unanimous", votes, verdict: "reject" };
    }

    // Disagreement -- try arbitration via LLM
    return this.arbitrate(votes);
  }

  /** Use LLM to arbitrate between conflicting votes. */
  private async arbitrate(
    votes: ApprovalVote[],
  ): Promise<ConflictResolution> {
    if (!this.gateway) {
      return this.escalate(votes, "No gateway available for arbitration");
    }

    const prompt = this.buildArbitrationPrompt(votes);

    try {
      const response = await this.gateway.complete({
        modelSlug: ARBITRATION_MODEL_SLUG,
        messages: [
          { role: "system", content: "You are an impartial arbiter for pipeline approval decisions. Analyze the arguments and render a verdict." },
          { role: "user", content: prompt },
        ],
        maxTokens: 512,
        temperature: 0.2,
      });

      const verdict = this.parseArbitrationVerdict(response.content);

      return {
        method: "arbitration",
        votes,
        verdict: verdict.decision,
        reasoning: verdict.reasoning,
      };
    } catch {
      return this.escalate(votes, "Arbitration LLM call failed");
    }
  }

  /** Build the prompt for LLM arbitration. */
  private buildArbitrationPrompt(votes: ApprovalVote[]): string {
    const lines = votes.map(
      (v) => `- ${v.userId} (${v.instanceId}) voted ${v.vote.toUpperCase()}${v.reason ? `: ${v.reason}` : ""}`,
    );

    return [
      "The following votes were cast on a pipeline approval gate:",
      "",
      ...lines,
      "",
      "Based on these arguments, should this stage be approved or rejected?",
      "Respond in exactly this format:",
      "VERDICT: APPROVE or REJECT",
      "REASONING: <one paragraph explanation>",
    ].join("\n");
  }

  /** Parse the LLM arbitration response into a structured verdict. */
  private parseArbitrationVerdict(
    content: string,
  ): { decision: "approve" | "reject"; reasoning: string } {
    const verdictMatch = content.match(/VERDICT:\s*(APPROVE|REJECT)/i);
    const reasoningMatch = content.match(/REASONING:\s*(.+)/is);

    const decision = verdictMatch?.[1]?.toUpperCase() === "APPROVE"
      ? "approve"
      : "reject";

    const reasoning = reasoningMatch?.[1]?.trim()
      ?? "Arbitration verdict rendered without explicit reasoning.";

    return { decision, reasoning };
  }

  /** Escalation -- flag for third-party review. */
  private escalate(
    votes: ApprovalVote[],
    reason: string,
  ): ConflictResolution {
    return {
      method: "escalation",
      votes,
      reasoning: `Escalated: ${reason}`,
    };
  }

  private clearTimeout(key: string): void {
    const handle = this.timeouts.get(key);
    if (handle) {
      clearTimeout(handle);
      this.timeouts.delete(key);
    }
  }

  /** Visible for testing -- returns the pending map. */
  _getPending(): Map<string, PendingApproval> {
    return this.pending;
  }
}
