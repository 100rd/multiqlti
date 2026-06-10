/**
 * Pure helpers + UI-facing types for the debate-research orchestrator surface.
 *
 * Mirrors the lib/news.ts model: the components are thin; the logic that matters
 * (the approval-gate state machine, cost projection, step display metadata, the
 * untrusted-URL guard, transcript grouping) lives here as pure functions that
 * are unit-tested without a DOM renderer.
 *
 * SECURITY:
 *  - Every model-generated / fetched string surfaced through this module — task,
 *    needs, step args, debate content, recommendation, dissent, research claims,
 *    snippets, sourceUrl, the synthesis output — is UNTRUSTED. Components render
 *    it as INERT React text only (never via dangerouslySetInnerHTML / any HTML
 *    sink). `safeHttpsHref` is the ONLY way a fetched sourceUrl becomes a
 *    clickable anchor, and such anchors carry rel="noopener noreferrer".
 *  - tokensUsed / projected cost / confidence / diversity are system-derived
 *    signals, never user-authoritative.
 */
import type {
  OrchestratorStepType,
  OrchestratorStepStatus,
  OrchestratorRunStatus,
  OrchestratorStepArgs,
  ArbitratorVerdict,
} from "@shared/types";

export type {
  OrchestratorStepType,
  OrchestratorStepStatus,
  OrchestratorRunStatus,
  OrchestratorStepArgs,
  ArbitratorVerdict,
};

// ─── API response shapes (the contracts in server/routes/orchestrator.ts) ───────
// These mirror the persisted rows but with timestamps serialized as ISO strings
// (JSON transport). Only the fields the UI reads are declared.

/** The orchestrator_runs row as returned over JSON. */
export interface OrchestratorRun {
  id: string;
  runId: string;
  task: string;
  needs: string | null;
  workspaceId: string | null;
  status: OrchestratorRunStatus;
  planApprovedAt: string | null;
  planApprovedBy: string | null;
  totalTokensUsed: number;
  stepCount: number;
  /** Final deliverable (synthesis step output). Untrusted. */
  output: unknown;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** A single orchestrator_steps row as returned over JSON. */
export interface OrchestratorStep {
  id: string;
  runId: string;
  stepIndex: number;
  type: OrchestratorStepType;
  args: OrchestratorStepArgs;
  status: OrchestratorStepStatus;
  output: unknown;
  tokensUsed: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** GET /api/runs/:id/orchestrator. */
export interface OrchestratorStatus {
  orchestratorRun: OrchestratorRun | null;
  steps: OrchestratorStep[];
  totalTokensUsed: number;
}

/** One round of a debate transcript. Every string field is untrusted. */
export interface DebateRound {
  round: number;
  participant: string;
  role: string;
  content: string;
  provider?: string;
}

/** An orchestrator_debates row as returned over JSON. */
export interface OrchestratorDebate {
  id: string;
  runId: string;
  stepId: string;
  question: string;
  rounds: DebateRound[];
  judgeVerdict: string;
  arbitratorVerdict: ArbitratorVerdict | null;
  providerDiversityScore: number | null;
  recommendation: string | null;
  confidence: number | null;
  dissent: string[] | null;
  degraded: boolean;
  totalTokensUsed: number;
  createdAt: string;
}

/** A single cited research finding. Every string field is untrusted. */
export interface ResearchFinding {
  claim: string;
  sourceUrl: string;
  snippet: string;
}

/** An orchestrator_research row as returned over JSON. */
export interface OrchestratorResearch {
  id: string;
  runId: string;
  stepId: string;
  query: string;
  findings: ResearchFinding[];
  sourcesFetched: number;
  sourcesSkipped: number;
  createdAt: string;
}

/** Caps a user may override at start / approve. Bounded again server-side. */
export interface OrchestratorCapsInput {
  maxDebateRounds?: number;
  maxResearchSources?: number;
  maxSteps?: number;
  maxTotalTokens?: number;
}

// ─── Step display metadata ──────────────────────────────────────────────────────

/** Human label for each typed step kind. */
export const STEP_LABELS: Record<OrchestratorStepType, string> = {
  research: "Research",
  "analyze-code": "Analyze code",
  debate: "Debate",
  ground: "Ground",
  synthesize: "Synthesize",
};

/**
 * The primary untrusted descriptor for a step (the question/query/instruction
 * the plan proposed). Returned as inert text by the caller. Never throws.
 */
export function stepSummary(args: OrchestratorStepArgs): string {
  switch (args.type) {
    case "research":
      return args.query;
    case "analyze-code":
      return args.query;
    case "debate":
      return args.question;
    case "ground":
      return args.query;
    case "synthesize":
      return args.instruction ?? "Synthesize the final deliverable";
  }
}

// ─── Approval-gate state machine ────────────────────────────────────────────────

/**
 * Whether the plan-approval controls (Approve / Reject / edit) are actionable.
 * Only TRUE while the run is paused at the human gate. Idempotent + again-safe:
 * any other status (planning, executing, completed, failed, cancelled, or a
 * not-yet-loaded null run) disables the controls.
 */
export function isAwaitingApproval(
  run: Pick<OrchestratorRun, "status"> | null | undefined,
): boolean {
  return run?.status === "awaiting_plan_approval";
}

/** Whether the run is still doing work (so Cancel is meaningful). */
export function isRunActive(
  run: Pick<OrchestratorRun, "status"> | null | undefined,
): boolean {
  if (!run) return false;
  return (
    run.status === "planning" ||
    run.status === "awaiting_plan_approval" ||
    run.status === "executing"
  );
}

/** Whether the run reached a terminal state (poll/subscribe can stop). */
export function isRunTerminal(
  run: Pick<OrchestratorRun, "status"> | null | undefined,
): boolean {
  if (!run) return false;
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled"
  );
}

// ─── Cost / token-budget projection ─────────────────────────────────────────────

const DOLLARS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Default blended $/1K-token rate used ONLY for a rough projected-cost display.
 * The server enforces the real token ceiling; this is an at-a-glance estimate,
 * never an authoritative charge.
 */
export const USD_PER_1K_TOKENS = 0.015;

/** Project an approximate USD ceiling from the token budget. */
export function projectedCostUsd(
  maxTotalTokens: number,
  ratePer1k: number = USD_PER_1K_TOKENS,
): number {
  if (!Number.isFinite(maxTotalTokens) || maxTotalTokens <= 0) return 0;
  return (maxTotalTokens / 1000) * ratePer1k;
}

/** Format a USD amount for display. */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return DOLLARS.format(0);
  return DOLLARS.format(Math.max(0, amount));
}

