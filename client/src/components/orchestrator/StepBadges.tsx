/**
 * Small presentational badges for orchestrator steps + run status. Pure
 * presentational — all label/classification logic lives in @/lib/orchestrator.
 *
 * SECURITY: these render only enum-derived labels (step type / status), never
 * untrusted model text.
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STEP_LABELS } from "@/lib/orchestrator";
import type {
  OrchestratorStepType,
  OrchestratorStepStatus,
  OrchestratorRunStatus,
} from "@/lib/orchestrator";

const STEP_TYPE_CLASS: Record<OrchestratorStepType, string> = {
  research: "bg-sky-500/15 text-sky-600 border-sky-500/30",
  "analyze-code": "bg-violet-500/15 text-violet-600 border-violet-500/30",
  debate: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  ground: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  synthesize: "bg-primary/15 text-primary border-primary/30",
};

interface StepTypeBadgeProps {
  type: OrchestratorStepType;
}

export function StepTypeBadge({ type }: StepTypeBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 font-medium", STEP_TYPE_CLASS[type])}
      data-testid="step-type-badge"
      data-step-type={type}
    >
      {STEP_LABELS[type]}
    </Badge>
  );
}

const STEP_STATUS_META: Record<
  OrchestratorStepStatus,
  { label: string; className: string }
> = {
  pending: { label: "Pending", className: "text-muted-foreground" },
  running: { label: "Running", className: "text-amber-600" },
  completed: { label: "Completed", className: "text-emerald-600" },
  failed: { label: "Failed", className: "text-destructive" },
  skipped: { label: "Skipped", className: "text-muted-foreground/70 line-through" },
};

interface StepStatusBadgeProps {
  status: OrchestratorStepStatus;
}

export function StepStatusBadge({ status }: StepStatusBadgeProps) {
  const meta = STEP_STATUS_META[status];
  const isRunning = status === "running";
  return (
    <span
      className={cn("flex items-center gap-1.5 text-xs font-medium", meta.className)}
      data-testid="step-status"
      data-status={status}
    >
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 rounded-full bg-current",
          // Pulse only when running; respect reduced-motion.
          isRunning && "motion-safe:animate-pulse",
        )}
      />
      {meta.label}
    </span>
  );
}

const RUN_STATUS_META: Record<
  OrchestratorRunStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  planning: { label: "Planning", variant: "secondary" },
  awaiting_plan_approval: { label: "Awaiting approval", variant: "outline" },
  executing: { label: "Executing", variant: "default" },
  completed: { label: "Completed", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "outline" },
};

interface RunStatusBadgeProps {
  status: OrchestratorRunStatus;
}

export function RunStatusBadge({ status }: RunStatusBadgeProps) {
  const meta = RUN_STATUS_META[status];
  return (
    <Badge variant={meta.variant} data-testid="run-status-badge" data-status={status}>
      {meta.label}
    </Badge>
  );
}
