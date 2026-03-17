import type { Gateway } from "../gateway/index";
import type { WsManager } from "../ws/manager";
import type {
  ExecutionStrategy,
  MoaStrategy,
  DebateStrategy,
  VotingStrategy,
  StrategyResult,
  MoaDetails,
  DebateDetails,
  VotingDetails,
  ArbitratorVerdict,
  ArbitratorCriterion,
  ProviderMessage,
} from "@shared/types";
import {
  computeProviderDiversityScore,
  preferCrossProviderOrder,
  type ParticipantWithProvider,
} from "./provider-diversity";

export interface StrategyContext {
  runId: string;
  stageId: string;
  maxTokens?: number;
}

export class StrategyExecutor {
  constructor(
    private gateway: Gateway,
    private wsManager: WsManager,
  ) {}

  async execute(
    strategy: ExecutionStrategy,
    basePrompt: ProviderMessage[],
    context: StrategyContext,
  ): Promise<StrategyResult> {
    const start = Date.now();

    this.wsManager.broadcastToRun(context.runId, {
      type: "strategy:started",
      runId: context.runId,
      payload: { stageId: context.stageId, strategy: strategy.type },
      timestamp: new Date().toISOString(),
    });

    let result: StrategyResult;

    switch (strategy.type) {
      case "single":
        result = await this.executeSingle(basePrompt, context, start);
        break;
      case "moa":
        result = await this.executeMoA(strategy, basePrompt, context, start);
        break;
      case "debate":
        result = await this.executeDebate(strategy, basePrompt, context, start);
        break;
      case "voting":
        result = await this.executeVoting(strategy, basePrompt, context, start);
        break;
    }

    this.wsManager.broadcastToRun(context.runId, {
      type: "strategy:completed",
      runId: context.runId,
      payload: { stageId: context.stageId, result },
      timestamp: new Date().toISOString(),
    });

    return result;
  }

  private async executeSingle(
    messages: ProviderMessage[],
    context: StrategyContext,
    start: number,
  ): Promise<StrategyResult> {
    const modelSlug = this.extractModelSlug(messages);
    const response = await this.gateway.complete({
      modelSlug,
      messages,
      maxTokens: context.maxTokens,
    });

    return {
      finalContent: response.content,
      strategy: "single",
      details: null,
      totalTokensUsed: response.tokensUsed,
      durationMs: Date.now() - start,
    };
  }

  private async executeMoA(
    strategy: MoaStrategy,
    basePrompt: ProviderMessage[],
    context: StrategyContext,
    start: number,
  ): Promise<StrategyResult> {
    validateMoaStrategy(strategy);

    // Run all proposers in parallel
    const proposerPromises = strategy.proposers.map((p, idx) =>
      this.runProposer(p, basePrompt, strategy.proposerPromptOverride, context, idx),
    );

    const proposerResults = await Promise.all(proposerPromises);
    let totalTokens = proposerResults.reduce((sum, r) => sum + r.tokensUsed, 0);

    // Build aggregation prompt
    const aggregationMessages = buildAggregationPrompt(basePrompt, proposerResults, strategy.aggregator.systemPrompt);

    const aggregatorResponse = await this.gateway.complete({
      modelSlug: strategy.aggregator.modelSlug,
      messages: aggregationMessages,
      maxTokens: context.maxTokens,
    });

    totalTokens += aggregatorResponse.tokensUsed;

    const details: MoaDetails = {
      proposerResponses: proposerResults.map((r, i) => ({
        modelSlug: strategy.proposers[i].modelSlug,
        content: r.content,
        role: strategy.proposers[i].role,
      })),
      aggregatorModelSlug: strategy.aggregator.modelSlug,
    };

    return {
      finalContent: aggregatorResponse.content,
      strategy: "moa",
      details,
      totalTokensUsed: totalTokens,
      durationMs: Date.now() - start,
    };
  }

