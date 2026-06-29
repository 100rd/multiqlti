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
 * SECURITY: every loop/round/AP text field (error, testSummary, action-point
 * titles/rationale) is model- or loop-authored and is rendered as INERT React
 * text. The PR link uses rel="noopener noreferrer".
 */
import { useState } from "react";
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
} from "lucide-react";
import {
  useConsiliumLoop,
  useStartLoop,
  useCancelLoop,
  useApproveMerge,
  isTerminalLoopState,
  type ConsiliumLoopRoundRow,
  type ConsiliumLoopDetail as ConsiliumLoopDetailRow,
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
import type { ConsiliumLoopState } from "@/hooks/use-consilium-loops";
import type { ActionPoint } from "@shared/types";

// Mirror verdict-panel's priority palette so the taxonomy never drifts.
const PRIORITY_COLOR: Record<string, string> = {
  P0: "bg-red-600 text-white",
  P1: "bg-orange-500 text-white",
  P2: "bg-yellow-500 text-black",
  P3: "bg-slate-500 text-white",
};

// Clarifies that the (intentionally red) P0 badge is a SEVERITY tier, not a
// failure status — so a wall of red P0s reads as "these are the critical items".
const PRIORITY_LEGEND =
  "P0–P3 — приоритет важности (P0 = критический), не статус выполнения.";

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
}: {
  converged: boolean | null | undefined;
  terminal: boolean;
}) {
  if (converged == null) return <span className="text-muted-foreground">—</span>;
  if (converged) return <Check className="h-4 w-4 text-green-600" />;
  return terminal ? (
    <X className="h-4 w-4 text-red-500" />
  ) : (
    <Clock className="h-4 w-4 text-amber-500" aria-label="in progress" />
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
//                             Context/Review/Decide done iff a round row exists,
//                             Develop iff devGroupId is set, Await iff prRef is set.

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
  devGroupId: string | null | undefined;
  prRef: string | null | undefined;
}): StepStatus[] {
  const { isLast, hasRoundRow, state, devGroupId, prRef } = args;

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
  const core: StepStatus = hasRoundRow ? "done" : "not_reached";
  return ROUND_STEPS.map((step) => {
    if (step.key === "developing") return devGroupId ? "done" : "not_reached";
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
          devGroupId: loop.devGroupId,
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

// ─── Rounds table ─────────────────────────────────────────────────────────────

function RoundRow({
  round,
  groupId,
  terminal,
}: {
  round: ConsiliumLoopRoundRow;
  groupId: string;
  terminal: boolean;
}) {
  const [open, setOpen] = useState(false);
  const aps: ActionPoint[] = Array.isArray(round.openActionPoints)
    ? round.openActionPoints
    : [];

  return (
    <>
      <TableRow
        className={aps.length > 0 ? "cursor-pointer" : ""}
        onClick={aps.length > 0 ? () => setOpen((v) => !v) : undefined}
      >
        <TableCell className="tabular-nums">
          <span className="inline-flex items-center gap-1">
            {aps.length > 0 &&
              (open ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              ))}
            {round.round}
          </span>
        </TableCell>
        <TableCell>
          <ConvergenceMark converged={round.converged} terminal={terminal} />
        </TableCell>
        <TableCell className={`tabular-nums font-medium ${p0ClassName(round.openP0, terminal)}`}>
          {round.openP0 ?? "—"}
        </TableCell>
        <TableCell className="font-mono text-xs whitespace-nowrap">
          {shortSha(round.baselineCommit)} → {shortSha(round.headCommit)}
        </TableCell>
        <TableCell>
          {/* iterationNumber is a per-group iteration INDEX, not a group id — the
              consilium group (loop.groupId) is the real, navigable target. App.tsx
              has no plain /task-groups/:id/iterations/:n route (only …/trace). */}
          <Link
            href={`/task-groups/${groupId}`}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-primary hover:underline text-xs">
              iter #{round.iterationNumber}
            </span>
          </Link>
        </TableCell>
      </TableRow>
      {open && aps.length > 0 && (
        <TableRow>
          <TableCell colSpan={5} className="bg-muted/30">
            <div className="space-y-2 py-1">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Still-open action points
              </p>
              <ul className="space-y-1.5">
                {aps.map((ap, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    {ap.priority && (
                      <Badge className={`${PRIORITY_COLOR[ap.priority] ?? "bg-muted"} shrink-0`}>
                        {ap.priority}
                      </Badge>
                    )}
                    {/* INERT model-authored text */}
                    <span>{ap.title}</span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted-foreground/70">{PRIORITY_LEGEND}</p>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ConsiliumLoopDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { user } = useAuth();
  const { toast } = useToast();
  const { data: loop, isLoading, error } = useConsiliumLoop(id);

  const startLoop = useStartLoop();
  const cancelLoop = useCancelLoop();
  const approveMerge = useApproveMerge();
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
        {/* FSM progress */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Lifecycle</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <FsmStepper loop={loop} />
            {loop.error && (
              <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/5 p-3 text-sm">
                <AlertTriangle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                {/* INERT loop-authored error text */}
                <span className="text-red-700 dark:text-red-300">{loop.error}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Draft PR call-out */}
        {loop.prRef && (
          <Card className="border-primary/40">
            <CardContent className="flex items-center justify-between gap-4 py-4">
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
            </CardContent>
          </Card>
        )}

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
                {loop.currentIterationNumber != null ? (
                  <Link href={`/task-groups/${loop.groupId}`}>
                    <span className="text-primary hover:underline font-mono text-xs">
                      iter #{loop.currentIterationNumber}
                    </span>
                  </Link>
                ) : (
                  <Link href={`/task-groups/${loop.groupId}`}>
                    <span className="text-primary hover:underline font-mono text-xs">
                      {loop.groupId.slice(0, 8)}
                    </span>
                  </Link>
                )}
              </Fact>
              <Fact label="DEV group">
                {loop.devGroupId ? (
                  <Link href={`/task-groups/${loop.devGroupId}`}>
                    <span className="text-primary hover:underline font-mono text-xs">
                      {loop.devGroupId.slice(0, 8)}
                    </span>
                  </Link>
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
                <span className="block">
                  You are approving the merge of autonomously-produced code toward{" "}
                  <strong>main</strong>. This advances the loop to its next round and
                  triggers a fresh review against the merged HEAD.
                </span>
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
