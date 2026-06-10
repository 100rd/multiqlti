/**
 * Debate-research orchestrator — start + live run view.
 *
 * A thin, focused surface (not a heavy bespoke page) mirroring the morning-brief
 * route style. Two route shapes share this page:
 *   /workspaces/:id/orchestrator           → the start form
 *   /workspaces/:id/orchestrator/:runId    → the run view (plan gate, live
 *                                            progress, debates, research,
 *                                            synthesis)
 *
 * Disabled state: the orchestrator kill-switch has no client feature-flag
 * endpoint, so we discover it the way the brief specifies — a 503 from the start
 * endpoint flips this page to a friendly "orchestrator disabled" note instead of
 * a generic error.
 *
 * SECURITY: every model-/fetch-derived string surfaced here flows through child
 * components as INERT React text only (no HTML sink); external links are
 * https-guarded + rel="noopener noreferrer". See lib/orchestrator.ts.
 */
import { useMemo, type ReactNode } from "react";
import { useRoute, useLocation } from "wouter";
import { Bot, PowerOff } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FeedSkeleton, QueryError } from "@/components/news/QueryStates";
import { StartForm, type StartFormValues } from "@/components/orchestrator/StartForm";
import { PlanGate } from "@/components/orchestrator/PlanGate";
import { StepProgress } from "@/components/orchestrator/StepProgress";
import { DebatePanel } from "@/components/orchestrator/DebatePanel";
import { ResearchPanel } from "@/components/orchestrator/ResearchPanel";
import { SynthesisPanel } from "@/components/orchestrator/SynthesisPanel";
import { RunStatusBadge } from "@/components/orchestrator/StepBadges";
import {
  useStartOrchestrator,
  useOrchestratorStatus,
  useOrchestratorDebates,
  useOrchestratorResearch,
  useApproveOrchestratorPlan,
  useRejectOrchestratorPlan,
  useCancelOrchestratorRun,
  useOrchestratorLiveUpdates,
} from "@/hooks/use-orchestrator";
import {
  isAwaitingApproval,
  isRunActive,
  isRunTerminal,
  errorMessage,
  isOrchestratorDisabledError,
  type OrchestratorRunStatus,
  type OrchestratorStepArgs,
  type OrchestratorStep,
} from "@/lib/orchestrator";

const DEFAULT_TOKEN_BUDGET = 400_000;

export default function Orchestrator() {
  const [, runParams] = useRoute<{ id: string; runId: string }>(
    "/workspaces/:id/orchestrator/:runId",
  );
  const [, startParams] = useRoute<{ id: string }>(
    "/workspaces/:id/orchestrator",
  );
  const workspaceId = runParams?.id ?? startParams?.id ?? "";
  const runId = runParams?.runId ?? "";

  if (runId) {
    return <RunView workspaceId={workspaceId} runId={runId} />;
  }
  return <StartView workspaceId={workspaceId} />;
}

// ─── Start ──────────────────────────────────────────────────────────────────────

function StartView({ workspaceId }: { workspaceId: string }) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const start = useStartOrchestrator();

  const disabled = isOrchestratorDisabledError(start.error);

  function handleSubmit(values: StartFormValues) {
    start.mutate(values, {
      onSuccess: (result) => {
        toast({
          title: "Plan drafted",
          description: "Review and approve the plan to run it.",
        });
        setLocation(`/workspaces/${workspaceId}/orchestrator/${result.runId}`);
      },
      onError: (err) => {
        if (isOrchestratorDisabledError(err)) return; // handled by disabled state
        toast({
          variant: "destructive",
          title: "Could not start run",
          description: errorMessage(err),
        });
      },
    });
  }

  return (
    <Page title="Orchestrator">
      {disabled ? (
        <DisabledNote />
      ) : (
        <StartForm
          defaultWorkspaceId={workspaceId || undefined}
          isSubmitting={start.isPending}
          onSubmit={handleSubmit}
        />
      )}
    </Page>
  );
}

