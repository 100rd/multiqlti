/**
 * ConsiliumLoopDetail — the live view of one consilium loop (design §7): an FSM
 * stepper, key facts (with task-group links), the Draft-PR link, a per-round
 * history table (expandable to the still-open action points), and the
 * state-conditional actions: Start / Cancel / Approve-merge.
 *
 * The "Approve merge & continue" action is the autonomy→production HITL gate. It
 * is server-gated to maintainer/admin (a plain owner gets 403). Because it
 * advances autonomously-produced code toward main AND triggers the next round,
 * it is placed behind a confirm dialog that surfaces the PR link and the warning.
 *
 * A `research`-archetype loop instead produces a RESEARCHED REPORT (Stage 3, no
 * code / no Draft PR): it reaches `awaiting_merge` with prRef:null and the report
 * rides the latest round → surfaced by ReportPanel (below), inert.
 *
 * SECURITY: every loop/round/AP text field (error, testSummary, action-point
 * titles/rationale, and the research report's question/recommendation/claims/
 * citations) is model- or loop-authored and is rendered as INERT React text.
 * Every external link (PR + citations + sources) uses rel="noopener noreferrer".
 */
import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import {
  Repeat,
  ExternalLink,
  Loader2,
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  Check,
  X,
  Clock,
  Play,
  Ban,
  GitMerge,
  Hammer,
  Tag,
  RefreshCw,
  Sparkles,
  FileText,
  ShieldCheck,
  ShieldAlert,
  BookOpen,
  Gavel,
  Rocket,
  Users,
  Cpu,
  Wrench,
  FlaskConical,
  GitBranch,
  Radio,
  Info,
  CheckCircle2,
} from "lucide-react";
import {
  useConsiliumLoop,
  useStartLoop,
  useCancelLoop,
  useApproveMerge,
  useDevelopLoop,
  usePlanLoop,
  useSetArchetype,
  isTerminalLoopState,
  isVerdictTerminalLoopState,
  type ConsiliumLoopRoundRow,
  type ConsiliumLoopRoundDetail,
  type ConsiliumLoopDetail as ConsiliumLoopDetailRow,
  type DevProgress,
  type ResearchReport,
  type ResearchCitation,
  type ResearchSource,
  type ExecutionTrace,
  type ExecutionController,
  type ExecutionWorker,
  type ExecutionSkill,
  type ExecutionCriterion,
  type ExecutionWorkerStatus,
  type ExecutionSkillCapability,
  type ExecutionCriterionMethod,
  type LoopComposition,
  type CompositionRole,
} from "@/hooks/use-consilium-loops";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import {
  LOOP_STATE_STYLE,
  LoopStateBadgeFor,
} from "@/components/consilium/loop-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ConsiliumLoopState } from "@/hooks/use-consilium-loops";
import { IterationDetailView } from "@/components/task-groups/iterations-panel";
import type { ActionPoint, Archetype, OpenRemainder } from "@shared/types";
import { ARCHETYPES } from "@shared/types";
import { summarizeNonP0Remainder } from "@shared/consilium-remainder";
import {
  explainLoopState,
  type LoopStatusTone,
} from "@shared/loop-status";

// Priority palette for action-point severity tiers (P0–P3). The loop page is now
// the canonical home of this taxonomy (the task-group verdict panel is retired).
const PRIORITY_COLOR: Record<string, string> = {
  P0: "bg-red-600 text-white",
  P1: "bg-orange-500 text-white",
  P2: "bg-yellow-500 text-black",
  P3: "bg-slate-500 text-white",
};

// Clarifies that the (intentionally red) P0 badge is a SEVERITY tier, not a
// failure status — so a wall of red P0s reads as "these are the critical items".
const PRIORITY_LEGEND =
  "P0–P3 — priority (P0 = critical), not completion status.";

/**
 * Open-P0 text colour. Mid-loop (non-terminal) an open P0 is EXPECTED
 * work-remaining → amber, not red. Zero open → green. Red is reserved for a
 * terminal loop that still carries P0s (a genuinely bad final outcome).
 */
function p0ClassName(openP0: number | null | undefined, terminal: boolean): string {
  if (openP0 == null) return "text-muted-foreground";
  if (openP0 <= 0) return "text-green-600 dark:text-green-400";
  return terminal
    ? "text-red-600 dark:text-red-400"
    : "text-amber-600 dark:text-amber-400";
}

/**
 * Convergence mark. `true` → green check (closed). `false` mid-loop just means
 * "not closed yet" → amber Clock (in-progress), NOT red. Only a TERMINAL
 * non-converged loop shows a red ✗ — there "didn't converge" is the bad outcome.
 */
function ConvergenceMark({
  converged,
  terminal,
  "data-testid": testId,
}: {
  converged: boolean | null | undefined;
  terminal: boolean;
  /** Optional test hook applied to whichever element renders (span / icon). */
  "data-testid"?: string;
}) {
  if (converged == null)
    return (
      <span data-testid={testId} className="text-muted-foreground">
        —
      </span>
    );
  if (converged) return <Check data-testid={testId} className="h-4 w-4 text-green-600" />;
  return terminal ? (
    <X data-testid={testId} className="h-4 w-4 text-red-500" />
  ) : (
    <Clock data-testid={testId} className="h-4 w-4 text-amber-500" aria-label="in progress" />
  );
}

function shortSha(sha: string | null | undefined): string {
  if (!sha) return "—";
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function isErrorWithStatus(err: unknown, status: number): boolean {
  // apiRequest throws a plain Error whose message is the server `error` string.
  // A 403 surfaces as the role guard's message; match on that as a fallback.
  if (!(err instanceof Error)) return false;
  if (status === 403) return /403|maintainer|admin|forbidden|role/i.test(err.message);
  return false;
}

// ─── Per-round FSM trajectory stepper (P3) ──────────────────────────────────
//
// The stepper reflects what ACTUALLY happened, PER ROUND — it never claims a
// step that wasn't reached. All inference is presentation-only, from data the
// loop GET already returns (state, round, the per-round rows, devGroupId, prRef):
//
//   • Every RECORDED round traversed Context → Review → Decide. The round row is
//     written from the convergence read at "deciding", so its existence proves
//     those three steps completed.
//   • A round that is NOT the final one necessarily produced a SUBSEQUENT round —
//     only possible via Develop → Await-merge → merge-approved. So every
//     non-final round shows all five steps "done" (and a "merged" outcome).
//   • The FINAL round's reach is derived from loop.state:
//       – non-terminal      → steps before loop.state are done, loop.state is the
//                             current step, later steps are "not reached".
//       – verdict-terminal   (converged | stopped_cap | escalated)
//                           → the loop terminates FROM "deciding"; Develop and
//                             Await-merge were NOT reached (dimmed "not reached").
//       – failed | cancelled → may stop anywhere, so claim only what is evidenced:
//                             Context/Review/Decide/Develop done iff a round row
//                             exists (the round row is written on entering
//                             DEVELOPING; H-2 SDLC sets no devGroupId), Await iff
//                             prRef is set.

type StepStatus = "done" | "current" | "not_reached";

const ROUND_STEPS: { key: ConsiliumLoopState; label: string }[] = [
  { key: "building_context", label: "Context" },
  { key: "reviewing", label: "Review" },
  { key: "deciding", label: "Decide" },
  { key: "developing", label: "Develop" },
  { key: "awaiting_merge", label: "Await merge" },
];

const ROUND_STEP_IDX: Record<string, number> = {
  building_context: 0,
  reviewing: 1,
  deciding: 2,
  developing: 3,
  awaiting_merge: 4,
};

// Verdict-terminal states all exit FROM "deciding" — they never developed in the
// final round (distinct from failed/cancelled, which can stop anywhere).
const VERDICT_TERMINAL: ReadonlySet<ConsiliumLoopState> = new Set<ConsiliumLoopState>([
  "converged",
  "stopped_cap",
  "escalated",
]);

function roundStepStatuses(args: {
  isLast: boolean;
  hasRoundRow: boolean;
  state: ConsiliumLoopState;
  prRef: string | null | undefined;
}): StepStatus[] {
  const { isLast, hasRoundRow, state, prRef } = args;

  // Produced a later round ⇒ fully traversed AND merged.
  if (!isLast) return ROUND_STEPS.map(() => "done");

  // Final round — derive reach from the loop's current / terminal state.
  const idx = ROUND_STEP_IDX[state];
  if (idx !== undefined) {
    // Non-terminal round step: < idx done, == idx current, > idx not reached.
    return ROUND_STEPS.map((_, i) =>
      i < idx ? "done" : i === idx ? "current" : "not_reached",
    );
  }

  if (VERDICT_TERMINAL.has(state)) {
    // Exits from "deciding": Context/Review/Decide done, Develop/Await never reached.
    return ROUND_STEPS.map((_, i) =>
      i <= ROUND_STEP_IDX.deciding ? "done" : "not_reached",
    );
  }

  // failed | cancelled (and the pre-start `pending` fallback) — claim only what
  // the data evidences.
  // H-2: the SDLC handoff no longer mints a DEV task group (devGroupId is always
  // null), so a recorded round row (written on entering DEVELOPING) is the
  // "developing reached" signal; prRef is the await/PR signal.
  const core: StepStatus = hasRoundRow ? "done" : "not_reached";
  return ROUND_STEPS.map((step) => {
    if (step.key === "awaiting_merge") return prRef ? "done" : "not_reached";
    return core;
  });
}

function RoundStepChip({
  step,
  status,
}: {
  step: { key: ConsiliumLoopState; label: string };
  status: StepStatus;
}) {
  const cls =
    status === "current"
      ? LOOP_STATE_STYLE[step.key].badge
      : status === "done"
        ? "bg-muted text-muted-foreground line-through decoration-muted-foreground/40"
        : "bg-muted/30 text-muted-foreground/50";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}
      title={status === "not_reached" ? "not reached" : undefined}
      aria-label={status === "not_reached" ? `${step.label}: not reached` : undefined}
    >
      {step.label}
    </span>
  );
}