  private async runProposer(
    proposer: MoaStrategy["proposers"][number],
    basePrompt: ProviderMessage[],
    promptOverride: string | undefined,
    context: StrategyContext,
    index: number,
  ): Promise<{ content: string; tokensUsed: number }> {
    const messages = promptOverride
      ? replaceSystemPrompt(basePrompt, promptOverride)
      : basePrompt;

    const response = await this.gateway.complete({
      modelSlug: proposer.modelSlug,
      messages,
      temperature: proposer.temperature,
      maxTokens: context.maxTokens,
    });

    this.wsManager.broadcastToRun(context.runId, {
      type: "strategy:proposer",
      runId: context.runId,
      payload: {
        stageId: context.stageId,
        modelSlug: proposer.modelSlug,
        role: proposer.role,
        content: response.content,
        index,
      },
      timestamp: new Date().toISOString(),
    });

    return { content: response.content, tokensUsed: response.tokensUsed };
  }

  private async executeDebate(
    strategy: DebateStrategy,
    basePrompt: ProviderMessage[],
    context: StrategyContext,
    start: number,
  ): Promise<StrategyResult> {
    validateDebateStrategy(strategy);

    // ── 6.13.1: Resolve providers and reorder for cross-provider diversity ───
    const participantsWithProvider: ParticipantWithProvider[] = await Promise.all(
      strategy.participants.map(async (p) => ({
        participant: p,
        provider: await this.gateway.resolveProvider(p.modelSlug),
      })),
    );

    const orderedParticipants = preferCrossProviderOrder(participantsWithProvider);
    const providerDiversityScore = computeProviderDiversityScore(participantsWithProvider);

    // Build a lookup map: modelSlug → provider
    const providerMap = new Map<string, string>(
      participantsWithProvider.map((p) => [p.participant.modelSlug, p.provider]),
    );

    // ── Run debate rounds ────────────────────────────────────────────────────
    const debateRounds: DebateDetails["rounds"] = [];
    let totalTokens = 0;
    const conversationHistory: ProviderMessage[] = [...basePrompt];

    for (let round = 1; round <= strategy.rounds; round++) {
      for (const { participant } of orderedParticipants) {
        const rolePrompt = buildDebateRolePrompt(participant.role, participant.persona, round, strategy.rounds);
        const messages: ProviderMessage[] = [
          ...conversationHistory,
          { role: "user", content: rolePrompt },
        ];

        const response = await this.gateway.complete({
          modelSlug: participant.modelSlug,
          messages,
          maxTokens: context.maxTokens,
        });

        totalTokens += response.tokensUsed;

        const entry: DebateDetails["rounds"][number] = {
          round,
          participant: participant.modelSlug,
          role: participant.role,
          content: response.content,
          provider: providerMap.get(participant.modelSlug),
        };
        debateRounds.push(entry);

        // Add to conversation so next participant sees this
        conversationHistory.push({ role: "assistant", content: response.content });

        this.wsManager.broadcastToRun(context.runId, {
          type: "strategy:debate:round",
          runId: context.runId,
          payload: { stageId: context.stageId, ...entry },
          timestamp: new Date().toISOString(),
        });
      }

      if (strategy.stopEarly && round < strategy.rounds) {
        const shouldStop = checkConsensus(debateRounds, round);
        if (shouldStop) break;
      }
    }

    // ── Judge delivers verdict ───────────────────────────────────────────────
    const judgePrompt = buildJudgePrompt(debateRounds, strategy.judge.criteria);
    const judgeMessages: ProviderMessage[] = [
      ...basePrompt,
      { role: "user", content: judgePrompt },
    ];

    const judgeResponse = await this.gateway.complete({
      modelSlug: strategy.judge.modelSlug,
      messages: judgeMessages,
      maxTokens: context.maxTokens,
    });

    totalTokens += judgeResponse.tokensUsed;

    this.wsManager.broadcastToRun(context.runId, {
      type: "strategy:debate:judge",
      runId: context.runId,
      payload: { stageId: context.stageId, verdict: judgeResponse.content },
      timestamp: new Date().toISOString(),
    });

    // ── 6.13.2: Arbitrator (optional) ───────────────────────────────────────
    let arbitratorVerdict: ArbitratorVerdict | undefined;

    if (strategy.arbitrator) {
      validateArbitratorConfig(
        strategy.arbitrator.modelSlug,
        strategy.judge.modelSlug,
        strategy.participants.map((p) => p.modelSlug),
      );

      const participantSlugs = strategy.participants.map((p) => p.modelSlug);
      const criteria = strategy.arbitrator.criteria ?? ["correctness", "completeness", "security", "performance"];
      const arbitratorPrompt = buildArbitratorPrompt(debateRounds, participantSlugs, criteria);

      const arbitratorMessages: ProviderMessage[] = [
        ...basePrompt,
        { role: "user", content: arbitratorPrompt },
      ];

      const arbitratorResponse = await this.gateway.complete({
        modelSlug: strategy.arbitrator.modelSlug,
        messages: arbitratorMessages,
        maxTokens: context.maxTokens,
      });

      totalTokens += arbitratorResponse.tokensUsed;

      arbitratorVerdict = parseArbitratorVerdict(
        arbitratorResponse.content,
        strategy.arbitrator.modelSlug,
        participantSlugs,
      );

      this.wsManager.broadcastToRun(context.runId, {
        type: "strategy:debate:arbitrator",
        runId: context.runId,
        payload: { stageId: context.stageId, verdict: arbitratorVerdict },
        timestamp: new Date().toISOString(),
      });
    }

    // ── Assemble result ──────────────────────────────────────────────────────
    const details: DebateDetails = {
      rounds: debateRounds,
      judgeModelSlug: strategy.judge.modelSlug,
      verdict: judgeResponse.content,
      providerDiversityScore,
      ...(arbitratorVerdict !== undefined && { arbitratorVerdict }),
    };

    return {
      finalContent: judgeResponse.content,
      strategy: "debate",
      details,
      totalTokensUsed: totalTokens,
      durationMs: Date.now() - start,
    };
  }

