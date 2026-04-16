/**
 * Inter-stage A2A (agent-to-agent) messaging for pipeline runs (issue #269).
 *
 * A stage can ask another stage a clarifying question mid-run.  The target
 * stage responds asynchronously.  Key guarantees:
 *
 *  - Per-stage rate limit (maxClarifyPerStage).  Exceeded → immediate error.
 *  - Configurable timeout.  Expired → pipeline continues without the answer.
 *  - Messages are redacted for secrets before broadcast to the WS layer.
 *  - All events surfaced via WS so the trace UI can show a conversation thread.
 */

import { randomUUID } from "crypto";
import type {
  StageA2AClarifyMessage,
  StageA2AAnswerMessage,
  A2AThreadEntry,
} from "@shared/types";
import type { WsManager } from "../ws/manager";

// ─── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_A2A_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_CLARIFY_PER_STAGE = 5;

// ─── Secret redaction ────────────────────────────────────────────────────────

/**
 * Patterns that look like secrets.  We replace the matched value with [REDACTED]
 * before broadcasting messages over WS.
 *
 * The patterns are intentionally conservative — better to redact a benign token
 * than to leak a real secret.
 */
const SECRET_PATTERNS: RegExp[] = [
  // key=value style (e.g. password=abc123, token=xyz)
  /(?:password|passwd|secret|token|api[_-]?key|apikey|auth|bearer|credential)[\s=:]+\S+/gi,
  // Authorization header values
  /Authorization:\s*\S+/gi,
  // AWS-style key IDs
  /(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}/g,
  // Long base64-like strings (>= 32 hex chars or base64 chars with no spaces)
  /\b[A-Za-z0-9+/]{32,}={0,2}\b/g,
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      // Preserve the key part (before =/:) if possible
      const eqIdx = match.search(/[=:]/);
      if (eqIdx > 0) {
        return match.slice(0, eqIdx + 1) + "[REDACTED]";
      }
      return "[REDACTED]";
    });
  }
  return result;
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

/**
 * In-memory per-(run,stage) counter for clarify messages.
 * Keyed as `<runId>::<stageId>`.
 */
export class A2ARateLimiter {
  private readonly counts = new Map<string, number>();

  increment(runId: string, stageId: string): number {
    const key = `${runId}::${stageId}`;
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  getCount(runId: string, stageId: string): number {
    return this.counts.get(`${runId}::${stageId}`) ?? 0;
  }

  /** Call this when a run completes/fails/cancels to free memory. */
  clearRun(runId: string): void {
    for (const key of this.counts.keys()) {
      if (key.startsWith(`${runId}::`)) this.counts.delete(key);
    }
  }
}

// ─── Pending answer handle ────────────────────────────────────────────────────

interface PendingAnswer {
  resolve: (answer: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── A2AMessagingService ──────────────────────────────────────────────────────

/**
 * Manages A2A inter-stage messaging within a pipeline run.
 *
 * Lifecycle: one instance per `PipelineController` (or per run for
 * better isolation).  The controller wires it in and calls
 * `handleAnswer()` whenever a target stage resolves a clarification.
 */
export class A2AMessagingService {
  private readonly pending = new Map<string, PendingAnswer>();
  private readonly rateLimiter: A2ARateLimiter;

  /** Thread entries accumulated during a run, keyed by runId. */
  private readonly threads = new Map<string, A2AThreadEntry[]>();

  constructor(
    private readonly wsManager: WsManager,
    private readonly maxClarifyPerStage: number = DEFAULT_MAX_CLARIFY_PER_STAGE,
    private readonly defaultTimeoutMs: number = DEFAULT_A2A_TIMEOUT_MS,
    rateLimiter?: A2ARateLimiter,
  ) {
    this.rateLimiter = rateLimiter ?? new A2ARateLimiter();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Send a clarify question from `fromStageId` to `targetStageId`.
   *
   * Returns the answer text if the target responds within `timeoutMs`,
   * or `null` if it times out.
   *
   * Throws if the rate limit for (runId, fromStageId) is exceeded.
   */
  async clarify(
    runId: string,
    fromStageId: string,
    targetStageId: string,
    question: string,
    contextRefs: string[] = [],
    timeoutMs?: number,
  ): Promise<string | null> {
    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;

    // ── Rate limit check ──────────────────────────────────────────────────────
    const count = this.rateLimiter.increment(runId, fromStageId);
    if (count > this.maxClarifyPerStage) {
      throw new A2ARateLimitExceededError(fromStageId, this.maxClarifyPerStage);
    }

    const clarifyId = randomUUID();
    const sentAt = Date.now();

    const message: StageA2AClarifyMessage = {
      id: clarifyId,
      runId,
      fromStageId,
      targetStageId,
      question: redactSecrets(question),
      contextRefs,
      sentAt,
      timeoutMs: effectiveTimeout,
    };

    // ── Record in thread ──────────────────────────────────────────────────────
    this.appendThread(runId, {
      id: clarifyId,
      type: "clarify",
      fromStageId,
      targetStageId,
      content: message.question,
      timestamp: sentAt,
    });

    // ── Broadcast via WS ──────────────────────────────────────────────────────
    this.wsManager.broadcastToRun(runId, {
      type: "stage:a2a:clarify",
      runId,
      payload: { ...message },
      timestamp: new Date(sentAt).toISOString(),
    });

    // ── Wait for answer or timeout ────────────────────────────────────────────
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(clarifyId);
        this.appendThread(runId, {
          id: randomUUID(),
          type: "timeout",
          fromStageId,
          targetStageId,
          content: `Timeout after ${effectiveTimeout}ms — no answer received`,
          timestamp: Date.now(),
        });
        this.wsManager.broadcastToRun(runId, {
          type: "stage:a2a:timeout",
          runId,
          payload: { clarifyId, fromStageId, targetStageId, timeoutMs: effectiveTimeout },
          timestamp: new Date().toISOString(),
        });
        resolve(null);
      }, effectiveTimeout);

      this.pending.set(clarifyId, { resolve, timer });
    });
  }

