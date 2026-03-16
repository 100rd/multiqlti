import type { IStorage } from "../storage";
import type { TeamRegistry } from "../teams/registry";
import type { WsManager } from "../ws/manager";
import type { Gateway } from "../gateway/index";
import type {
  ManagerConfig,
  ManagerDecision,
  ManagerLLMResponse,
  TeamId,
} from "@shared/types";
import { SDLC_TEAMS } from "@shared/constants";
import type { InsertManagerIteration } from "@shared/schema";
import { DelegationService } from "./delegation-service";

// ─── Constants ────────────────────────────────────────────────────────────────

const SYSTEM_MAX_ITERATIONS = 20;

// ─── Errors ───────────────────────────────────────────────────────────────────

export class ManagerMaxIterationsError extends Error {
  constructor(iterations: number) {
    super(`Manager reached maximum iterations (${iterations}) without completing`);
    this.name = "ManagerMaxIterationsError";
  }
}

export class ManagerInvalidTeamError extends Error {
  constructor(teamId: string, allowlist: string[]) {
    super(
      `Manager attempted to dispatch team "${teamId}" which is not in allowlist: [${allowlist.join(", ")}]`,
    );
    this.name = "ManagerInvalidTeamError";
  }
}

export class ManagerInvalidResponseError extends Error {
  constructor(reason: string) {
    super(`Manager LLM returned invalid response: ${reason}`);
    this.name = "ManagerInvalidResponseError";
  }
}

// ─── ManagerAgent Service ─────────────────────────────────────────────────────

export class ManagerAgent {
  constructor(
    private storage: IStorage,
    private teamRegistry: TeamRegistry,
    private wsManager: WsManager,
    private gateway: Gateway,
    private delegationService: DelegationService,
  ) {}