  private async executeVoting(
    strategy: VotingStrategy,
    basePrompt: ProviderMessage[],
    context: StrategyContext,
    start: number,
  ): Promise<StrategyResult> {
    validateVotingStrategy(strategy);

    // Run all candidates in parallel
    const candidatePromises = strategy.candidates.map((c) =>
      this.gateway.complete({
        modelSlug: c.modelSlug,
        messages: basePrompt,
        temperature: c.temperature,
        maxTokens: context.maxTokens,
      }),
    );

    const candidateResults = await Promise.all(candidatePromises);
    const totalTokens = candidateResults.reduce((sum, r) => sum + r.tokensUsed, 0);

    const contents = candidateResults.map((r) => r.content);
    const scores = computeSimilarityScores(contents);

    const passedIndices = scores
      .map((score, idx) => ({ score, idx }))
      .filter(({ score }) => score >= strategy.threshold)
      .map(({ idx }) => idx);

    // Winner: first passing candidate; fallback to highest-scored
    const winnerIndex = passedIndices.length > 0
      ? passedIndices[0]
      : scores.indexOf(Math.max(...scores));

    const agreement = scores[winnerIndex] ?? 0;

    const candidateDetails = candidateResults.map((r, i) => ({
      modelSlug: strategy.candidates[i].modelSlug,
      content: r.content,
      passed: passedIndices.includes(i),
    }));

    candidateDetails.forEach((c, idx) => {
      this.wsManager.broadcastToRun(context.runId, {
        type: "strategy:voting:candidate",
        runId: context.runId,
        payload: { stageId: context.stageId, modelSlug: c.modelSlug, index: idx, passed: c.passed },
        timestamp: new Date().toISOString(),
      });
    });

    const details: VotingDetails = {
      candidates: candidateDetails,
      winnerIndex,
      agreement,
    };

    return {
      finalContent: candidateResults[winnerIndex].content,
      strategy: "voting",
      details,
      totalTokensUsed: totalTokens,
      durationMs: Date.now() - start,
    };
  }

  /** Pull the modelSlug from the first message if stored in context, else fall back. */
  private extractModelSlug(messages: ProviderMessage[]): string {
    // The gateway will resolve the slug; we pass a placeholder — caller sets modelSlug via context
    return (messages as Array<ProviderMessage & { _modelSlug?: string }>)[0]?._modelSlug ?? "llama3-70b";
  }
}

// ─── Pure helper functions ────────────────────────────────────────────────────

function validateMoaStrategy(s: MoaStrategy): void {
  if (s.proposers.length < 1) throw new Error("MoA requires at least 1 proposer");
  if (s.proposers.length > 5) throw new Error("MoA supports at most 5 proposers");
}

