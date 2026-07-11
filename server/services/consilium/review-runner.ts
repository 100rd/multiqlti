/**
 * review-runner.ts — the direct (task-group-free) consilium review executor.
 *
 * Phase 2 (defect-B): replaces the task-group `startGroupAsync` path with an
 * in-process runner that executes the SAME cross-review DAG (buildCrossReviewTasks:
 * primaries∥ → rebuttals → judge, or the lone buildSingleVerifierTask for a
 * round>1 confirmation) DIRECTLY over the gateway. It reproduces the orchestrator's
 * `executeDirectLlm` prompt + parse EXACTLY — the SAME `buildSystemPrompt` system
 * prompt, temperature 0.7 / maxTokens 4096 / `overallTimeoutMs`, and
 * `parseDirectLlmResponse` — so the judge output it yields is byte-identical to what
 * a task `execution.output` held and `pickJudgeOutput` / `readConvergence` /
 * `readJudgeVerdict` consume it UNCHANGED.
 *
 * PURE: no storage, no FSM, no task_group rows — trivially unit-testable with a fake
 * gateway. NEVER throws: a gateway/parse failure on ANY stage degrades the WHOLE run
 * to a conservative NOT-CONVERGED result carrying the scrubbed error (the review peer
 * of a no-PR degraded SDLC close-out), so the controller's `dispatchReview` settle
 * path is total.
 */
import type { CreateTaskParam } from "../task-orchestrator.js";
import type { TaskRow, TaskGroupIterationRow } from "@shared/schema";
import type { RoundParticipant } from "@shared/types";
import type { ReviewRunResult } from "./consilium-loop-controller.js";
import { buildSystemPrompt, parseDirectLlmResponse } from "../orchestrator/direct-llm-prompt.js";
import { readConvergence, readJudgeVerdict } from "../orchestrator/convergence.js";
import { isRateLimitError } from "../../gateway/rate-limit.js";

/** The gateway slice the runner needs — the completeStreaming shape of PlannerGateway. */
export interface ReviewGateway {
  completeStreaming(
    request: {
      modelSlug: string;
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
      maxTokens?: number;
    },
    privacyOptions?: unknown,
    loggingOptions?: unknown,
    streamOptions?: { overallTimeoutMs?: number },
  ): Promise<{ content: string }>;
}

// Participant bounds (Security L-2, parity with the verdict / action-point caps): the
// review prose is UNTRUSTED model text — cap the participant COUNT and each `text` so a
// malicious/verbose debate cannot bloat the persisted round row.
const MAX_PARTICIPANTS = 24;
const MAX_PARTICIPANT_TEXT = 8_000;

/** executeDirectLlm's per-call knobs (reproduced exactly for prompt/behaviour parity). */
const REVIEW_TEMPERATURE = 0.7;
const REVIEW_MAX_TOKENS = 4096;

