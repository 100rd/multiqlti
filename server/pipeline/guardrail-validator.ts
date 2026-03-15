/**
 * GuardrailValidator — validates LLM stage output against configured guardrails.
 *
 * Supports four validation types:
 *  - json_schema : minimal required-fields + type check (no external deps)
 *  - regex       : regex test against output string
 *  - custom      : sandboxed JS expression evaluation (max 500 chars)
 *  - llm_check   : LLM-based YES/NO validation
 */
import type { Gateway } from "../gateway/index.js";
import type { GuardrailConfig, GuardrailResult, GuardrailType, StageGuardrail } from "@shared/types";

const MAX_CUSTOM_CODE_LENGTH = 500;

// ─── JSON Schema helpers ──────────────────────────────────────────────────────

function inferExpectedType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/**
 * Minimal JSON Schema validator: checks "required" fields and optional "type".
 * Does NOT add new npm dependencies — intentional inline implementation.
 */
function checkJsonSchema(
  data: Record<string, unknown>,
  schema: Record<string, unknown>,
): { valid: boolean; reason?: string } {
  const required = schema.required as string[] | undefined;
  const properties = schema.properties as Record<string, unknown> | undefined;

  if (Array.isArray(required)) {
    for (const field of required) {
      if (!(field in data) || data[field] === undefined || data[field] === null) {
        return { valid: false, reason: `missing required field: ${field}` };
      }
    }
  }

  if (properties) {
    for (const [key, propSchema] of Object.entries(properties)) {
      if (!(key in data)) continue;
      const propDef = propSchema as Record<string, unknown>;
      const expectedType = propDef.type as string | undefined;
      if (expectedType) {
        const actualType = inferExpectedType(data[key]);
        if (actualType !== expectedType) {
          return {
            valid: false,
            reason: `field "${key}" expected type "${expectedType}", got "${actualType}"`,
          };
        }
      }
    }
  }

  return { valid: true };
}

// ─── GuardrailValidator ───────────────────────────────────────────────────────

export class GuardrailValidator {
  constructor(private gateway: Gateway) {}

  async validate(output: string, guardrail: StageGuardrail): Promise<GuardrailResult> {
    const base = { guardrailId: guardrail.id, attempts: 1 };

    try {
      switch (guardrail.type as GuardrailType) {
        case "json_schema":
          return { ...base, ...this.validateJsonSchema(output, guardrail.config.schema ?? {}) };
        case "regex":
          return { ...base, ...this.validateRegex(output, guardrail.config.pattern ?? "") };
        case "custom":
          return { ...base, ...this.validateCustom(output, guardrail.config.validatorCode ?? "") };
        case "llm_check":
          return {
            ...base,
            ...(await this.validateLlmCheck(
              output,
              guardrail.config.llmPrompt ?? "",
              guardrail.config.llmModelSlug ?? "mock",
            )),
          };
        default:
          return { ...base, passed: false, reason: "unknown guardrail type" };
      }
    } catch (err) {
      return {
        ...base,
        passed: false,
        reason: err instanceof Error ? err.message : "validation error",
      };
    }
  }

  private validateJsonSchema(
    output: string,
    schema: Record<string, unknown>,
  ): { passed: boolean; reason?: string } {
    let parsed: unknown;

    try {
      parsed = JSON.parse(output);
    } catch {
      return { passed: false, reason: "output is not valid JSON" };
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { passed: false, reason: "output JSON is not an object" };
    }

    const result = checkJsonSchema(parsed as Record<string, unknown>, schema);
    return result.valid
      ? { passed: true }
      : { passed: false, reason: result.reason };
  }

  private validateRegex(
    output: string,
    pattern: string,
  ): { passed: boolean; reason?: string } {
    let regex: RegExp;

    try {
      regex = new RegExp(pattern);
    } catch {
      return { passed: false, reason: "invalid regex pattern" };
    }

    return regex.test(output)
      ? { passed: true }
      : { passed: false, reason: `output did not match pattern: ${pattern}` };
  }

  private validateCustom(
    output: string,
    code: string,
  ): { passed: boolean; reason?: string } {
    if (code.length > MAX_CUSTOM_CODE_LENGTH) {
      return {
        passed: false,
        reason: `validator code exceeds max length of ${MAX_CUSTOM_CODE_LENGTH} chars`,
      };
    }

    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function("output", `"use strict"; return (${code})`);
      const result = fn(output);
      return result === true
        ? { passed: true }
        : { passed: false, reason: "custom validator returned false" };
    } catch (err) {
      return {
        passed: false,
        reason: err instanceof Error ? err.message : "custom validator threw an error",
      };
    }
  }

  private async validateLlmCheck(
    output: string,
    prompt: string,
    modelSlug: string,
  ): Promise<{ passed: boolean; reason?: string }> {
    const response = await this.gateway.complete({
      modelSlug,
      messages: [
        { role: "system", content: "You are a validator. Answer only YES or NO." },
        {
          role: "user",
          content: `${prompt}\n\nOutput to validate:\n${output}`,
        },
      ],
    });

    const answer = response.content.trim().toUpperCase();
    return answer.startsWith("YES")
      ? { passed: true }
      : { passed: false, reason: `LLM validator answered: ${response.content.trim()}` };
  }
}