function validateDebateStrategy(s: DebateStrategy): void {
  if (s.participants.length < 2) throw new Error("Debate requires at least 2 participants");
  if (s.rounds < 1 || s.rounds > 5) throw new Error("Debate rounds must be between 1 and 5");
}

function validateVotingStrategy(s: VotingStrategy): void {
  if (s.candidates.length < 2) throw new Error("Voting requires at least 2 candidates");
  if (s.candidates.length > 7) throw new Error("Voting supports at most 7 candidates");
  if (s.threshold < 0.5 || s.threshold > 1.0) throw new Error("Threshold must be between 0.5 and 1.0");
}

/**
 * Enforce the arbitrator model exclusion rule at runtime.
 * Throws if the arbitrator model equals the judge or any participant.
 */
export function validateArbitratorConfig(
  arbitratorSlug: string,
  judgeSlug: string,
  participantSlugs: string[],
): void {
  if (arbitratorSlug === judgeSlug) {
    throw new Error(
      `Arbitrator model "${arbitratorSlug}" must differ from the judge model "${judgeSlug}"`,
    );
  }
  for (const slug of participantSlugs) {
    if (arbitratorSlug === slug) {
      throw new Error(
        `Arbitrator model "${arbitratorSlug}" must differ from all debate participants (found duplicate: "${slug}")`,
      );
    }
  }
}

function replaceSystemPrompt(messages: ProviderMessage[], newSystem: string): ProviderMessage[] {
  const hasSystem = messages[0]?.role === "system";
  if (hasSystem) {
    return [{ role: "system", content: newSystem }, ...messages.slice(1)];
  }
  return [{ role: "system", content: newSystem }, ...messages];
}

function buildAggregationPrompt(
  original: ProviderMessage[],
  proposerResults: Array<{ content: string }>,
  aggregatorSystemPrompt?: string,
): ProviderMessage[] {
  const systemPrompt = aggregatorSystemPrompt ??
    "You are a synthesis expert. Review the following candidate responses and produce the single best response that combines their insights.";

  const proposerText = proposerResults
    .map((r, i) => `### Candidate ${i + 1}\n${r.content}`)
    .join("\n\n");

  const lastUserMessage = [...original].reverse().find((m) => m.role === "user");
  const task = lastUserMessage?.content ?? "Complete the task.";

  return [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Original task:\n${task}\n\nCandidate responses:\n\n${proposerText}\n\nSynthesize the best response:`,
    },
  ];
}

function buildDebateRolePrompt(
  role: string,
  persona: string | undefined,
  round: number,
  totalRounds: number,
): string {
  const personaNote = persona ? ` You embody the persona: "${persona}".` : "";
  const roundNote = `This is round ${round} of ${totalRounds}.`;

  switch (role) {
    case "proposer":
      return `${roundNote} You are the proposer.${personaNote} Present or refine your solution clearly.`;
    case "critic":
      return `${roundNote} You are the critic.${personaNote} Identify flaws, risks, or missing considerations in the current proposal.`;
    case "devil_advocate":
      return `${roundNote} You are the devil's advocate.${personaNote} Challenge assumptions and propose radical alternatives.`;
    default:
      return `${roundNote} Contribute your perspective.${personaNote}`;
  }
}

function buildJudgePrompt(
  rounds: DebateDetails["rounds"],
  criteria?: string[],
): string {
  const criteriaNote = criteria?.length
    ? `Evaluate based on: ${criteria.join(", ")}.`
    : "Evaluate based on correctness, completeness, and practicality.";

  const transcript = rounds
    .map((r) => `[Round ${r.round}] [${r.role}] (${r.participant}):\n${r.content}`)
    .join("\n\n---\n\n");

  return `You are the judge. ${criteriaNote}\n\nDebate transcript:\n\n${transcript}\n\nDeliver the final verdict and best solution:`;
}

/**
 * Build the structured arbitration prompt asking for JSON output.
 */
