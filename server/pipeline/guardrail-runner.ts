/**
 * GuardrailRunner — applies an ordered list of guardrails to stage output.
 *
 * For each guardrail:
 *  - passed   → continue to next guardrail
 *  - retry    → re-execute stage (up to maxRetries), then re-validate
 *  - skip     → record failure, continue with current output
 *  - fail     → throw GuardrailError
 *  - fallback → replace output with fallbackValue, continue
 */
import type { StageGuardrail, GuardrailResult, GuardrailOnFail } from "@shared/types";
import type { GuardrailValidator } from "./guardrail-validator.js";
import type { WsManager } from "../ws/manager.js";

export class GuardrailError extends Error {
  constructor(
    public readonly guardrailId: string,
    public readonly stageId: string,
    message: string,
  ) {
    super(message);
    this.name = "GuardrailError";
  }
}

interface GuardrailRunnerOptions {
  stageId: string;
  runId: string;
  guardrails: StageGuardrail[];
  validator: GuardrailValidator;
  wsManager: WsManager;
  executeStage: () => Promise<string>;
}

export interface GuardrailRunResult {
  output: string;
  guardrailResults: GuardrailResult[];
}

function broadcast(
  wsManager: WsManager,
  runId: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  wsManager.broadcastToRun(runId, {
    type: type as import("@shared/types").WsEventType,
    runId,
    payload,
    timestamp: new Date().toISOString(),
  });
}

export async function applyGuardrails(
  initialOutput: string,
  options: GuardrailRunnerOptions,
): Promise<GuardrailRunResult> {
  const { stageId, runId, guardrails, validator, wsManager, executeStage } = options;
  const results: GuardrailResult[] = [];
  let currentOutput = initialOutput;

  const enabled = guardrails.filter((g) => g.enabled);

  for (const guardrail of enabled) {
    broadcast(wsManager, runId, "guardrail:checking", { stageId, guardrailId: guardrail.id });

    let result = await validator.validate(currentOutput, guardrail);

    if (result.passed) {
      broadcast(wsManager, runId, "guardrail:passed", { stageId, guardrailId: guardrail.id });
      results.push(result);
      continue;
    }

    // Guardrail failed — apply onFail policy
    const action: GuardrailOnFail = guardrail.onFail;

    broadcast(wsManager, runId, "guardrail:failed", {
      stageId,
      guardrailId: guardrail.id,
      action,
      attempt: result.attempts,
    });

    if (action === "retry") {
      const maxRetries = guardrail.maxRetries ?? 1;
      let attempts = 1;

      while (!result.passed && attempts <= maxRetries) {
        broadcast(wsManager, runId, "guardrail:retrying", {
          stageId,
          guardrailId: guardrail.id,
          attempt: attempts,
        });

        currentOutput = await executeStage();
        result = await validator.validate(currentOutput, guardrail);
        result = { ...result, attempts: attempts + 1 };
        attempts++;
      }

      if (result.passed) {
        broadcast(wsManager, runId, "guardrail:passed", { stageId, guardrailId: guardrail.id });
        results.push(result);
        continue;
      }

      // Retries exhausted — escalate to fail
      results.push(result);
      throw new GuardrailError(
        guardrail.id,
        stageId,
        `Guardrail "${guardrail.id}" failed after ${maxRetries} retries: ${result.reason ?? "validation failed"}`,
      );
    }

    if (action === "skip") {
      results.push({ ...result, reason: result.reason ?? "skipped" });
      continue;
    }

    if (action === "fallback") {
      currentOutput = guardrail.fallbackValue ?? "";
      results.push(result);
      continue;
    }

    // action === "fail"
    results.push(result);
    throw new GuardrailError(
      guardrail.id,
      stageId,
      `Guardrail "${guardrail.id}" failed: ${result.reason ?? "validation failed"}`,
    );
  }

  return { output: currentOutput, guardrailResults: results };
}
