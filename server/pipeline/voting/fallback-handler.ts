// server/pipeline/voting/fallback-handler.ts
// Handles the "threshold not met" case in the Voting execution strategy.
//
// Three configurable strategies:
//  • escalate — call a stronger judge model to produce the final answer
//  • abort     — throw a VotingThresholdNotMetError
//  • partial   — emit the highest-agreement candidate as a partial result

import type { Gateway } from "../../gateway/index.js";
import type {
  VotingFallbackConfig,
  VotingFallbackOutcome,
  ProviderMessage,
} from "@shared/types";

// ─── Error type ───────────────────────────────────────────────────────────────

export class VotingThresholdNotMetError extends Error {
  constructor(
    public readonly threshold: number,
    public readonly bestAgreement: number,
  ) {
    super(
      `Voting threshold not met: required ${threshold.toFixed(3)}, best agreement was ${bestAgreement.toFixed(3)}`,
    );
    this.name = "VotingThresholdNotMetError";
  }
}

// ─── Fallback handler ─────────────────────────────────────────────────────────

export interface FallbackInput {
  /** The original user/system messages — passed to the judge if escalating. */
  basePrompt: ProviderMessage[];
  /** All candidate outputs from this voting run. */
  candidates: Array<{ modelSlug: string; content: string; score: number }>;
  /** Index of the candidate with the highest agreement score. */
  bestCandidateIndex: number;
  /** The threshold that was not met. */
  threshold: number;
  /** The best agreement score achieved. */
  bestAgreement: number;
  /** Max tokens for the escalation judge call. */
  maxTokens?: number;
}

export interface FallbackResult {
  content: string;
  outcome: VotingFallbackOutcome;
  escalationModelSlug?: string;
  tokensUsed: number;
}

/**
 * Execute the configured fallback when the voting threshold is not met.
 *
 * - `escalate`: calls a stronger judge model and returns its synthesis
 * - `abort`: throws `VotingThresholdNotMetError`
 * - `partial`: returns the highest-agreement candidate with outcome=`partial`
 */
export async function handleFallback(
  config: VotingFallbackConfig,
  input: FallbackInput,
  gateway: Gateway,
): Promise<FallbackResult> {
  switch (config.strategy) {
    case "escalate":
      return executeEscalation(config, input, gateway);

    case "abort":
      throw new VotingThresholdNotMetError(input.threshold, input.bestAgreement);

    case "partial":
      return executePartial(input);
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

async function executeEscalation(
  config: VotingFallbackConfig,
  input: FallbackInput,
  gateway: Gateway,
): Promise<FallbackResult> {
  const judgeModelSlug = config.escalationModelSlug ?? "claude-opus-4";

  const candidateSummary = input.candidates
    .map((c, i) => `Candidate ${i + 1} (${c.modelSlug}, agreement=${c.score.toFixed(3)}):\n${c.content}`)
    .join("\n\n---\n\n");

  const judgeMessages: ProviderMessage[] = [
    ...input.basePrompt,
    {
      role: "user",
      content:
        `The voting strategy could not reach consensus (threshold=${input.threshold.toFixed(3)}, ` +
        `best agreement=${input.bestAgreement.toFixed(3)}). ` +
        `Please review the following candidate responses and produce the single best answer:\n\n${candidateSummary}`,
    },
  ];

  const response = await gateway.complete({
    modelSlug: judgeModelSlug,
    messages: judgeMessages,
    maxTokens: input.maxTokens,
  });

  return {
    content: response.content,
    outcome: "escalated",
    escalationModelSlug: judgeModelSlug,
    tokensUsed: response.tokensUsed,
  };
}

function executePartial(input: FallbackInput): FallbackResult {
  const best = input.candidates[input.bestCandidateIndex];
  return {
    content: best?.content ?? "",
    outcome: "partial",
    tokensUsed: 0,
  };
}