function FsmStepper({ loop }: { loop: ConsiliumLoopDetailRow }) {
  const terminal = isTerminalLoopState(loop.state);
  const rounds = [...(Array.isArray(loop.rounds) ? loop.rounds : [])].sort(
    (a, b) => a.round - b.round,
  );

  // One display row per recorded round, plus a synthetic row for a round that is
  // in-flight but hasn't recorded its convergence yet (loop.round ahead of rows).
  const lastRecorded = rounds.length ? rounds[rounds.length - 1].round : 0;
  const currentRound = loop.round && loop.round > 0 ? loop.round : 1;

  const display: { round: number; row?: ConsiliumLoopRoundRow }[] = rounds.map((r) => ({
    round: r.round,
    row: r,
  }));
  if (currentRound > lastRecorded) display.push({ round: currentRound });
  if (display.length === 0) display.push({ round: 1 });

  return (
    <div className="space-y-2">
      {display.map((d, i) => {
        const isLast = i === display.length - 1;
        const statuses = roundStepStatuses({
          isLast,
          hasRoundRow: !!d.row,
          state: loop.state,
          prRef: loop.prRef,
        });
        const developStatus = statuses[ROUND_STEP_IDX.developing];
        const reachedDevelop = developStatus === "done" || developStatus === "current";
        return (
          <div key={d.round} className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 w-[4.5rem] shrink-0 text-[11px] font-medium text-muted-foreground tabular-nums">
              Round {d.round}
            </span>
            {ROUND_STEPS.map((step, si) => (
              <div key={step.key} className="flex items-center gap-1.5">
                <RoundStepChip step={step} status={statuses[si]} />
                {si < ROUND_STEPS.length - 1 && (
                  <ChevronRight className="h-3 w-3 text-muted-foreground/40" />
                )}
              </div>
            ))}
            {/* Per-round outcome */}
            {!isLast ? (
              <span className="ml-1 inline-flex items-center gap-1 text-[10px] text-green-600 dark:text-green-400">
                <GitMerge className="h-3 w-3" />
                merged
              </span>
            ) : terminal ? (
              <span className="ml-1">
                <LoopStateBadgeFor loop={loop} />
              </span>
            ) : null}
            {/* The P0 count that triggered DEV — only when this round actually
                reached development (a verdict-terminal round shows none). */}
            {reachedDevelop && d.row?.openP0 != null && d.row.openP0 > 0 && (
              <span className="ml-1 text-[10px] text-muted-foreground tabular-nums">
                {d.row.openP0} P0 → DEV
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Key facts ──────────────────────────────────────────────────────────────

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

// ─── Execution tree (Stage 4 observability) ──────────────────────────────────

/** True when a round carries a renderable execution trace. */
function traceHasContent(trace: ExecutionTrace | null | undefined): trace is ExecutionTrace {
  return !!trace && !!trace.controller && Array.isArray(trace.controller.workers);
}

/** A small green/red dot for a skill/worker/criterion outcome. */
function GreenDot({ green }: { green: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${green ? "bg-green-500" : "bg-red-500"}`}
      aria-label={green ? "green" : "red"}
    />
  );
}

function CriterionLeaf({ c }: { c: ExecutionCriterion }) {
  // Stage B (design §5): a manual-ops criterion is an operational action OUTSIDE the repo
  // that the pipeline can only SURFACE — it is NEVER green (adversarial risk 1). Render it
  // distinctly (amber "manual op — needs human"), never the misleading test "not run"/"unmet".
  if (c.method === "manual-ops") {
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span
          className="inline-block h-2 w-2 rounded-full bg-amber-500"
          aria-label="manual operation required"
        />
        <Badge variant="outline" className="text-[10px] py-0 border-amber-500 text-amber-700">
          manual-ops
        </Badge>
        <span className="text-amber-700 font-medium">manual op — needs human</span>
        <span className="text-foreground/80">{c.criterion || "—"}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <GreenDot green={c.passed} />
      <Badge variant="outline" className="text-[10px] py-0">{c.method}</Badge>
      {/* A TIMED-OUT run (ran:true, passed:false) is NOT-ADJUDICATED — checked before
          `passed` so it reads "timed out" (amber), never "unmet" (red). */}
      <span className={c.passed ? "text-muted-foreground" : c.timedOut ? "text-amber-600" : "text-red-600"}>
        {!c.ran ? "not run" : c.timedOut ? "timed out" : c.passed ? "passed" : "unmet"}
      </span>
      {typeof c.fixIterations === "number" && c.fixIterations > 0 && (
        <span className="text-muted-foreground">· {c.fixIterations} fix</span>
      )}
      {/* Timeout policy: NOT-ADJUDICATED marker (ambiguous: slow suite vs a hang; the
          fix loop was skipped). Distinct from a red regression — a small amber note. */}
      {c.timedOut === true && (
        <span className="text-amber-600 font-medium">· not adjudicated (timeout)</span>
      )}
      {/* Stage A: final-state re-verification of the whole worktree. A false here
          (esp. alongside passed:true) reveals a late-AP regression. Omitted when the
          final run timed out (unadjudicated — the timeout marker above carries it). */}
      {typeof c.passedAtFinal === "boolean" && (
        <span className={c.passedAtFinal ? "text-muted-foreground" : "text-red-600 font-medium"}>
          · final {c.passedAtFinal ? "green" : "regressed"}
        </span>
      )}
      <span className="text-foreground/80">{c.criterion || "—"}</span>
      {c.summary && !c.passed && (
        <span className="w-full text-muted-foreground font-mono text-[10px] break-words">{c.summary}</span>
      )}
    </div>
  );
}

function SkillLeaf({ s }: { s: ExecutionSkill }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <GreenDot green={s.green} />
      <span className="font-medium">{s.skillName || "—"}</span>
      <Badge variant="secondary" className="text-[10px] py-0">{s.capability}</Badge>
      {s.permissionsUsed.map((p, i) => (
        <span key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">{p}</span>
      ))}
    </div>
  );
}

function WorkerNode({ w }: { w: ExecutionWorker }) {
  const failed = w.status === "failed";
  return (
    <li className={`space-y-1 border-l-2 pl-3 ${failed ? "border-red-400" : "border-border/70"}`}>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {w.priority && <Badge variant="outline" className="text-[10px] py-0">{w.priority}</Badge>}
        <span className="font-medium">{w.title || `#${w.index}`}</span>
        <Badge variant={failed ? "destructive" : "secondary"} className="text-[10px] py-0">{w.status}</Badge>
      </div>
      {w.note && <p className="text-[11px] text-muted-foreground font-mono break-words">{w.note}</p>}
      {w.skills.length > 0 && (
        <div className="space-y-0.5 pl-1">
          {w.skills.map((s, i) => <SkillLeaf key={i} s={s} />)}
        </div>
      )}
      {w.criteria.length > 0 && (
        <div className="space-y-0.5 pl-1">
          {w.criteria.map((c, i) => <CriterionLeaf key={i} c={c} />)}
        </div>
      )}
    </li>
  );
}

/** Renders a settled execution trace: controller → workers → skills → criteria. */
function SettledExecutionTree({ trace }: { trace: ExecutionTrace }) {
  const c: ExecutionController = trace.controller;
  return (
    <div className="space-y-2 rounded-md border border-border/60 p-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <GreenDot green={c.green} />
        <span className="font-semibold">{c.label || c.kind}</span>
        {trace.archetype && <Badge variant="outline" className="text-[10px] py-0">{trace.archetype}</Badge>}
      </div>
      {c.note && <p className="text-[11px] text-muted-foreground font-mono break-words">{c.note}</p>}
      {c.workers.length > 0 ? (
        <ul className="space-y-2">
          {c.workers.map((w, i) => <WorkerNode key={i} w={w} />)}
        </ul>
      ) : (
        <p className="text-[11px] text-muted-foreground">No workers recorded.</p>
      )}
    </div>
  );
}

// ─── Rounds table ─────────────────────────────────────────────────────────────

function RoundRow({
  round,
  groupId,
  terminal,
}: {
  round: ConsiliumLoopRoundDetail;
  groupId: string;
  terminal: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const aps: ActionPoint[] = Array.isArray(round.openActionPoints)
    ? round.openActionPoints
    : [];
  // Stage 4: this round's persisted execution trace (history). When present, the
  // row expands to a mini-tree of how the round ran, ABOVE the still-open AP list.
  const trace = round.executionTrace;
  const hasTrace = traceHasContent(trace);
  // Every round maps to a consilium iteration (round N ↔ iteration N of the loop's
  // group). Its DISPUTE — the debaters' + judge's executions plus the human-note
  // editor — lives ON the round now (the standalone Task Groups page is retired)
  // and is fetched LAZILY only when the operator opens this section.
  const canShowDispute = !!groupId;
  const expandable = aps.length > 0 || hasTrace || canShowDispute;

  return (
    <>
      <TableRow
        data-testid="loop-round-row"
        className={expandable ? "cursor-pointer" : ""}
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
      >
        <TableCell className="tabular-nums">
          <span className="inline-flex items-center gap-1">
            {expandable &&
              (open ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              ))}
            {round.round}
          </span>
        </TableCell>
        <TableCell>
          <ConvergenceMark
            converged={round.converged}
            terminal={terminal}
            data-testid="loop-convergence-mark"
          />
        </TableCell>
        <TableCell className={`tabular-nums font-medium ${p0ClassName(round.openP0, terminal)}`}>
          {round.openP0 ?? "—"}
        </TableCell>
        <TableCell className="font-mono text-xs whitespace-nowrap">
          {shortSha(round.baselineCommit)} → {shortSha(round.headCommit)}
        </TableCell>
        <TableCell>
          {/* The per-group iteration INDEX. The task-group pages are retired, so
              this is inert text; the dispute for this iteration is revealed inline
              by expanding the row (below). */}
          <span className="text-muted-foreground text-xs">
            iter #{round.iterationNumber}
          </span>
        </TableCell>
      </TableRow>
      {open && expandable && (
        <TableRow>
          <TableCell colSpan={5} className="bg-muted/30">
            <div className="space-y-3 py-1">
              {/* Per-round mini-tree — how THIS round ran (Stage 4 history). */}
              {traceHasContent(trace) && (
                <div className="space-y-1.5">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Execution
                  </p>
                  <SettledExecutionTree trace={trace} />
                </div>
              )}
              {aps.length > 0 && (
                <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Still-open action points
              </p>
              <ul className="space-y-1.5">
                {aps.map((ap, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-sm"
                    data-testid="loop-ap-item"
                    data-priority={ap.priority ?? ""}
                  >
                    {ap.priority && (
                      <Badge className={`${PRIORITY_COLOR[ap.priority] ?? "bg-muted"} shrink-0`}>
                        {ap.priority}
                      </Badge>
                    )}
                    <div className="min-w-0 space-y-0.5">
                      {/* INERT model-authored text */}
                      <span>{ap.title}</span>
                      {/* DoD criterion under the AP — INERT; hidden when absent. */}
                      {ap.acceptanceCriterion && (
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium uppercase tracking-wide text-muted-foreground/70">
                            Acceptance criterion (DoD):
                          </span>{" "}
                          {ap.acceptanceCriterion}
                        </p>
                      )}
                      {/* Stage C (design §9 "Stage 7"): a criterion that FAILED the mechanical
                          generation-time lint (weak/absent DoD) — surfaced as a small amber
                          marker, following the manual-ops / timed-out idioms. It was demoted
                          to the judge method so it can never converge as "tests green". */}
                      {ap.weakCriterion && (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                          title="Weak/absent acceptance criterion — demoted to judge verification (never counts as tests-green)."
                        >
                          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                          weak DoD — demoted to judge
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted-foreground/70">{PRIORITY_LEGEND}</p>
                </div>
              )}
              {/* Dispute — the consilium debate behind this round: each
                  participant's execution + the judge, plus the human-note editor
                  whose text flows into the NEXT round's dispute context. Mounted
                  (and fetched) only when opened, so the loop page stays light. */}
              {canShowDispute && (
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={() => setDisputeOpen((v) => !v)}
                    aria-expanded={disputeOpen}
                    className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
                  >
                    {disputeOpen ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                    <Gavel className="h-3.5 w-3.5" />
                    Dispute (iteration #{round.iterationNumber})
                  </button>
                  {disputeOpen && (
                    <IterationDetailView
                      groupId={groupId}
                      iterationNumber={round.iterationNumber}
                    />
                  )}
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// ─── Result panel — the human-gate outcome surface ─────────────────────────────
//
// ─── Status callout — a plain-English "what & why" for EVERY state ──────────────
//
// The FSM stepper shows WHERE the loop is with colour; this adds the WORDS. #466
// gave a CANCELLED loop a callout that rendered its error ("who/when/why"); an
// operator who hit `stopped_cap` got no words at all. This generalizes it: for
// EVERY state — non-terminal and terminal — `explainLoopState` (shared, pure,
// unit-tested) returns a toned `{ title, detail }` grounded in the loop's own
// numbers (round/maxRounds/open remainder/open P0). It reuses #466's behaviour
// for failed/cancelled (detail = the loop's error) and NEVER renders blank (a
// safe neutral default backs any unknown state).
//
// SECURITY: `detail` may be the loop/user-authored `error` (cancellation note /
// last-round error) — rendered as INERT React text, exactly as #466 did.
const STATUS_TONE_STYLE: Record<
  LoopStatusTone,
  { card: string; icon: string; title: string; body: string; Icon: typeof Info }
> = {
  good: {
    card: "border-green-600/50 bg-green-600/10",
    icon: "text-green-600 dark:text-green-400",
    title: "text-green-700 dark:text-green-300",
    body: "text-green-700/90 dark:text-green-300/90",
    Icon: CheckCircle2,
  },
  warning: {
    card: "border-amber-500/50 bg-amber-500/10",
    icon: "text-amber-600 dark:text-amber-400",
    title: "text-amber-700 dark:text-amber-300",
    body: "text-amber-700/90 dark:text-amber-300/90",
    Icon: AlertTriangle,
  },
  bad: {
    card: "border-red-600/50 bg-red-600/10",
    icon: "text-red-600 dark:text-red-400",
    title: "text-red-700 dark:text-red-300",
    body: "text-red-700/90 dark:text-red-300/90",
    Icon: AlertTriangle,
  },
  neutral: {
    card: "border-border bg-muted/40",
    icon: "text-muted-foreground",
    title: "text-foreground",
    body: "text-muted-foreground",
    Icon: Info,
  },
};

function LoopStatusCallout({ loop }: { loop: ConsiliumLoopDetailRow }) {
  const { title, tone, detail } = explainLoopState(loop);
  const s = STATUS_TONE_STYLE[tone];
  const Icon = s.Icon;
  return (
    <div className={`flex items-start gap-2 rounded-md border p-3 text-sm ${s.card}`}>
      <Icon className={`h-4 w-4 shrink-0 mt-0.5 ${s.icon}`} aria-hidden="true" />
      <div className="min-w-0">
        <p className={`font-medium ${s.title}`}>{title}</p>
        {/* INERT loop/user-authored text (error/cancellation note) or a code template. */}
        <p className={`break-words ${s.body}`}>{detail}</p>
      </div>
    </div>
  );
}

// What did the latest SDLC round actually produce? The stepper shows WHERE the
// loop is; this panel shows WHAT to decide on. It is rendered near the top so a
// human arriving at `awaiting_merge` is never met with a blank gate. Every field
// comes straight from the loop GET (loop.error, loop.prRef, the latest round's
// openP0 / openActionPoints) — nothing is invented.
//
// SECURITY: error text and action-point titles are model/loop-authored and are
// rendered as INERT React text; the PR link uses rel="noopener noreferrer".
function ResultPanel({
  loop,
  terminal,
}: {
  loop: ConsiliumLoopDetailRow;
  terminal: boolean;
}) {
  const rounds = Array.isArray(loop.rounds) ? loop.rounds : [];
  const latest = rounds.length
    ? [...rounds].sort((a, b) => b.round - a.round)[0]
    : undefined;
  const latestAps: ActionPoint[] = Array.isArray(latest?.openActionPoints)
    ? (latest!.openActionPoints as ActionPoint[])
    : [];
  const awaiting = loop.state === "awaiting_merge";

  // Nothing worth surfacing yet (a fresh/pending loop with no round, no error,
  // no PR, not at the gate) — keep the page lean and skip the panel.
  if (!loop.error && !loop.prRef && !awaiting && latest == null) return null;

  return (
    <Card className="border-amber-500/40">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Result</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Last-round degradation signal from `loop.error`. The CANCELLED and
            FAILED cases (where `error` IS the state explanation) are now owned by
            the top-of-page LoopStatusCallout — rendering them here too would
            duplicate. For every OTHER state (e.g. a stopped_cap/escalated round
            that recorded an error) this remains the amber "Last round error"
            note. INERT loop/user-authored content. */}
        {loop.error && loop.state !== "cancelled" && loop.state !== "failed" && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="font-medium text-amber-700 dark:text-amber-300">Last round error</p>
              {/* INERT loop/user-authored text */}
              <p className="text-amber-700/90 dark:text-amber-300/90 break-words">{loop.error}</p>
            </div>
          </div>
        )}

        {/* PR outcome — link when there is one, explicit note when there is not. */}
        {loop.prRef ? (
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">Draft PR ready for review</p>
              <p className="font-mono text-xs text-muted-foreground truncate">{loop.prRef}</p>
            </div>
            <a
              href={loop.prRef}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 shrink-0"
            >
              <ExternalLink className="h-4 w-4" />
              Open Draft PR
            </a>
          </div>
        ) : awaiting ? (
          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            The SDLC round produced{" "}
            <span className="font-medium text-foreground">no PR</span> — there is nothing
            to merge. {loop.error ? "See the error above" : "No error was recorded"}; you
            can cancel the loop, or approve to advance it against the current HEAD.
          </div>
        ) : null}

        {/* Latest round's verdict — what the human is deciding on. */}
        {latest && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Round {latest.round} verdict
              </span>
              <ConvergenceMark converged={latest.converged} terminal={terminal} />
              <span className={`tabular-nums font-medium ${p0ClassName(latest.openP0, terminal)}`}>
                {latest.openP0 ?? "—"} open P0
              </span>
            </div>
            {/* Finding #5 — trivial priority breakdown of the still-open remainder.
                A CONVERGED loop gets the dedicated actionable callout above; here
                we only enrich the OTHER terminal verdicts (stopped_cap/escalated,
                where the verdict is already front-and-center) with the counts. */}
            {loop.openRemainder && loop.state !== "converged" && (
              <p className="text-[11px] text-muted-foreground">
                Open remainder:{" "}
                {Object.entries(loop.openRemainder.byPriority)
                  .sort((a, b) => a[0].localeCompare(b[0]))
                  .map(([priority, count]) => `${count} ${priority}`)
                  .join(", ")}
              </p>
            )}
            {latestAps.length > 0 ? (
              <ul className="space-y-1.5">
                {latestAps.map((ap, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-sm"
                    data-testid="loop-ap-item"
                    data-priority={ap.priority ?? ""}
                  >
                    {ap.priority && (
                      <Badge className={`${PRIORITY_COLOR[ap.priority] ?? "bg-muted"} shrink-0`}>
                        {ap.priority}
                      </Badge>
                    )}
                    {/* INERT model-authored text */}
                    <span>{ap.title}</span>
                  </li>
                ))}
                <p className="text-[11px] text-muted-foreground/70">{PRIORITY_LEGEND}</p>
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No open action points recorded for this round.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Converged-with-remainder callout (finding #5) ──────────────────────────────
//
// Convergence is keyed on P0 BY DESIGN: a loop reaches `converged` the moment no
// P0 action point remains. The judge may still leave actionable non-P0 items
// (P1/P2/…) standing — historically they silently dropped out of the lifecycle
// unless an operator noticed the leftover verdict. This callout makes that
// remainder VISIBLE on a CONVERGED loop and one-click actionable by REUSING the
// existing develop-from-terminal flow (the SAME `useDevelopLoop` mutation the
// header "Hand off to SDLC" action drives — no duplicated logic, no FSM change).
// Renders NOTHING when the loop converged clean (no non-P0 remainder).
//
// SECURITY: `openRemainder` is server-computed from priority LABELS only (counts,
// no model prose) and rendered as inert React text.
function ConvergedRemainderCallout({
  remainder,
  canDevelop,
  developing,
  onDevelop,
}: {
  remainder: OpenRemainder | null | undefined;
  canDevelop: boolean;
  developing: boolean;
  onDevelop: () => void;
}) {
  const summary = summarizeNonP0Remainder(remainder);
  if (!summary) return null;
  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2 min-w-0">
          <Check className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />
          <div className="min-w-0 text-sm">
            <p className="font-medium">
              Converged with {summary.total} open non-P0 item
              {summary.total === 1 ? "" : "s"} ({summary.breakdown})
            </p>
            <p className="text-muted-foreground">
              Convergence is keyed on P0 by design — these lower-priority items are
              still open. Hand them off to run the existing develop-from-terminal round.
            </p>
          </div>
        </div>
        {canDevelop && (
          <Button size="sm" onClick={onDevelop} disabled={developing} className="shrink-0">
            {developing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Hammer className="mr-2 h-4 w-4" />
            )}
            Develop the remainder
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Report panel — the RESEARCH-archetype outcome surface (Stage 3) ────────────
//
// A `research` loop produces a RESEARCHED REPORT (not code, not a Draft PR;
// design §3.C/§5/§6). It reaches `awaiting_merge` with prRef:null (ResultPanel
// already handles that gate: "no PR — nothing to merge") and the structured
// report is persisted on the LATEST round → rendered here when present. A
// repo-assessment loop carries no `report` → this panel renders NOTHING, and the
// page never crashes pre-backend (until the backend lands `report` is absent).
//
// SECURITY: `question`, `recommendation`, `verdict`, every `claim`, and all
// citation/source `title`/`snippet` strings are MODEL-authored, web-derived
// output — rendered as INERT React text. Every external link uses
// target="_blank" rel="noopener noreferrer" and is marked with an ExternalLink
// glyph. Every optional field is guarded (?? "—" / hidden when empty); a link is
// only emitted for a non-empty `url`.

/** Format the optional ISO `generatedAt` into a relative label, or null. */
function formatReportTimestamp(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return `Generated ${formatDistanceToNow(d, { addSuffix: true })}`;
}

/**
 * The web-evidence mark on a claim. `true` → verified (green), `false` →
 * unverified (amber). Absent (`undefined`) means "not yet verified" → render
 * nothing, so an un-checked claim reads neutrally.
 */
function VerifiedMark({ verified }: { verified: boolean | undefined }) {
  if (verified === true) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] font-medium text-green-600 dark:text-green-400"
        title="Verified — the claim is backed by a citable source"
      >
        <ShieldCheck className="h-3.5 w-3.5" />
        verified
      </span>
    );
  }
  if (verified === false) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400"
        title="Not backed by a citable source"
      >
        <ShieldAlert className="h-3.5 w-3.5" />
        unverified
      </span>
    );
  }
  return null;
}

/**
 * Scheme allowlist for UNTRUSTED, model/web-derived citation + source URLs.
 * Returns the URL only when it parses (via `new URL`, post-trim) as `http:` or
 * `https:` (case-insensitive); otherwise null. A `javascript:` / `data:` /
 * `vbscript:` / other-scheme URI — which `rel="noopener noreferrer"` does NOT
 * neutralise — is rejected so a prompt-injected report can never turn a citation
 * into a clickable/navigable link that executes in the authenticated app origin.
 * `new URL` throwing on a malformed string is caught → null.
 */
function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (trimmed === "") return null;
  try {
    const scheme = new URL(trimmed).protocol.toLowerCase();
    return scheme === "http:" || scheme === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * One citation. The URL is model/web-derived and UNTRUSTED: it is emitted as a
 * clickable <a> ONLY when `safeHttpUrl` accepts it as http(s). Any other scheme
 * (or an absent/malformed url) degrades to an INERT <span> — same label + glyph,
 * but not linkified — so it can never navigate or execute on click.
 */
function CitationLink({ citation }: { citation: ResearchCitation }) {
  const label = citation.title?.trim() || citation.url;
  const tooltip = citation.snippet?.trim() || citation.url;
  const href = safeHttpUrl(citation.url);
  if (!href) {
    return (
      <span
        className="inline-flex max-w-full items-start gap-1 text-xs text-muted-foreground"
        title={tooltip}
      >
        <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
        {/* INERT citation title — non-http(s) url, NOT linkified (XSS guard) */}
        <span className="min-w-0 break-words">{label}</span>
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-start gap-1 text-xs text-primary hover:underline"
      title={tooltip}
    >
      <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
      {/* INERT model/web-authored citation title */}
      <span className="min-w-0 break-words">{label}</span>
    </a>
  );
}

/**
 * One bibliography source — same UNTRUSTED-url treatment as CitationLink: a
 * clickable <a> only for an http(s) url, else an inert <span>.
 */
function SourceLink({ source }: { source: ResearchSource }) {
  const label = source.title?.trim() || source.url;
  const href = safeHttpUrl(source.url);
  if (!href) {
    return (
      <span className="inline-flex max-w-full items-start gap-1 text-xs text-muted-foreground">
        <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
        {/* INERT source title — non-http(s) url, NOT linkified (XSS guard) */}
        <span className="min-w-0 break-words">{label}</span>
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-start gap-1 text-xs text-primary hover:underline"
    >
      <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
      {/* INERT model/web-authored source title */}
      <span className="min-w-0 break-words">{label}</span>
    </a>
  );
}

/**
 * A report is worth rendering only if it carries at least one meaningful field —
 * this both drives the "render only when present" gate AND hides an empty `{}`
 * that a defensive backend read might produce. Doubles as a type guard.
 */
function reportHasContent(
  r: ResearchReport | null | undefined,
): r is ResearchReport {
  if (!r || typeof r !== "object") return false;
  return Boolean(
    (typeof r.recommendation === "string" && r.recommendation.trim()) ||
      (typeof r.question === "string" && r.question.trim()) ||
      (typeof r.verdict === "string" && r.verdict.trim()) ||
      (Array.isArray(r.claims) && r.claims.length > 0) ||
      (Array.isArray(r.sources) && r.sources.length > 0),
  );
}

function ReportPanel({ report }: { report: ResearchReport }) {
  const claims = Array.isArray(report.claims) ? report.claims : [];
  const rawSources = Array.isArray(report.sources) ? report.sources : [];

  // Dedupe the bibliography by url (first title wins), dropping url-less rows.
  const dedupedSources = Array.from(
    rawSources
      .filter((s) => typeof s?.url === "string" && s.url.trim() !== "")
      .reduce((m, s) => {
        if (!m.has(s.url)) m.set(s.url, s);
        return m;
      }, new Map<string, { title: string; url: string }>())
      .values(),
  );

  const generatedAt = formatReportTimestamp(report.generatedAt);
  const hasRecommendation =
    typeof report.recommendation === "string" && report.recommendation.trim() !== "";

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FileText className="h-4 w-4 text-primary" />
            Research report
          </CardTitle>
          <div className="flex items-center gap-2">
            {report.verdict && report.verdict.trim() !== "" && (
              <Badge className="bg-primary/10 text-primary">{report.verdict}</Badge>
            )}
            {generatedAt && (
              <span className="text-[11px] text-muted-foreground">{generatedAt}</span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* The researched question (INERT) — hidden when absent. */}
        {report.question && report.question.trim() !== "" && (
          <div className="space-y-0.5">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Question
            </p>
            {/* INERT model-authored question text */}
            <p className="text-sm text-muted-foreground">{report.question}</p>
          </div>
        )}

        {/* Recommendation — the prominent takeaway (INERT). */}
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Recommendation
          </p>
          {/* INERT model-authored recommendation text */}
          <p className="mt-1 text-sm font-medium leading-relaxed">
            {hasRecommendation ? report.recommendation : "—"}
          </p>
        </div>

        {/* Claims + their web citations — hidden when there are none. */}
        {claims.length > 0 && (
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Claims &amp; evidence
            </p>
            <ul className="space-y-3">
              {claims.map((claim, i) => {
                const citations = Array.isArray(claim.citations)
                  ? claim.citations.filter(
                      (c) => typeof c?.url === "string" && c.url.trim() !== "",
                    )
                  : [];
                return (
                  <li key={i} className="space-y-1.5 rounded-md border border-border p-3">
                    <div className="flex items-start justify-between gap-2">
                      {/* INERT model-authored claim text */}
                      <span className="text-sm">{claim.claim ?? "—"}</span>
                      <span className="shrink-0">
                        <VerifiedMark verified={claim.verified} />
                      </span>
                    </div>
                    {citations.length > 0 ? (
                      <ul className="space-y-1 pl-1">
                        {citations.map((c, ci) => (
                          <li key={ci}>
                            <CitationLink citation={c} />
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        No sources provided.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Deduped bibliography — hidden when there are no linkable sources. */}
        {dedupedSources.length > 0 && (
          <div className="space-y-2">
            <p className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">
              <BookOpen className="h-3.5 w-3.5" />
              Sources
            </p>
            <ul className="space-y-1">
              {dedupedSources.map((s, i) => (
                <li key={i}>
                  <SourceLink source={s} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Develop progress — the live `developing` round surface ─────────────────────
//
// While the loop is in `developing`, the loop GET carries an OPTIONAL
// `devProgress` snapshot of the SDLC handoff (design §9). It is process-local
// and ephemeral, so EVERY subfield is read defensively — an early beat, a
// cross-instance read, or a post-restart read may carry none, and the panel
// degrades to a generic "developing…" line with the action-point total still
// shown (the count is known from the round, not the progress beat).
//
// SECURITY: `actionPointTitle` is model-authored verdict text rendered as INERT
// React text; the PR link uses rel="noopener noreferrer".

/**
 * Humanize the current SDLC phase into one English status line. Falls back to a
 * generic "developing…" whenever `devProgress` (or the specific phase) is absent.
 */
function humanizeDevPhase(progress: DevProgress | undefined, total: number): string {
  switch (progress?.phase) {
    case "committing":
      return "Committing…";
    case "final-verification": {
      // Stage A: whole-suite re-run against the final combined tree (+ a bounded fix
      // loop). Distinct from `committing` so it never reads as a frozen "Committing…".
      const fi = progress?.fixIteration;
      const fb = progress?.fixBudget;
      if (progress?.step === "fix-coder" && typeof fi === "number" && fi > 0) {
        const budget = typeof fb === "number" ? `/${fb}` : "";
        return `Final verification: fixing (fix ${fi}${budget})…`;
      }
      return "Final verification of the whole tree…";
    }
    case "pushing":
      return "Pushing the branch…";
    case "opening_pr":
      return "Opening the Draft PR…";
    case "done":
      return "Done — Draft PR opened.";
    case "coding": {
      const idx = progress?.actionPointIndex;
      const pos =
        typeof idx === "number" ? `${idx + 1}${total > 0 ? `/${total}` : ""}` : "";
      const title = progress?.actionPointTitle;
      const titlePart = title ? `: "${title}"` : "";
      return pos
        ? `Coding action point ${pos}${titlePart}`
        : `Coding action point${titlePart}`;
    }
    default:
      return "developing…";
  }
}

/** One action point's live status → its leading icon (reusing the page's idioms:
 *  a spinner for in-flight, Check/X for settled, muted Clock for not-yet-started). */
function ApStatusIcon({ status }: { status: NonNullable<DevProgress["aps"]>[number]["status"] }) {
  switch (status) {
    case "active":
      return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-label="in progress" />;
    case "completed":
      return <Check className="h-3.5 w-3.5 shrink-0 text-green-600" aria-label="done" />;
    case "partial":
      return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="partial" />;
    case "failed":
      return <X className="h-3.5 w-3.5 shrink-0 text-red-500" aria-label="failed" />;
    case "pending":
    default:
      return <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="queued" />;
  }
}

/** Humanize the running agent/skill step for the active-row badge. */
const DEV_STEP_LABELS: Record<NonNullable<DevProgress["step"]>, string> = {
  "test-author": "test author",
  coder: "coder",
  "test-runner": "test run",
  "fix-coder": "fix",
};

/**
 * The LIVE task list for the developing round: one row per action point (status
 * icon + INERT title), with a badge on the ACTIVE row naming the agent running now
 * (`step`) and, mid-fix-loop, the `fix k/N` iteration. Rendered only when the beat
 * carries `aps`; the panel degrades to the single-line phase view otherwise.
 *
 * SECURITY: every `title` is model-authored verdict text, server-sanitized and
 * rendered as INERT React text (never HTML, never a link/attribute).
 */
function DevTaskList({ progress }: { progress: DevProgress }) {
  const aps = progress.aps ?? [];
  if (aps.length === 0) return null;
  return (
    <ul className="space-y-1">
      {aps.map((ap) => {
        const isActive = ap.status === "active";
        return (
          <li key={ap.i} className="flex items-start gap-2 text-xs leading-relaxed">
            <span className="mt-0.5">
              <ApStatusIcon status={ap.status} />
            </span>
            <span className="min-w-0 flex-1 break-words">
              <span className={isActive ? "font-medium" : "text-muted-foreground"}>
                {ap.title || `action point #${ap.i}`}
              </span>
              {isActive && progress.step && (
                <Badge variant="secondary" className="ml-1.5 text-[10px] py-0 align-middle">
                  {DEV_STEP_LABELS[progress.step]}
                  {typeof progress.fixIteration === "number" && progress.fixIteration > 0 && (
                    <span className="ml-1 tabular-nums">
                      fix {progress.fixIteration}
                      {typeof progress.fixBudget === "number" ? `/${progress.fixBudget}` : ""}
                    </span>
                  )}
                </Badge>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function DevelopProgressPanel({
  loop,
  fallbackTotal,
}: {
  loop: ConsiliumLoopDetailRow;
  /** Verdict's action-point count — the stepper total when the beat omits it.
   *  NOTE: this is the FULL action-point count, NOT the round's P0-only number. */
  fallbackTotal: number;
}) {
  const progress = loop.devProgress;
  const total = progress?.actionPointTotal ?? fallbackTotal;
  const completedRaw =
    typeof progress?.completedCount === "number"
      ? Math.max(0, progress.completedCount)
      : undefined;
  const completed =
    completedRaw !== undefined && total > 0
      ? Math.min(completedRaw, total)
      : completedRaw;
  const pct =
    total > 0 && completed !== undefined ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
        {/* INERT model-authored action-point title inside the phase line */}
        <span>{humanizeDevPhase(progress, total)}</span>
      </div>

      {/* LIVE task list — one row per action point with agent + status + fix pass.
          Absent `aps` (old/degraded snapshot) ⇒ this renders nothing and the panel
          degrades to the phase line + progress bar above/below (today's view). */}
      {progress?.aps && progress.aps.length > 0 && <DevTaskList progress={progress} />}

      {total > 0 && (
        <div className="space-y-1">
          <Progress value={pct} className="h-2" />
          <div className="text-xs tabular-nums text-muted-foreground">
            {completed ?? 0}/{total} done
          </div>
        </div>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">
        The SDLC agent codes each action point in an isolated git worktree, commits
        one per item, then pushes the branch and opens a Draft PR. The agents don't
        merge — review and merge are up to you.
      </p>

      {/* Draft PR link appears once the executor has opened it (near completion). */}
      {loop.prRef && (
        <a
          href={loop.prRef}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm font-medium text-primary underline underline-offset-2"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open Draft PR
        </a>
      )}
    </div>
  );
}

// ─── Planned archetype (Stage 1, Piece B) ─────────────────────────────────────
//
// A small OBSERVE-AND-SET card surfacing the loop's planning archetype (design
// §3.B). Once the verdict is readable (the latest round carries action points)
// and no archetype is set yet, the page LAZILY classifies it ONCE via
// `POST /:id/plan` — a useRef keyed by loop id guards against re-firing on every
// 5s poll. The card shows the proposed archetype + the planner's INERT rationale,
// a Select to confirm/override (PATCH /:id/archetype), and a manual "Re-classify"
// (`?replan=1`). Nothing downstream consumes the archetype in Stage 1.
//
// BENIGN until the backend lands: the plan endpoint 404s pre-backend — the auto
// classify is silent/non-blocking (no toast, no crash), and a manual re-classify
// or override surfaces the server `error` text verbatim.

const ARCHETYPE_LABELS: Record<Archetype, string> = {
  "repo-assessment": "Repo assessment",
  research: "Research",
  infra: "Infra",
};

function ArchetypeSourceBadge({
  source,
}: {
  source: ConsiliumLoopDetailRow["archetypeSource"];
}) {
  if (!source) return null;
  const label = source === "override" ? "human override" : "proposed";
  return (
    <Badge variant="outline" className="text-[10px] font-normal">
      {label}
    </Badge>
  );
}

function PlannedArchetypeCard({
  loop,
  verdictReadable,
}: {
  loop: ConsiliumLoopDetailRow;
  /** The latest round carries action points → the verdict is classifiable. */
  verdictReadable: boolean;
}) {
  const { toast } = useToast();
  const planLoop = usePlanLoop();
  const setArchetype = useSetArchetype();

  // The Select choice, seeded from the loop's current archetype and re-seeded
  // whenever the server value changes (a successful plan / override lands).
  const [choice, setChoice] = useState<Archetype | "">(loop.archetype ?? "");
  useEffect(() => {
    setChoice(loop.archetype ?? "");
  }, [loop.archetype]);

  // Lazy classify: fire `POST /:id/plan` exactly ONCE per loop id, only when the
  // verdict is readable AND no archetype is set. The ref is set the moment we
  // fire (success OR benign 404), so a poll never re-triggers it; a manual
  // re-classify is the only retry. A loop arriving already-classified, or whose
  // verdict isn't readable yet, simply never auto-fires.
  const autoPlanned = useRef<string | null>(null);
  useEffect(() => {
    if (autoPlanned.current === loop.id) return;
    if (verdictReadable && loop.archetype == null) {
      autoPlanned.current = loop.id;
      // Silent + non-blocking: swallow the pre-backend 404 / any failure.
      planLoop.mutate({ id: loop.id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loop.id, loop.archetype, verdictReadable]);

  const planning = planLoop.isPending;

  async function handleReclassify() {
    try {
      await planLoop.mutateAsync({ id: loop.id, replan: true });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Couldn't classify",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleConfirm() {
    if (!choice || choice === loop.archetype) return;
    try {
      await setArchetype.mutateAsync({ id: loop.id, archetype: choice });
      toast({
        title: "Archetype updated",
        description: `Set to “${ARCHETYPE_LABELS[choice]}”.`,
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Couldn't set the archetype",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const dirty = !!choice && choice !== loop.archetype;
  const confirmLabel = loop.archetype ? "Change" : "Confirm";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Tag className="h-4 w-4 text-primary" />
            Planned archetype
            {loop.archetype && (
              <Badge className="bg-primary/10 text-primary">
                {ARCHETYPE_LABELS[loop.archetype]}
              </Badge>
            )}
            <ArchetypeSourceBadge source={loop.archetypeSource} />
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={handleReclassify}
            disabled={planning}
            title="Re-run the classifier (?replan=1)"
          >
            {planning ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
            )}
            Re-classify
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {planning && loop.archetype == null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Sparkles className="h-4 w-4 animate-pulse text-primary" />
            Classifying the verdict…
          </div>
        ) : loop.archetype == null ? (
          <p className="text-sm text-muted-foreground">
            The archetype isn't determined yet. Run classification or pick one manually.
          </p>
        ) : (
          loop.archetypeRationale && (
            // INERT planner-authored rationale.
            <p className="text-sm leading-relaxed text-muted-foreground">
              {loop.archetypeRationale}
            </p>
          )
        )}

        {/* INERT planner-extracted params, when present. */}
        {loop.archetypeParams && Object.keys(loop.archetypeParams).length > 0 && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
            {Object.entries(loop.archetypeParams).map(([k, v]) => (
              <div key={k} className="space-y-0.5">
                <dt className="uppercase tracking-wide text-muted-foreground/70">{k}</dt>
                <dd className="break-words">{v}</dd>
              </div>
            ))}
          </dl>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={choice}
            onValueChange={(v) => setChoice(v as Archetype)}
          >
            <SelectTrigger className="w-56" data-testid="archetype-select">
              <SelectValue placeholder="Pick an archetype" />
            </SelectTrigger>
            <SelectContent>
              {ARCHETYPES.map((a: Archetype) => (
                <SelectItem key={a} value={a}>
                  {ARCHETYPE_LABELS[a]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={handleConfirm}
            disabled={!dirty || setArchetype.isPending}
            data-testid="archetype-confirm"
          >
            {setArchetype.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-2 h-4 w-4" />
            )}
            {confirmLabel}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

// ─── GAP 1: Launch passport ──────────────────────────────────────────────────
//
// HOW this loop was launched, consolidated into one card: the review preset
// (server-recovered from the group name, via `composition`), createdAt/createdBy,
// the target repoPath + reviewRef, the round budget, and the optional human
// engineer instruction. Fields the loop already carried were scattered across
// "Key facts"; this makes the launch context first-class + legible.
//
// SECURITY: `engineerInstruction` is UNTRUSTED human text — rendered as INERT
// React text (never dangerouslySetInnerHTML). `createdBy` is server-masked for a
// non-admin (absent ⇒ "hidden").

function fmtRelative(raw: string | Date | null | undefined): { rel: string; abs: string } | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return { rel: formatDistanceToNow(d, { addSuffix: true }), abs: d.toLocaleString() };
}

function LaunchPassportCard({ loop }: { loop: ConsiliumLoopDetailRow }) {
  const created = fmtRelative(loop.createdAt);
  const preset = loop.composition?.preset ?? null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Rocket className="h-4 w-4 text-primary" aria-hidden="true" />
          Launch
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Fact label="Preset">
            {preset ? (
              <span className="font-mono text-xs">{preset}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Fact>
          <Fact label="Max rounds">
            <span className="tabular-nums">{loop.maxRounds}</span>
          </Fact>
          <Fact label="Created">
            {created ? (
              <span className="text-xs text-muted-foreground" title={created.abs}>
                {created.rel}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Fact>
          <Fact label="Created by">
            {loop.createdBy ? (
              <span className="font-mono text-xs">{loop.createdBy}</span>
            ) : (
              <span className="text-xs text-muted-foreground">hidden</span>
            )}
          </Fact>
          <Fact label="Review ref">
            {loop.reviewRef ? (
              <span className="inline-flex items-center gap-1 font-mono text-xs">
                <GitBranch className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                {loop.reviewRef}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">working-tree HEAD</span>
            )}
          </Fact>
          <Fact label="Repo">
            <span className="font-mono text-xs break-all" title={loop.repoPath}>
              {loop.repoPath}
            </span>
          </Fact>
        </dl>
        {/* Optional human steering captured at launch — INERT, fenced-as-text. */}
        {loop.engineerInstruction ? (
          <div className="space-y-1">
            <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              <FileText className="h-3 w-3" aria-hidden="true" />
              Engineer instruction
            </p>
            <p className="whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-xs">
              {loop.engineerInstruction}
            </p>
          </div>
        ) : null}
        {/* Stage 2 — the operator SKILLS whose directives extended the instruction.
            Applied skills render as solid badges; any skill DROPPED WHOLE to fit the
            byte budget renders muted with a note (it never truncated mid-skill). */}
        {loop.appliedSkills && loop.appliedSkills.length > 0 ? (
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              <Wrench className="h-3 w-3" aria-hidden="true" />
              Applied skills
            </p>
            <div className="flex flex-wrap gap-1.5" data-testid="passport-applied-skills">
              {loop.appliedSkills.map((s) =>
                s.dropped ? (
                  <Badge
                    key={s.id}
                    variant="outline"
                    className="text-[11px] text-muted-foreground line-through"
                    title="Dropped to fit the instruction size budget — not applied"
                  >
                    {s.name}
                  </Badge>
                ) : (
                  <Badge key={s.id} variant="secondary" className="text-[11px]">
                    {s.name}
                  </Badge>
                ),
              )}
            </div>
            {loop.appliedSkills.some((s) => s.dropped) ? (
              <p className="text-[11px] text-muted-foreground">
                Struck-through skills were dropped whole to fit the instruction size
                budget (never truncated mid-skill).
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ─── GAP 2: Composition ──────────────────────────────────────────────────────
//
// WHICH model/tool fills each role of a round — the dispute debaters + judge, the
// intent planner, the judge-timeout fallback, the SDLC coder, and the Stage-B
// verifier — plus the active verification config. All server-DECLARED (from the
// preset panel + config); the models that ACTUALLY ran surface per-participant in
// each round's Dispute + the live "Current round" section (which read the real
// execution rows), so this card is labelled to avoid preset-vs-actual drift.
//
// SECURITY: every value is a NAME or a BOOLEAN the server allowlisted — no secret
// reaches the client. Rendered as INERT text; the card has no links.

/** ms → a compact human duration (e.g. "20 min", "5 min", "45s"). */
function msLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms >= 60_000) {
    const min = ms / 60_000;
    return `${Number.isInteger(min) ? min : min.toFixed(1)} min`;
  }
  return `${Math.round(ms / 1000)}s`;
}

function EnabledPill({ on, label }: { on: boolean; label?: string }) {
  return (
    <Badge
      className={
        on
          ? "bg-green-600 text-white gap-1"
          : "bg-muted text-muted-foreground gap-1"
      }
    >
      {on ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
      {label ?? (on ? "on" : "off")}
    </Badge>
  );
}

function RoleRow({
  icon,
  role,
  detail,
}: {
  icon: React.ReactNode;
  role: CompositionRole;
  detail?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/40 py-1.5 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <span className="truncate text-sm">{role.label}</span>
        {role.enabled === false ? (
          <Badge className="bg-muted text-muted-foreground text-[10px]">disabled</Badge>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 text-right">
        {detail}
        {role.tool ? (
          <span className="text-[11px] text-muted-foreground">{role.tool}</span>
        ) : null}
        {role.model ? (
          <span className="font-mono text-xs">{role.model}</span>
        ) : !role.tool ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : null}
      </div>
    </div>
  );
}

function CompositionCard({ composition }: { composition: LoopComposition }) {
  const v = composition.verification;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Cpu className="h-4 w-4 text-primary" aria-hidden="true" />
          Composition
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-[11px] text-muted-foreground/80">
          Declared from the review preset + config. The models that actually ran
          appear per-participant in each round&rsquo;s Dispute (and the live Current
          round) below.
        </p>

        {/* Dispute panel + downstream roles → model/tool. */}
        <div className="rounded-md border px-3">
          {composition.debaters.map((d, i) => (
            <RoleRow
              key={`debater-${i}`}
              icon={<Users className="h-3.5 w-3.5" />}
              role={{ ...d, label: `Debater · ${d.label}` }}
            />
          ))}
          <RoleRow icon={<Gavel className="h-3.5 w-3.5" />} role={composition.judge} />
          <RoleRow
            icon={<Sparkles className="h-3.5 w-3.5" />}
            role={composition.planner}
          />
          <RoleRow icon={<Wrench className="h-3.5 w-3.5" />} role={composition.coder} />
          <RoleRow
            icon={<FlaskConical className="h-3.5 w-3.5" />}
            role={composition.verifier}
          />
          {/* Judge-timeout resilience: a single bounded retry + optional fallback. */}
          <div className="flex items-center justify-between gap-2 py-1.5">
            <div className="flex items-center gap-2">
              <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm">Judge retry</span>
            </div>
            <div className="flex items-center gap-2">
              <EnabledPill on={composition.judgeRetry.enabled} />
              {composition.judgeRetry.fallbackModel ? (
                <span className="font-mono text-xs">
                  {composition.judgeRetry.fallbackModel}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">same model</span>
              )}
            </div>
          </div>
        </div>

        {/* Active verification config — flags + commands + timeouts (no secrets). */}
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            <FlaskConical className="h-3 w-3" aria-hidden="true" />
            Verification config
          </p>
          <div className="flex flex-wrap gap-2">
            <EnabledPill on={v.implementEnabled} label={`skilled implement ${v.implementEnabled ? "on" : "off"}`} />
            <EnabledPill on={v.perCriterionMethodEnabled} label={`per-criterion ${v.perCriterionMethodEnabled ? "on" : "off"}`} />
            <EnabledPill on={v.effectiveVerificationEnabled} label={`test-run ${v.effectiveVerificationEnabled ? "on" : "off"}`} />
            <EnabledPill on={v.finalVerificationEnabled} label={`final verify ${v.finalVerificationEnabled ? "on" : "off"}`} />
          </div>
          {/* Surface intent-vs-effective when the operator asked for verification
              but the sandbox/trusted-repo gate withheld it (degrades to Stage-2a). */}
          {v.verificationEnabled && !v.effectiveVerificationEnabled ? (
            <p className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              verification requested but gated off (no sandbox / trusted-repo ack) — no test runs
            </p>
          ) : null}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Test command</dt>
              <dd className="font-mono break-all">{v.testCommand ?? "auto-detect"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Lint command</dt>
              <dd className="font-mono break-all">{v.lintCommand ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Test timeout</dt>
              <dd className="tabular-nums">{msLabel(v.testRunTimeoutMs)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">SDLC / AP timeout</dt>
              <dd className="tabular-nums">{msLabel(v.sdlcTimeoutMs)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Max fix iterations</dt>
              <dd className="tabular-nums">{v.maxFixIterations}</dd>
            </div>
          </dl>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── GAP 3: live "Current round" (the REVIEWING phase is no longer a black box) ─
//
// consilium_loop_rounds rows are written at DECIDE time, so while round N is being
// disputed there is NO round row yet → the per-round Dispute (below) can't render,
// exactly when the operator is watching. The loop row DOES carry the in-flight
// iteration (`currentIterationNumber`) the instant it enters REVIEWING, so we point
// the SAME IterationDetailView (#451) at it: per-participant execution cards with
// status / model / elapsed / expandable output as they land.
//
// Mounted ONLY while `reviewing`/`deciding` (so it unmounts — and stops polling —
// the moment the round settles into a row); IterationDetailView fetches lazily and
// polls on its own 3s cadence, so this adds no new polling machinery.
const LIVE_ROUND_STATES: ReadonlySet<ConsiliumLoopState> = new Set<ConsiliumLoopState>([
  "reviewing",
  "deciding",
]);

function LiveCurrentRound({ loop }: { loop: ConsiliumLoopDetailRow }) {
  if (!LIVE_ROUND_STATES.has(loop.state)) return null;
  const iter = loop.currentIterationNumber;
  if (iter == null || !loop.groupId) return null;
  return (
    <Card className="border-blue-500/40">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Radio className="h-4 w-4 animate-pulse text-blue-500" aria-hidden="true" />
          Current round (live) — {loop.state === "reviewing" ? "reviewing" : "deciding"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-[11px] text-muted-foreground/80">
          The dispute for round {loop.round || 1} is running (iteration #{iter}). Each
          row shows what its model is doing, for how long, and flags a stalled run.
        </p>
        <IterationDetailView
          groupId={loop.groupId}
          iterationNumber={iter}
          live={{ loopUpdatedAt: loop.updatedAt, roundLabel: loop.round || 1 }}
        />
      </CardContent>
    </Card>
  );
}

export default function ConsiliumLoopDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { user } = useAuth();
  const { toast } = useToast();
  const { data: loop, isLoading, error } = useConsiliumLoop(id);

  const startLoop = useStartLoop();
  const cancelLoop = useCancelLoop();
  const approveMerge = useApproveMerge();
  const developLoop = useDevelopLoop();
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading loop…
      </div>
    );
  }

  if (error || !loop) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
        <AlertTriangle className="h-6 w-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {error instanceof Error ? error.message : "Loop not found"}
        </p>
        <Link href="/consilium-loops">
          <span className="text-primary hover:underline text-sm">Back to loops</span>
        </Link>
      </div>
    );
  }

  const terminal = isTerminalLoopState(loop.state);
  const canStart = loop.state === "pending";
  const canCancel = !terminal;
  const canApprove = loop.state === "awaiting_merge";

  // Develop hand-off (design §9): a verdict-terminal loop whose latest verdict
  // still carries action points may be promoted into a VISIBLE `developing`
  // round. The server is the final arbiter (NO_ACTION_POINTS → 400); this gate
  // is the UX nicety. The full AP count (not the P0-only `openP0`) also seeds the
  // dev-progress stepper total when the live beat omits it.
  const sortedRounds = [...(Array.isArray(loop.rounds) ? loop.rounds : [])].sort(
    (a, b) => b.round - a.round,
  );
  const latestRound = sortedRounds[0];
  const latestActionPointCount = Array.isArray(latestRound?.openActionPoints)
    ? latestRound!.openActionPoints.length
    : 0;
  const canDevelop =
    isVerdictTerminalLoopState(loop.state) && latestActionPointCount > 0;

  // Stage 3 (research archetype): the structured report rides the LATEST round.
  // Present only for a `research` loop that has synthesized one (and only once
  // the parallel backend has shipped the `report` col) — otherwise absent, so
  // the panel simply does not render (no crash for repo-assessment loops).
  const latestReport = latestRound?.report;

  async function handleStart() {
    try {
      await startLoop.mutateAsync(id);
      toast({ title: "Loop started" });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Could not start loop",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleCancel() {
    try {
      await cancelLoop.mutateAsync(id);
      toast({ title: "Loop cancelled" });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Could not cancel loop",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleApproveMerge() {
    setConfirmOpen(false);
    try {
      await approveMerge.mutateAsync(id);
      toast({
        title: "Merge approved",
        description: "The loop is advancing to the next round.",
      });
    } catch (err) {
      if (isErrorWithStatus(err, 403)) {
        toast({
          variant: "destructive",
          title: "Not allowed",
          description: "Approving a merge requires the maintainer or admin role.",
        });
        return;
      }
      toast({
        variant: "destructive",
        title: "Could not approve merge",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleDevelop() {
    try {
      await developLoop.mutateAsync(id);
      toast({
        title: "Handed off to SDLC",
        description: "The developing round has started — follow the progress below.",
      });
    } catch (err) {
      // 400 (NO_ACTION_POINTS / REPO_NOT_*) | 409 (WRONG_STATE /
      // ACTIVE_LOOP_EXISTS / CAS_LOST) — and the pre-backend 404 — surface the
      // server `error` text verbatim.
      toast({
        variant: "destructive",
        title: "Could not start develop round",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const rounds = Array.isArray(loop.rounds) ? loop.rounds : [];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <header className="border-b border-border px-6 py-4 shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <Link href="/consilium-loops">
                <Repeat className="h-5 w-5 text-primary" />
              </Link>
              <h1 className="text-base font-semibold leading-tight truncate">
                Consilium Loop
              </h1>
              <LoopStateBadgeFor loop={loop} />
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">{loop.id}</p>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {canStart && (
              <Button size="sm" onClick={handleStart} disabled={startLoop.isPending}>
                {startLoop.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Play className="mr-2 h-4 w-4" />
                )}
                Start
              </Button>
            )}
            {canApprove && (
              <Button
                size="sm"
                onClick={() => setConfirmOpen(true)}
                disabled={approveMerge.isPending}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {approveMerge.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <GitMerge className="mr-2 h-4 w-4" />
                )}
                Approve merge &amp; continue
              </Button>
            )}
            {canDevelop && (
              <Button
                size="sm"
                onClick={handleDevelop}
                disabled={developLoop.isPending}
              >
                {developLoop.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Hammer className="mr-2 h-4 w-4" />
                )}
                Hand off to SDLC
              </Button>
            )}
            {canCancel && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleCancel}
                disabled={cancelLoop.isPending}
              >
                {cancelLoop.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Ban className="mr-2 h-4 w-4" />
                )}
                Cancel
              </Button>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6 space-y-5">
        {/* Status — a plain-English "what this state means and why the loop is
            here" for EVERY state (generalizes #466's cancel-reason callout). */}
        <LoopStatusCallout loop={loop} />

        {/* Result — the outcome the human gate decides on (near the top). */}
        <ResultPanel loop={loop} terminal={terminal} />

        {/* Finding #5 — a CONVERGED loop still carrying non-P0 action points
            surfaces them here + a one-click develop-from-terminal hand-off that
            reuses the SAME `useDevelopLoop` mutation as the header action. */}
        {loop.state === "converged" && (
          <ConvergedRemainderCallout
            remainder={loop.openRemainder}
            canDevelop={canDevelop}
            developing={developLoop.isPending}
            onDevelop={handleDevelop}
          />
        )}

        {/* Research report (Stage 3) — the researched outcome of a `research`
            loop, on the latest round. Rendered only when a report is present
            (repo-assessment loops render nothing here). */}
        {reportHasContent(latestReport) && <ReportPanel report={latestReport} />}

        {/* Planned archetype (Stage 1, observe-and-set) — shown once the verdict
            is readable; lazily classifies once + allows a human override. */}
        {latestActionPointCount > 0 && (
          <PlannedArchetypeCard
            loop={loop}
            verdictReadable={latestActionPointCount > 0}
          />
        )}

        {/* GAP 1 — Launch passport: HOW this loop was launched, consolidated. */}
        <LaunchPassportCard loop={loop} />

        {/* FSM progress */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Lifecycle</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <FsmStepper loop={loop} />
            {loop.state === "developing" && (
              <DevelopProgressPanel
                loop={loop}
                fallbackTotal={latestActionPointCount}
              />
            )}
          </CardContent>
        </Card>

        {/* GAP 3 — live "Current round": the in-flight dispute during
            reviewing/deciding, before any round row exists. Self-gates (renders
            nothing outside those states) and unmounts to stop polling. */}
        <LiveCurrentRound loop={loop} />

        {/* Key facts */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Key facts</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Fact label="Round">
                <span className="tabular-nums">
                  {loop.round}/{loop.maxRounds}
                </span>
              </Fact>
              <Fact label="Open P0">
                <span className={`tabular-nums font-medium ${p0ClassName(loop.openP0, terminal)}`}>
                  {loop.openP0 ?? "—"}
                </span>
              </Fact>
              <Fact label="Repo">
                <span className="font-mono text-xs break-all" title={loop.repoPath}>
                  {loop.repoPath}
                </span>
              </Fact>
              <Fact label="Consilium group">
                {/* The consilium group is internal machinery now (its standalone
                    page is retired) — shown as an inert identifier. The per-round
                    dispute lives in the Rounds table below. */}
                <span className="font-mono text-xs text-muted-foreground">
                  {loop.currentIterationNumber != null
                    ? `iter #${loop.currentIterationNumber}`
                    : loop.groupId.slice(0, 8)}
                </span>
              </Fact>
              <Fact label="DEV group">
                {loop.devGroupId ? (
                  <span className="font-mono text-xs text-muted-foreground">
                    {loop.devGroupId.slice(0, 8)}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </Fact>
              <Fact label="HEAD @ review">
                <span className="font-mono text-xs">{shortSha(loop.headCommitAtReview)}</span>
              </Fact>
              <Fact label="Last reviewed">
                <span className="font-mono text-xs">{shortSha(loop.lastReviewedCommit)}</span>
              </Fact>
              <Fact label="Updated">
                <span className="text-xs text-muted-foreground">
                  {loop.updatedAt
                    ? formatDistanceToNow(new Date(loop.updatedAt), { addSuffix: true })
                    : "—"}
                </span>
              </Fact>
            </dl>
          </CardContent>
        </Card>

        {/* GAP 2 — Composition: WHICH model/tool fills each role + the active
            verification config. Server-derived, read-only, secret-free; absent on
            a pre-composition backend or a degraded read, so render defensively. */}
        {loop.composition ? <CompositionCard composition={loop.composition} /> : null}

        {/* Rounds */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Rounds</CardTitle>
          </CardHeader>
          <CardContent>
            {rounds.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No rounds recorded yet.
              </p>
            ) : (
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Round</TableHead>
                      <TableHead>Converged</TableHead>
                      <TableHead>Open P0</TableHead>
                      <TableHead>Baseline → Head</TableHead>
                      <TableHead>Iteration</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...rounds]
                      .sort((a, b) => a.round - b.round)
                      .map((round) => (
                        <RoundRow
                          key={round.id}
                          round={round}
                          groupId={loop.groupId}
                          terminal={terminal}
                        />
                      ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {rounds.length > 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground/70">{PRIORITY_LEGEND}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Approve-merge confirm — the autonomy→production HITL gate */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Approve merge &amp; continue?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                {loop.prRef ? (
                  <span className="block">
                    You are approving the merge of autonomously-produced code toward{" "}
                    <strong>main</strong>. This advances the loop to its next round and
                    triggers a fresh review against the merged HEAD.
                  </span>
                ) : (
                  <span className="block">
                    This round produced <strong>no PR</strong>, so there is nothing to
                    merge. Approving simply advances the loop to its next round against the
                    current <strong>main</strong> HEAD — review the recorded error first.
                  </span>
                )}
                {loop.prRef && (
                  <a
                    href={loop.prRef}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-primary hover:underline text-sm font-mono break-all"
                  >
                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    {loop.prRef}
                  </a>
                )}
                <span className="block text-xs text-muted-foreground">
                  Requires the maintainer or admin role
                  {user?.role ? ` (you are: ${user.role})` : ""}.
                </span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleApproveMerge}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              Approve merge
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