/** Format a token count with grouping (e.g. 400000 → "400,000"). */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  return Math.round(tokens).toLocaleString("en-US");
}

/**
 * Fraction (0..1) of the token budget consumed so far. Clamped. Returns 0 when
 * the budget is unknown / non-positive (avoids divide-by-zero in a progress bar).
 */
export function tokenBudgetFraction(used: number, budget: number): number {
  if (!Number.isFinite(budget) || budget <= 0) return 0;
  const f = used / budget;
  if (!Number.isFinite(f)) return 0;
  return Math.min(1, Math.max(0, f));
}

/** Percentage of confidence/diversity in 0..100 (clamped). */
export function toPercent(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

// ─── Debate transcript grouping ─────────────────────────────────────────────────

/** One numbered round with the turns taken in it, in stable participant order. */
export interface GroupedDebateRound {
  round: number;
  turns: DebateRound[];
}

/**
 * Group a flat debate rounds[] by round number, preserving the original turn
 * order within each round and ordering rounds ascending. Pure + deterministic.
 */
export function groupDebateRounds(rounds: DebateRound[]): GroupedDebateRound[] {
  const byRound = new Map<number, DebateRound[]>();
  for (const turn of rounds) {
    const list = byRound.get(turn.round);
    if (list) list.push(turn);
    else byRound.set(turn.round, [turn]);
  }
  return Array.from(byRound.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([round, turns]) => ({ round, turns }));
}

// ─── URL safety (Security C3 / M2) ──────────────────────────────────────────────

/**
 * Guard a fetched research `sourceUrl` for use as an anchor href: returns the
 * URL ONLY when it parses as an absolute `https:` URL, else `null` (the caller
 * must then render the URL as inert plain text and NOT link it). Identical
 * semantics to lib/news.safeHttpsHref — fetched URLs are untrusted and never
 * auto-followed; anchors built from this carry rel="noopener noreferrer".
 */
export function safeHttpsHref(uri: string | null | undefined): string | null {
  if (!uri) return null;
  try {
    const u = new URL(uri);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Coerce an arbitrary orchestrator step / run output payload to a readable,
 * INERT string for display. Strings pass through; objects are pretty-printed
 * JSON; null/undefined → "". Never throws, never produces HTML.
 */
export function outputToText(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (typeof output === "number" || typeof output === "boolean") {
    return String(output);
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return "";
  }
}

/** Extract a user-facing message from an unknown error. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unexpected error";
}

/**
 * Detect the orchestrator-disabled signal from a start error. The start route
 * returns HTTP 503 with the message "Orchestrator mode is disabled"; the shared
 * apiRequest throws `Error("503: ...")`. We match either shape so the UI can
 * show a friendly disabled state instead of a generic failure.
 */
export function isOrchestratorDisabledError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return msg.includes("503") || msg.includes("orchestrator mode is disabled");
}