  /**
   * Main orchestration loop. Runs until the manager decides "complete" or "fail",
   * or maxIterations is reached.
   */
  async run(
    runId: string,
    pipelineInput: string,
    config: ManagerConfig,
    signal: AbortSignal,
  ): Promise<{ status: "completed" | "failed"; iterations: number; totalTokens: number }> {
    const maxIterations = Math.min(config.maxIterations, SYSTEM_MAX_ITERATIONS);
    const iterationHistory: Array<{ decision: ManagerDecision; teamResult?: string }> = [];
    let totalTokensUsed = 0;
    const startTime = Date.now();

    const RUN_TIMEOUT_MS = 30 * 60_000; // 30 minutes hard cap per run

    for (let i = 1; i <= maxIterations; i++) {
      if (signal.aborted) {
        throw new Error("Manager run cancelled");
      }

      // H2: Overall run timeout check
      if (Date.now() - startTime > RUN_TIMEOUT_MS) {
        const msg = `Manager run exceeded maximum duration of 30 minutes`;
        this.broadcastComplete(runId, i - 1, msg, "failed", totalTokensUsed, Date.now() - startTime);
        throw new ManagerMaxIterationsError(i - 1);
      }

      const decisionStart = Date.now();

      // 1. Build context for manager LLM
      const context = this.buildContext(
        config.goal,
        pipelineInput,
        iterationHistory,
        config.availableTeams,
        i,
      );

      // 2. Call manager LLM
      let llmResponse: ManagerLLMResponse;
      let tokensUsed: number;
      try {
        const result = await this.callManagerLLM(config.managerModel, context, signal);
        llmResponse = result.response;
        tokensUsed = result.tokensUsed;
        totalTokensUsed += tokensUsed;
      } catch (err) {
        this.broadcastError(runId, i, err as Error);
        throw err;
      }

      const decisionDurationMs = Date.now() - decisionStart;

      // 3. Validate LLM response — SECURITY: teamId allowlist enforced here
      const decision = this.parseAndValidateDecision(llmResponse, i, config.availableTeams);

      // 4. Store iteration (before team execution)
      await this.storeIteration(runId, i, decision, tokensUsed, decisionDurationMs);

      // 5. Broadcast decision event
      this.broadcastDecision(runId, decision, tokensUsed);

      // 6. Handle action
      if (decision.action === "dispatch") {
        const teamStart = Date.now();
        let teamResultText: string;
        try {
          const delegationResult = await this.delegationService.delegate(
            runId,
            {
              fromStage: "_manager_" as TeamId,
              toStage: decision.teamId!,
              task: decision.task!,
              context: { pipelineInput, iterationNumber: i },
              priority: "blocking",
              timeout: 300_000, // 5 minutes per team
            },
            [], // callChain starts fresh from manager
          );
          teamResultText = delegationResult.raw ?? "";
        } catch (err) {
          this.broadcastError(runId, i, err as Error);
          throw err;
        }
        const teamDurationMs = Date.now() - teamStart;

        // Update iteration with team result
        await this.updateIterationResult(runId, i, teamResultText, teamDurationMs);

        iterationHistory.push({ decision, teamResult: teamResultText });
      } else if (decision.action === "complete") {
        this.broadcastComplete(
          runId,
          i,
          decision.outcome ?? "Goal achieved",
          "completed",
          totalTokensUsed,
          Date.now() - startTime,
        );
        return { status: "completed", iterations: i, totalTokens: totalTokensUsed };
      } else if (decision.action === "fail") {
        this.broadcastComplete(
          runId,
          i,
          decision.outcome ?? "Goal could not be achieved",
          "failed",
          totalTokensUsed,
          Date.now() - startTime,
        );
        return { status: "failed", iterations: i, totalTokens: totalTokensUsed };
      }
    }

    // Max iterations reached without completion
    this.broadcastComplete(
      runId,
      maxIterations,
      "Maximum iterations reached",
      "failed",
      totalTokensUsed,
      Date.now() - startTime,
    );
    throw new ManagerMaxIterationsError(maxIterations);
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  private buildContext(
    goal: string,
    pipelineInput: string,
    iterations: Array<{ decision: ManagerDecision; teamResult?: string }>,
    availableTeams: TeamId[],
    currentIteration: number,
  ): string {
    const teamList = availableTeams
      .map((id) => {
        const knownTeam = SDLC_TEAMS[id as keyof typeof SDLC_TEAMS];
        const description = knownTeam?.description ?? "custom team";
        return `- ${id}: ${description}`;
      })
      .join("\n");

    const history = iterations
      .map((it, idx) => {
        let entry = `## Iteration ${idx + 1}\n`;
        entry += `**Action**: ${it.decision.action}`;
        if (it.decision.teamId) entry += ` → ${it.decision.teamId}`;
        entry += `\n**Reasoning**: ${it.decision.reasoning}\n`;
        if (it.teamResult) {
          const truncated =
            it.teamResult.length > 2000
              ? `${it.teamResult.slice(0, 2000)}\n...[truncated]`
              : it.teamResult;
          entry += `**Team Output**:\n\`\`\`\n${truncated}\n\`\`\`\n`;
        }
        return entry;
      })
      .join("\n");

    return `# Manager Orchestration Context

## Goal
${goal}

## Pipeline Input
${pipelineInput}

## Available Teams
${teamList}

## Iteration History
${history || "(no iterations yet)"}

## Current Iteration
You are now deciding iteration ${currentIteration}. Analyze the goal, input, and any previous team outputs, then decide your next action.
`;
  }

  private async callManagerLLM(
    modelSlug: string,
    context: string,
    signal: AbortSignal,
  ): Promise<{ response: ManagerLLMResponse; tokensUsed: number }> {
    if (signal.aborted) throw new Error("Manager run cancelled");

    const systemPrompt = `You are a Manager Agent orchestrating a multi-team pipeline. Your job is to achieve the stated goal by dispatching teams as needed.

## Your Capabilities
- Dispatch ONE team per iteration to perform specific work
- Declare "complete" when the goal is achieved
- Declare "fail" if the goal cannot be achieved

## Rules
1. Only dispatch teams from the available list
2. Provide clear, specific tasks when dispatching
3. Review team outputs before deciding next steps
4. Be efficient — don't dispatch teams unnecessarily
5. Always explain your reasoning

## Response Format
You MUST respond with valid JSON matching this schema:
{
  "action": "dispatch" | "complete" | "fail",
  "teamId": "<team_id>",           // required if action === "dispatch"
  "task": "<task description>",    // required if action === "dispatch"
  "reasoning": "<your reasoning>", // always required
  "outcome": "<final outcome>"     // required if action === "complete" or "fail"
}

Respond ONLY with the JSON object. No markdown, no explanation outside the JSON.`;

    const result = await this.gateway.complete(
      {
        modelSlug,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: context },
        ],
        temperature: 0.3,
        maxTokens: 1000,
        timeoutMs: 60_000, // H1: 60-second manager LLM timeout
      },
      undefined,
      { teamId: "_manager_" },
    );

