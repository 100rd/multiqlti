import type { OpenSpec, EvaluatorVerdict } from "@shared/types";

export interface PlanEvaluationResult {
  isApproved: boolean;
  verdict: EvaluatorVerdict;
  feedback: string;
}

export class PlanEvaluatorGate {
  private modelSlug: string;

  constructor(modelSlug: string = "claude-3-5-sonnet-latest") {
    this.modelSlug = modelSlug;
  }

  /**
   * The Plan Evaluator reviews the OpenSpec *before* it goes to the Worker.
   * This is Axis 7 (Safeguards) in action: catching cascade failures early.
   */
  public async evaluatePlan(spec: OpenSpec): Promise<PlanEvaluationResult> {
    
    // In a real system, we ask the LLM to verify that every requirement is TESTABLE.
    const systemPrompt = `
      You are the PLAN EVALUATOR in a Dark Factory autonomous development loop.
      Your job is to review the following OpenSpec and ensure it is MACHINE VERIFIABLE.
      If a requirement is too vague (e.g. "make it look nice") and cannot be proven by a test,
      you MUST reject the plan and provide feedback.
    `;

    const userPrompt = `
      TITLE: ${spec.title}
      VERSION: ${spec.version}

      REQUIREMENTS:
      ${spec.requirements.map(r => `- [${r.id}] ${r.description}\n  Acceptance: ${r.acceptanceCriteria}`).join("\n")}
    `;

    // TODO: Call LLM gateway.
    // Stubbing the response.
    const hasVagueRequirements = spec.requirements.some(r => r.acceptanceCriteria.length < 5);
    
    if (hasVagueRequirements) {
      return {
        isApproved: false,
        verdict: "fail",
        feedback: "Plan contains vague acceptance criteria that cannot be machine verified."
      };
    }

    return {
      isApproved: true,
      verdict: "pass",
      feedback: "Plan is verifiable."
    };
  }
}