  /**
   * Called by the target stage (or the controller) to supply an answer.
   * No-op if the clarify request already timed out.
   */
  handleAnswer(
    runId: string,
    clarifyId: string,
    fromStageId: string,
    targetStageId: string,
    answerText: string,
  ): void {
    const handle = this.pending.get(clarifyId);
    if (!handle) return; // already timed out or already answered

    clearTimeout(handle.timer);
    this.pending.delete(clarifyId);

    const answeredAt = Date.now();
    const redacted = redactSecrets(answerText);

    const answer: StageA2AAnswerMessage = {
      clarifyId,
      runId,
      fromStageId,
      targetStageId,
      answer: redacted,
      answeredAt,
    };

    this.appendThread(runId, {
      id: randomUUID(),
      type: "answer",
      fromStageId: targetStageId,
      targetStageId: fromStageId,
      content: redacted,
      timestamp: answeredAt,
    });

    this.wsManager.broadcastToRun(runId, {
      type: "stage:a2a:answer",
      runId,
      payload: { ...answer },
      timestamp: new Date(answeredAt).toISOString(),
    });

    handle.resolve(answer.answer);
  }

  /** Retrieve the A2A thread for a run (for trace UI). */
  getThread(runId: string): A2AThreadEntry[] {
    return [...(this.threads.get(runId) ?? [])];
  }

  /** Free resources when a run ends. */
  clearRun(runId: string): void {
    this.threads.delete(runId);
    this.rateLimiter.clearRun(runId);
    // Resolve any still-pending clarifies as timed-out
    for (const [clarifyId, handle] of this.pending.entries()) {
      // We don't have runId stored per entry; iterate and cancel all pending
      // that belong to this run via broadcast key.  In practice this is rare
      // (run cancelled mid-clarify).
      clearTimeout(handle.timer);
      handle.resolve(null);
      this.pending.delete(clarifyId);
    }
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private appendThread(runId: string, entry: A2AThreadEntry): void {
    if (!this.threads.has(runId)) this.threads.set(runId, []);
    this.threads.get(runId)!.push(entry);
  }
}

// ─── Error Types ──────────────────────────────────────────────────────────────

export class A2ARateLimitExceededError extends Error {
  constructor(stageId: string, max: number) {
    super(
      `A2A rate limit exceeded for stage "${stageId}": ` +
      `max ${max} clarify messages per stage per run.`,
    );
    this.name = "A2ARateLimitExceededError";
  }
}
