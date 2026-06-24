import type { OpenSpec, VerificationProof, EvaluatorResult } from "@shared/types";

export class EvaluatorWorker {
  private modelSlug: string;

  constructor(modelSlug: string = "claude-3-5-sonnet-latest") {
    this.modelSlug = modelSlug;
  }

  /**
   * The Adversarial Prompt ensures the evaluator's goal is to find flaws,
   * not just confirm the worker's claims.
   */
  private getAdversarialSystemPrompt(spec: OpenSpec): string {
    return `
      You are an ADVERSARIAL EVALUATOR in a Dark Factory autonomous development loop.
      Your job is NOT to confirm that the code works. Your job is to PROVE that the code FAILS to meet the spec.
      If you cannot prove it fails after rigorous testing, only then do you pass it.

      You must evaluate the provided code against the following Specification:
      TITLE: ${spec.title}
      VERSION: ${spec.version}

      REQUIREMENTS:
      ${spec.requirements.map(r => `- [${r.id}] ${r.description}\n  Acceptance: ${r.acceptanceCriteria}`).join("\n")}

      You must return a strict JSON output matching the EvaluatorResult schema.
      You MUST provide concrete proof (e.g. "I ran the test and it output X", or "I analyzed the code path and it throws Y").
    `;
  }

  public async evaluateCodeAgainstSpec(
    spec: OpenSpec,
    diff: string,
    executeTestsFn: () => Promise<string>
  ): Promise<EvaluatorResult> {
    
    // In a full implementation, we'd spawn an isolated sandbox here
    // and run `executeTestsFn` to get the raw logs.
    const testLogs = await executeTestsFn();

    const systemPrompt = this.getAdversarialSystemPrompt(spec);
    const userPrompt = `
      Here is the code diff provided by the worker:
      \`\`\`diff
      ${diff}
      \`\`\`

      Here are the logs from executing the tests/sandbox:
      \`\`\`
      ${testLogs}
      \`\`\`

      Provide your EvaluatorResult JSON.
    `;

    // TODO: Hook up the actual Gateway/LLM caller used in multiqlti.
    // For now, returning a stub based on the structure.
    return {
      specId: spec.id,
      overallVerdict: "fail", // Default to fail for safety
      summary: "Evaluator not fully connected to LLM gateway yet.",
      proofs: []
    };
  }
}
