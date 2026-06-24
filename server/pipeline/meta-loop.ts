import type { OpenSpec, SpecRequirement, EvaluatorVerdict } from "@shared/types";
import { EvaluatorWorker } from "./evaluator-worker";
import { RalphLoopManager } from "./ralph-loop";
import { PlanEvaluatorGate } from "./plan-evaluator-gate";

export interface MetaLoopConfig {
  maxRetriesPerRequirement: number;
  maxTotalTokens: number;
  baseRepoPath: string;
}

export class MetaLoopService {
  private evaluator: EvaluatorWorker;
  private planEvaluator: PlanEvaluatorGate;
  private loopManager: RalphLoopManager;
  private config: MetaLoopConfig;

  constructor(config: MetaLoopConfig) {
    this.config = config;
    this.evaluator = new EvaluatorWorker();
    this.planEvaluator = new PlanEvaluatorGate();
    this.loopManager = new RalphLoopManager(config.baseRepoPath);
  }

  /**
   * The Meta-Loop oversees the entire Dark Factory pipeline.
   * It runs the Plan Evaluator, then orchestrates the Worker and Code Evaluator,
   * handling retries autonomously up to the stop conditions.
   */
  public async executeAutonomousPipeline(
    spec: OpenSpec,
    workerFn: (contextDir: string, req: SpecRequirement, failureFeedback?: string) => Promise<void>,
    testRunnerFn: (contextDir: string) => Promise<string>
  ): Promise<boolean> {
    
    // 1. Safeguard: Plan Evaluation (Catch cascade failures early)
    const planResult = await this.planEvaluator.evaluatePlan(spec);
    if (!planResult.isApproved) {
      console.error(`MetaLoop: Plan rejected by Evaluator. Reason: ${planResult.feedback}`);
      return false; // In a real system, we might loop back to the Planner here!
    }

    // 2. Execution Loop
    for (const requirement of spec.requirements) {
      let attempts = 0;
      let success = false;
      let lastFeedback = "";

      while (attempts < this.config.maxRetriesPerRequirement && !success) {
        attempts++;
        console.log(`[MetaLoop] Starting attempt ${attempts} for requirement ${requirement.id}`);

        // Axis 1: Pure Context
        const context = await this.loopManager.spawnIsolatedContext(spec, requirement);

        try {
          // Axis 3: The Worker does the job (isolated)
          await workerFn(context.worktreePath, requirement, lastFeedback);

          // Get diff (mocking a git diff call here)
          const diff = "mock diff from worker";

          // Axis 6: The Evaluator verifies
          const testLogs = await testRunnerFn(context.worktreePath);
          
          const evalResult = await this.evaluator.evaluateCodeAgainstSpec(
            spec, 
            diff, 
            async () => testLogs // wrap in async to match signature
          );

          if (evalResult.overallVerdict === "pass") {
            success = true;
            console.log(`[MetaLoop] Requirement ${requirement.id} verified successfully.`);
            // In a real system, we'd merge this worktree back to the main branch here
          } else {
            console.warn(`[MetaLoop] Evaluator rejected code: ${evalResult.summary}`);
            lastFeedback = evalResult.summary;
            // The loop continues, we'll spawn a fresh context next time and pass the feedback
          }

        } finally {
          // Always destroy the context to prevent rot
          await this.loopManager.destroyIsolatedContext(context);
        }
      }

      if (!success) {
        // Axis 4: Stop Condition met (limit reached)
        console.error(`[MetaLoop] Failed to implement requirement ${requirement.id} after ${this.config.maxRetriesPerRequirement} attempts.`);
        return false;
      }
    }

    console.log(`[MetaLoop] Successfully completed all requirements for spec ${spec.id}.`);
    return true;
  }
}