    let parsed: ManagerLLMResponse;
    try {
      let content = result.content.trim();
      // Strip markdown code fences if the model added them
      if (content.startsWith("```")) {
        content = content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
      }
      parsed = JSON.parse(content) as ManagerLLMResponse;
    } catch {
      throw new ManagerInvalidResponseError(
        `Could not parse JSON: ${result.content.slice(0, 200)}`,
      );
    }

    return { response: parsed, tokensUsed: result.tokensUsed ?? 0 };
  }

  private parseAndValidateDecision(
    response: ManagerLLMResponse,
    iterationNumber: number,
    allowedTeams: TeamId[],
  ): ManagerDecision {
    if (!["dispatch", "complete", "fail"].includes(response.action)) {
      throw new ManagerInvalidResponseError(`Invalid action: ${String(response.action)}`);
    }

    if (!response.reasoning || typeof response.reasoning !== "string") {
      throw new ManagerInvalidResponseError("Missing or invalid reasoning field");
    }

    if (response.action === "dispatch") {
      if (!response.teamId) {
        throw new ManagerInvalidResponseError("dispatch action requires teamId");
      }
      if (!response.task) {
        throw new ManagerInvalidResponseError("dispatch action requires task");
      }
      // SECURITY: Validate teamId against allowlist — never trust raw LLM output
      if (!allowedTeams.includes(response.teamId as TeamId)) {
        throw new ManagerInvalidTeamError(response.teamId, allowedTeams);
      }
    }

    if (
      (response.action === "complete" || response.action === "fail") &&
      !response.outcome
    ) {
      throw new ManagerInvalidResponseError(`${response.action} action requires outcome`);
    }

    return {
      action: response.action,
      teamId: response.teamId as TeamId | undefined,
      task: response.task,
      reasoning: response.reasoning,
      iterationNumber,
      outcome: response.outcome,
    };
  }

  private async storeIteration(
    runId: string,
    iterationNumber: number,
    decision: ManagerDecision,
    tokensUsed: number,
    decisionDurationMs: number,
  ): Promise<void> {
    const data: InsertManagerIteration = {
      runId,
      iterationNumber,
      decision: decision as InsertManagerIteration["decision"],
      tokensUsed,
      decisionDurationMs,
    };
    await this.storage.createManagerIteration(data);
  }

  // Maximum teamResult size to prevent storage DoS (C2 security fix)
  private static readonly MAX_TEAM_RESULT_BYTES = 100_000;

  private async updateIterationResult(
    runId: string,
    iterationNumber: number,
    teamResult: string,
    teamDurationMs: number,
  ): Promise<void> {
    let safeResult = teamResult;
    if (teamResult.length > ManagerAgent.MAX_TEAM_RESULT_BYTES) {
      safeResult =
        teamResult.slice(0, ManagerAgent.MAX_TEAM_RESULT_BYTES) +
        `

... [TRUNCATED: original size ${teamResult.length} chars, max ${ManagerAgent.MAX_TEAM_RESULT_BYTES}]`;
      console.warn(
        `[ManagerAgent] teamResult for run ${runId} iteration ${iterationNumber} truncated (${teamResult.length} -> ${ManagerAgent.MAX_TEAM_RESULT_BYTES} chars)`,
      );
    }
    await this.storage.updateManagerIteration(runId, iterationNumber, {
      teamResult: safeResult,
      teamDurationMs,
    });
  }

  private broadcastDecision(
    runId: string,
    decision: ManagerDecision,
    tokensUsed: number,
  ): void {
    this.wsManager.broadcastToRun(runId, {
      type: "manager:decision",
      runId,
      payload: {
        iterationNumber: decision.iterationNumber,
        action: decision.action,
        teamId: decision.teamId,
        task: decision.task,
        reasoning: decision.reasoning,
        tokensUsed,
      },
      timestamp: new Date().toISOString(),
    });
  }

  private broadcastComplete(
    runId: string,
    totalIterations: number,
    outcome: string,
    status: "completed" | "failed",
    totalTokensUsed: number,
    totalDurationMs: number,
  ): void {
    this.wsManager.broadcastToRun(runId, {
      type: "manager:complete",
      runId,
      payload: {
        totalIterations,
        outcome,
        status,
        totalTokensUsed,
        totalDurationMs,
      },
      timestamp: new Date().toISOString(),
    });
  }

  private broadcastError(runId: string, iteration: number, err: Error): void {
    this.wsManager.broadcastToRun(runId, {
      type: "manager:error",
      runId,
      payload: {
        iteration,
        error: err.message,
        recoverable: false,
      },
      timestamp: new Date().toISOString(),
    });
  }
}