function DisabledNote() {
  return (
    <Card data-testid="orchestrator-disabled">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PowerOff className="h-4 w-4 text-muted-foreground" aria-hidden />
          Orchestrator is disabled
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          The debate-research orchestrator is turned off on this server. An
          administrator can enable it in the pipeline configuration. Your other
          run modes are unaffected.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Run view ─────────────────────────────────────────────────────────────────

function RunView({ workspaceId: _workspaceId, runId }: { workspaceId: string; runId: string }) {
  const { toast } = useToast();

  // Live updates: subscribe to the run's WS channel and refetch on events.
  useOrchestratorLiveUpdates(runId);

  const status = useOrchestratorStatus(runId);
  const run = status.data?.orchestratorRun ?? null;
  const awaiting = isAwaitingApproval(run);
  const terminal = isRunTerminal(run);

  // Debates + research are only meaningful once the run is past the gate.
  const detailsEnabled = !!run && !awaiting;
  const debates = useOrchestratorDebates(runId, detailsEnabled);
  const research = useOrchestratorResearch(runId, detailsEnabled);

  const approve = useApproveOrchestratorPlan();
  const reject = useRejectOrchestratorPlan();
  const cancel = useCancelOrchestratorRun();

  const steps = useMemo<OrchestratorStep[]>(
    () => status.data?.steps ?? [],
    [status.data],
  );
  const plan = useMemo<OrchestratorStepArgs[]>(
    () => [...steps].sort((a, b) => a.stepIndex - b.stepIndex).map((s) => s.args),
    [steps],
  );
  const groundSteps = useMemo(
    () => steps.filter((s) => s.type === "ground"),
    [steps],
  );
  const tokenBudget = DEFAULT_TOKEN_BUDGET;

  function handleApprove(editedSteps?: OrchestratorStepArgs[]) {
    approve.mutate(
      { runId, steps: editedSteps },
      {
        onSuccess: () => toast({ title: "Plan approved", description: "The run is executing." }),
        onError: (err) =>
          toast({ variant: "destructive", title: "Approve failed", description: errorMessage(err) }),
      },
    );
  }

  function handleReject() {
    reject.mutate(
      { runId },
      {
        onSuccess: () => toast({ title: "Plan rejected", description: "The run was cancelled." }),
        onError: (err) =>
          toast({ variant: "destructive", title: "Reject failed", description: errorMessage(err) }),
      },
    );
  }

  function handleCancel() {
    cancel.mutate(
      { runId },
      {
        onSuccess: () => toast({ title: "Run cancelled" }),
        onError: (err) =>
          toast({ variant: "destructive", title: "Cancel failed", description: errorMessage(err) }),
      },
    );
  }

  const headerActions =
    run && isRunActive(run) && !awaiting ? (
      <Button
        type="button"
        variant="outline"
        onClick={handleCancel}
        disabled={cancel.isPending}
        data-testid="run-cancel"
      >
        {cancel.isPending ? "Cancelling…" : "Cancel run"}
      </Button>
    ) : null;

  return (
    <Page title="Orchestrator run" status={run?.status} actions={headerActions}>
      {status.isError ? (
        <QueryError message={errorMessage(status.error)} onRetry={() => status.refetch()} />
      ) : status.isLoading ? (
        <FeedSkeleton rows={3} />
      ) : !run ? (
        <QueryError message="Orchestrator run not found." />
      ) : (
        <div className="space-y-6">
          {/* Plan gate — actionable only while awaiting approval. */}
          {(awaiting || run.status === "planning") && (
            <PlanGate
              plan={plan}
              tokenBudget={tokenBudget}
              awaitingApproval={awaiting}
              isApproving={approve.isPending}
              isRejecting={reject.isPending}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          )}

          {/* Once past the gate: live progress + detail tabs. */}
          {!awaiting && (
            <>
              <StepProgress
                steps={steps}
                totalTokensUsed={status.data?.totalTokensUsed ?? 0}
                tokenBudget={tokenBudget}
              />

              <Tabs defaultValue="synthesis">
                <TabsList>
                  <TabsTrigger value="synthesis" data-testid="tab-synthesis">
                    Synthesis
                  </TabsTrigger>
                  <TabsTrigger value="debates" data-testid="tab-debates">
                    Debates
                  </TabsTrigger>
                  <TabsTrigger value="research" data-testid="tab-research">
                    Research
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="synthesis">
                  {terminal || run.output != null ? (
                    <SynthesisPanel run={run} />
                  ) : (
                    <Card>
                      <CardContent className="py-6 text-center text-sm text-muted-foreground">
                        The final deliverable will appear here when the run completes.
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>

                <TabsContent value="debates">
                  {debates.isError ? (
                    <QueryError
                      message={errorMessage(debates.error)}
                      onRetry={() => debates.refetch()}
                    />
                  ) : debates.isLoading ? (
                    <FeedSkeleton rows={2} />
                  ) : (
                    <DebatePanel debates={debates.data ?? []} />
                  )}
                </TabsContent>

                <TabsContent value="research">
                  {research.isError ? (
                    <QueryError
                      message={errorMessage(research.error)}
                      onRetry={() => research.refetch()}
                    />
                  ) : research.isLoading ? (
                    <FeedSkeleton rows={2} />
                  ) : (
                    <ResearchPanel research={research.data ?? []} groundSteps={groundSteps} />
                  )}
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>
      )}
    </Page>
  );
}

// ─── Layout shell ─────────────────────────────────────────────────────────────

interface PageProps {
  title: string;
  status?: OrchestratorRunStatus;
  actions?: ReactNode;
  children: ReactNode;
}

function Page({ title, status, actions, children }: PageProps) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 py-4">
        <Bot className="h-5 w-5 text-muted-foreground" aria-hidden />
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {status && <RunStatusBadge status={status} />}
        {actions && <div className="ml-auto">{actions}</div>}
      </header>
      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-4xl">{children}</div>
      </div>
    </div>
  );
}