export function buildArbitratorPrompt(
  rounds: DebateDetails["rounds"],
  participantSlugs: string[],
  criteria: ArbitratorCriterion[],
): string {
  const participantList = participantSlugs.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
  const criteriaList = criteria.map((c) => `- ${c} (1–10): ${CRITERION_DESCRIPTIONS[c]}`).join("\n");

  const transcript = rounds
    .map((r) => `[Round ${r.round}] [${r.role}] (${r.participant}):\n${r.content}`)
    .join("\n\n---\n\n");

  const exampleScores = Object.fromEntries(participantSlugs.map((s) => [s, 7]));

  return `You are an impartial arbitrator. Your task is to evaluate each debate participant against structured criteria and determine the overall winner.

Participants:
${participantList}

Scoring criteria (each scored 1–10 per participant):
${criteriaList}

Debate transcript:
${transcript}

Respond ONLY with valid JSON matching this schema (no markdown, no explanation outside JSON):
{
  "criterionScores": [
    {
      "criterion": "<criterion name>",
      "scores": ${JSON.stringify(exampleScores)},
      "reasoning": "<one sentence explaining the scores for this criterion>"
    }
  ],
  "winner": "<modelSlug of the best overall participant>",
  "confidence": 0.85,
  "reasoning": "<overall reasoning for your decision>"
}`;
}

const CRITERION_DESCRIPTIONS: Record<ArbitratorCriterion, string> = {
  correctness: "factual accuracy and logical soundness",
  completeness: "coverage of all required aspects",
  security: "identification and handling of security concerns",
  performance: "consideration of performance implications",
};

/**
 * Parse the arbitrator's JSON response into an ArbitratorVerdict.
 * Validates structure; on parse failure returns a fallback with confidence=0.
 */
export function parseArbitratorVerdict(
  rawContent: string,
  arbitratorModelSlug: string,
  participantSlugs: string[],
): ArbitratorVerdict {
  // Strip markdown code fences if present
  const jsonStr = rawContent
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return buildFallbackVerdict(arbitratorModelSlug, participantSlugs, "Failed to parse JSON response");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).criterionScores) ||
    typeof (parsed as Record<string, unknown>).winner !== "string" ||
    typeof (parsed as Record<string, unknown>).confidence !== "number" ||
    typeof (parsed as Record<string, unknown>).reasoning !== "string"
  ) {
    return buildFallbackVerdict(arbitratorModelSlug, participantSlugs, "Invalid JSON structure");
  }

  const p = parsed as {
    criterionScores: Array<{
      criterion: string;
      scores: Record<string, number>;
      reasoning: string;
    }>;
    winner: string;
    confidence: number;
    reasoning: string;
  };

  return {
    arbitratorModelSlug,
    criterionScores: p.criterionScores.map((cs) => ({
      criterion: cs.criterion as ArbitratorCriterion,
      scores: cs.scores,
      reasoning: cs.reasoning,
    })),
    winner: p.winner,
    confidence: Math.max(0, Math.min(1, p.confidence)),
    reasoning: p.reasoning,
    participantSlugs,
  };
}

function buildFallbackVerdict(
  arbitratorModelSlug: string,
  participantSlugs: string[],
  reason: string,
): ArbitratorVerdict {
  return {
    arbitratorModelSlug,
    criterionScores: [],
    winner: participantSlugs[0] ?? "unknown",
    confidence: 0,
    reasoning: `Arbitration failed: ${reason}`,
    participantSlugs,
  };
}

function checkConsensus(rounds: DebateDetails["rounds"], currentRound: number): boolean {
  const thisRound = rounds.filter((r) => r.round === currentRound);
  if (thisRound.length < 2) return false;
  const proposerContent = thisRound.find((r) => r.role === "proposer")?.content ?? "";
  const criticContent = thisRound.find((r) => r.role === "critic")?.content ?? "";
  // Rough heuristic: if critic's response is very short, they found little to critique
  return criticContent.length < proposerContent.length * 0.15;
}

/**
 * Compute pairwise text similarity scores using word overlap (Jaccard).
 * Returns a score per candidate: average similarity with all other candidates.
 */
function computeSimilarityScores(contents: string[]): number[] {
  const tokenSets = contents.map(tokenize);

  return tokenSets.map((tokens, i) => {
    if (tokenSets.length === 1) return 1;
    let totalSim = 0;
    let count = 0;
    for (let j = 0; j < tokenSets.length; j++) {
      if (i === j) continue;
      totalSim += jaccardSimilarity(tokens, tokenSets[j]);
      count++;
    }
    return count > 0 ? totalSim / count : 0;
  });
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}
