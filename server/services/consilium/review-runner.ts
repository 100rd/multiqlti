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

// Part B (throttled v2, per-seat fallback): fewest surviving NON-judge reviewers
// after usage-limit seat drops before the WHOLE run throttles (quorum gate below).
const MIN_REVIEWERS = 2;

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

/** The slice of `Model` (shared/schema.ts) the fallback picker needs. */
export interface ReviewModelCatalogEntry {
  slug: string;
  provider: string;
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
  /**
   * Part B (throttled v2, per-seat fallback): the VISIBLE active-model catalog
   * (`storage.getActiveModels()`, mapped to `{slug, provider}`) used to auto-rotate a
   * seat's model when its assigned model hits a usage/rate limit mid-review. Omitted
   * (or empty) yields no fallback candidates — a rate-limited seat then has nothing to
   * rotate to and is dropped (non-judge) / throttles the run (judge), same as before
   * this catalog is wired through.
   */
  activeModels?: ReviewModelCatalogEntry[];
}

/**
 * Part B: candidate fallback models for a rate-limited seat — active models on a
 * DIFFERENT provider than the failing slug, excluding any slug already claimed by
 * another seat this run. Order preserved from the caller's catalog order.
 */
function pickFallbackCandidates(
  failingSlug: string,
  activeModels: ReviewModelCatalogEntry[],
  claimedSlugs: ReadonlySet<string>,
): ReviewModelCatalogEntry[] {
  const failingProvider = activeModels.find((m) => m.slug === failingSlug)?.provider;
  return activeModels.filter((m) => m.provider !== failingProvider && !claimedSlugs.has(m.slug));
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
  const activeModels = params.activeModels ?? [];
  const outputs = new Map<string, unknown>(); // task name → its parsed `.output`
  const participants: RoundParticipant[] = []; // seats that PRODUCED output — the quorum count
  const droppedNotes: RoundParticipant[] = []; // informational only — appended AFTER the quorum gate, never counted toward it
  const dropped = new Set<string>(); // non-judge task names dropped after exhausting all fallback candidates
  // Part B: each seat's CURRENT model slug — starts as its assigned `modelSlug`,
  // rotates on a rate limit. Doubles as the "claimed this run" registry so two seats
  // never fall back onto the SAME model.
  const seatModel = new Map<string, string>(tasks.map((t) => [t.name, t.modelSlug ?? ""]));
  try {
    const pending = [...tasks];
    while (pending.length > 0) {
      // Cascade-drop: a NON-judge task depending on an already-dropped task can
      // never meaningfully run (its dep's output never lands in `outputs`) — drop it
      // too (repeat for multi-level deps, e.g. a rebuttal rebutting a dropped
      // primary). The JUDGE is EXEMPT — it must still run on whatever survived, so a
      // dropped dep just resolves as "missing" for it (see the ready-filter below),
      // never cascades the judge itself.
      let cascaded = true;
      while (cascaded) {
        cascaded = false;
        for (const t of [...pending]) {
          const deps = t.dependsOn ?? [];
          if (t.name !== judgeTaskName && !dropped.has(t.name) && deps.some((d) => dropped.has(d))) {
            dropped.add(t.name);
            pending.splice(pending.indexOf(t), 1);
            cascaded = true;
          }
        }
      }
      if (pending.length === 0) break;
      // A dropped dep counts as "resolved" (no data, never arrives) so the judge (or
      // any surviving dependent) can proceed without it instead of deadlocking.
      const ready = pending.filter((t) => (t.dependsOn ?? []).every((d) => outputs.has(d) || dropped.has(d)));
      if (ready.length === 0) throw new Error("review DAG has an unsatisfiable dependency");
      await Promise.all(
        ready.map(async (t) => {
          const deps = t.dependsOn ?? [];
          const depOutputs: Record<string, unknown> = {};
          for (const d of deps) if (outputs.has(d)) depOutputs[d] = outputs.get(d);
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
          const call = (modelSlug: string): Promise<{ content: string }> =>
            gateway.completeStreaming(
              {
                modelSlug,
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

          const originalSlug = t.modelSlug ?? "";
          let res: { content: string };
          let fallbackNote = "";
          try {
            res = await call(originalSlug);
          } catch (err) {
            const raw = err instanceof Error ? err.message : String(err);
            if (!isRateLimitError(raw)) throw err; // NON-rate-limit: rethrow — whole run degrades exactly as before.

            // Part B (throttled v2, per-seat fallback): rate-limited — auto-rotate
            // through candidate models (different provider, not already claimed by
            // another seat this run) before giving up on this seat.
            const isJudge = t.name === judgeTaskName;
            const claimed = new Set(seatModel.values());
            const candidates = pickFallbackCandidates(originalSlug, activeModels, claimed);
            let rotated: { content: string } | null = null;
            let lastErr: unknown = err;
            for (const candidate of candidates) {
              try {
                rotated = await call(candidate.slug);
                seatModel.set(t.name, candidate.slug);
                fallbackNote = `[fell back ${originalSlug}→${candidate.slug}] `;
                break;
              } catch (err2) {
                const raw2 = err2 instanceof Error ? err2.message : String(err2);
                if (!isRateLimitError(raw2)) throw err2; // non-rate-limit mid-fallback — propagate, degrade whole run.
                lastErr = err2;
              }
            }
            if (!rotated) {
              // All candidates (or none available) are ALSO rate-limited.
              if (isJudge) throw lastErr; // judge can't be dropped — throttles the WHOLE run (outer catch).
              dropped.add(t.name);
              droppedNotes.push({
                name: t.name,
                model: seatModel.get(t.name) ?? originalSlug,
                role: deps.length > 0 ? "rebuttal" : "primary",
                text: `[dropped: usage limit exhausted on ${originalSlug} and all fallback candidates]`,
              });
              return;
            }
            res = rotated;
          }
          const parsed = parseDirectLlmResponse(res.content);
          outputs.set(t.name, parsed.output);
          if (t.name !== judgeTaskName) {
            participants.push({
              name: t.name,
              model: seatModel.get(t.name) ?? originalSlug,
              role: deps.length > 0 ? "rebuttal" : "primary",
              text: fallbackNote + formatParticipantText(parsed),
            });
          }
        }),
      );
      for (const t of ready) pending.splice(pending.indexOf(t), 1);
    }

    // Part B quorum gate: only engaged when a usage-limit seat drop actually
    // happened — a fully-successful cross-review panel and an intentional
    // single-verifier round (0 non-judge seats BY DESIGN) are UNCHANGED.
    if (dropped.size > 0 && participants.length < MIN_REVIEWERS) {
      return {
        ...degraded("insufficient reviewer quorum after usage-limit seat drops"),
        rateLimited: true,
      };
    }

    const judgeOutput = outputs.get(judgeTaskName);
    const convergence = readConvergence(judgeOutput);
    return {
      converged: convergence.converged,
      openP0: convergence.openP0,
      openActionPoints: convergence.openActionPoints,
      verdict: readJudgeVerdict(judgeOutput),
      participants: boundParticipants([...participants, ...droppedNotes]),
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