function clampText(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Cap the participant list length and clamp each `text` (never throws). */
function boundParticipants(participants: RoundParticipant[]): RoundParticipant[] {
  return participants
    .slice(0, MAX_PARTICIPANTS)
    .map((p) => ({ ...p, text: clampText(p.text, MAX_PARTICIPANT_TEXT) }));
}

/** Minimal error scrub (strip fs paths + cap length) — mirrors the controller's scrubErr. */
function scrub(raw: string): string {
  return raw.replace(/\/[^\s'"]+/g, "<path>").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** A degraded (errored) run: conservative NOT-CONVERGED, no verdict/participants. */
function degraded(error: string): ReviewRunResult {
  return { converged: false, openP0: 0, openActionPoints: [], verdict: null, participants: null, error };
}

export interface RunReviewTasksParams {
  /** The review DAG — `buildCrossReviewTasks(panel)`, or `[buildSingleVerifierTask(...)]`. */
  tasks: CreateTaskParam[];
  /** The task whose parsed `.output` IS the verdict (JUDGE_TASK_NAME / VERIFIER_TASK_NAME). */
  judgeTaskName: string;
  /** The consilium group name (rides the system prompt, like the old `group.name`). */
  groupName: string;
  /** The review input — objective + diff-context, exactly what `iteration.input` held. */
  groupInput: string;
  gateway: ReviewGateway;
  /** Per-call wall-clock cap (pipeline.taskGroups.taskTimeoutMs), like executeDirectLlm. */
  timeoutMs: number;
}

/**
 * Execute the review DAG and assemble a {@link ReviewRunResult}. Runs tasks in
 * DEPENDENCY ORDER — primaries (no deps) first, then each task once all its deps have
 * settled — with the tasks in a wave running in PARALLEL (so primaries∥ → rebuttals∥ →
 * judge). Every NON-judge task becomes a participant (role from its dependency shape:
 * no deps ⇒ `primary`, else ⇒ `rebuttal`); the judge task's parsed `.output` is the
 * verdict feeding `readConvergence` / `readJudgeVerdict`. NEVER throws.
 */
/**
 * Render a reviewer's SUBSTANTIVE output into readable transcript text for the
 * per-participant card. The model returns `{ summary, output }`; `summary` is a
 * one-line status ("Completed review") — useless to a human — while the real
 * analysis (verdict + strengths/concerns/action points) lives in `output`.
 * We surface that so an operator can see exactly what each reviewer concluded,
 * not just the judge's synthesis. Falls back to `summary` when `output` is thin
 * or unstructured. INERT model text — the UI renders it as plain text.
 */
function formatParticipantText(parsed: ReturnType<typeof parseDirectLlmResponse>): string {
  const o = parsed.output;
  if (!o || typeof o !== "object") return parsed.summary;
  const rec = o as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const bullets = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .map((x) =>
            typeof x === "string"
              ? x.trim()
              : x && typeof x === "object"
                ? str((x as Record<string, unknown>).title) || str((x as Record<string, unknown>).text)
                : "",
          )
          .filter((s) => s !== "")
      : [];

  const parts: string[] = [];
  const verdict = str(rec.recommendation) || str(rec.decision) || str(rec.verdict);
  if (verdict) parts.push(`Verdict: ${verdict}`);
  const summ = str(rec.summary) || parsed.summary;
  if (summ) parts.push(summ);
  const section = (label: string, key: string): void => {
    const items = bullets(rec[key]);
    if (items.length > 0) parts.push(`${label}:\n${items.map((s) => `• ${s}`).join("\n")}`);
  };
  section("Strengths", "pros");
  section("Concerns", "cons");
  section("Action points", "actionPoints");

  const text = parts.join("\n\n").trim();
  return text !== "" ? text : parsed.summary;
}

export async function runReviewTasks(params: RunReviewTasksParams): Promise<ReviewRunResult> {
  const { tasks, judgeTaskName, groupName, groupInput, gateway, timeoutMs } = params;
  const outputs = new Map<string, unknown>(); // task name → its parsed `.output`
  const participants: RoundParticipant[] = [];
  try {
    const pending = [...tasks];
    while (pending.length > 0) {
      const ready = pending.filter((t) => (t.dependsOn ?? []).every((d) => outputs.has(d)));
      if (ready.length === 0) throw new Error("review DAG has an unsatisfiable dependency");
      await Promise.all(
        ready.map(async (t) => {
          const deps = t.dependsOn ?? [];
          const depOutputs: Record<string, unknown> = {};
          for (const d of deps) depOutputs[d] = outputs.get(d);
          // Reuse buildSystemPrompt VERBATIM (fidelity with executeDirectLlm) — it reads
          // only `.name`/`.description` off the task and `.input` off the iteration, so a
          // minimal cast is safe. objective+diff-context ride the SYSTEM prompt (as the
          // old path did via iteration.input); the user turn carries the per-task input.
          const system = buildSystemPrompt(
            { name: t.name, description: t.description } as unknown as TaskRow,
            { name: groupName },
            { input: groupInput } as unknown as TaskGroupIterationRow,
            depOutputs,
          );
          const userInput = t.input ? JSON.stringify(t.input) : "{}";
          const res = await gateway.completeStreaming(
            {
              modelSlug: t.modelSlug ?? "",
              messages: [
                { role: "system", content: system },
                { role: "user", content: userInput },
              ],
              temperature: REVIEW_TEMPERATURE,
              maxTokens: REVIEW_MAX_TOKENS,
            },
            undefined,
            undefined,
            { overallTimeoutMs: timeoutMs },
          );
          const parsed = parseDirectLlmResponse(res.content);
          outputs.set(t.name, parsed.output);
          if (t.name !== judgeTaskName) {
            participants.push({
              name: t.name,
              model: t.modelSlug ?? "",
              role: deps.length > 0 ? "rebuttal" : "primary",
              text: formatParticipantText(parsed),
            });
          }
        }),
      );
      for (const t of ready) pending.splice(pending.indexOf(t), 1);
    }
    const judgeOutput = outputs.get(judgeTaskName);
    const convergence = readConvergence(judgeOutput);
    return {
      converged: convergence.converged,
      openP0: convergence.openP0,
      openActionPoints: convergence.openActionPoints,
      verdict: readJudgeVerdict(judgeOutput),
      participants: boundParticipants(participants),
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const result = degraded(scrub(raw));
    // CONSERVATIVE: only a CLEAR usage/rate-limit signature sets `rateLimited` —
    // every other failure keeps the existing degraded/`review_failed` path
    // byte-identical (see rate-limit.ts).
    return isRateLimitError(raw) ? { ...result, rateLimited: true } : result;
  }
}
