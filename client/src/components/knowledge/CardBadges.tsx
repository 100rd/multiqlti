/**
 * Small presentational badges for practice cards: status, review-state,
 * freshness, and a confidence meter. Kept presentational and pure — all
 * classification logic lives in @/lib/practice-cards.
 */
import { Clock, ShieldAlert, ShieldCheck, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  computeFreshness,
  freshnessLabel,
  confidenceBand,
  confidencePercent,
  STATUS_LABELS,
  REVIEW_STATE_LABELS,
  type Freshness,
} from "@/lib/practice-cards";
import type {
  PracticeCardStatus,
  PracticeCardReviewState,
} from "@/hooks/use-practice-cards";

// ─── Status ─────────────────────────────────────────────────────────────────

const STATUS_CLASSES: Record<PracticeCardStatus, string> = {
  active: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  superseded: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  deprecated: "bg-muted text-muted-foreground border-border",
};

export function StatusBadge({ status }: { status: PracticeCardStatus }) {
  return (
    <Badge
      variant="outline"
      className={cn("text-xs", STATUS_CLASSES[status])}
      data-testid={`card-status-${status}`}
    >
      {STATUS_LABELS[status]}
    </Badge>
  );
}

// ─── Review state ──────────────────────────────────────────────────────────

const REVIEW_CLASSES: Record<PracticeCardReviewState, string> = {
  pending_verification: "bg-slate-500/15 text-slate-600 border-slate-500/30",
  pending_review: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  accepted: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  rejected: "bg-destructive/10 text-destructive border-destructive/30",
};

export function ReviewStateBadge({
  reviewState,
}: {
  reviewState: PracticeCardReviewState;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("text-xs", REVIEW_CLASSES[reviewState])}
      // Stable marker so QA can assert review-state (e.g. pending_review).
      data-testid={`review-state-${reviewState}`}
      data-review-state={reviewState}
    >
      {REVIEW_STATE_LABELS[reviewState]}
    </Badge>
  );
}

// ─── Freshness ─────────────────────────────────────────────────────────────

const FRESHNESS_META: Record<
  Freshness,
  { className: string; icon: React.ReactNode }
> = {
  fresh: {
    className: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
    icon: <ShieldCheck className="h-3 w-3" />,
  },
  aging: {
    className: "bg-amber-500/15 text-amber-600 border-amber-500/30",
    icon: <Clock className="h-3 w-3" />,
  },
  stale: {
    className: "bg-destructive/10 text-destructive border-destructive/30",
    icon: <ShieldAlert className="h-3 w-3" />,
  },
  never_verified: {
    className: "bg-destructive/10 text-destructive border-destructive/30",
    icon: <AlertTriangle className="h-3 w-3" />,
  },
};

export function FreshnessBadge({
  lastVerifiedAt,
  now,
}: {
  lastVerifiedAt: Date | string | null | undefined;
  now?: Date;
}) {
  const info = computeFreshness(lastVerifiedAt, now);
  const meta = FRESHNESS_META[info.freshness];
  return (
    <Badge
      variant="outline"
      className={cn("text-xs gap-1", meta.className)}
      data-testid="freshness-badge"
      data-freshness={info.freshness}
      data-stale={info.isStale ? "true" : "false"}
      title={freshnessLabel(info)}
    >
      {meta.icon}
      {freshnessLabel(info)}
    </Badge>
  );
}

// ─── Confidence ────────────────────────────────────────────────────────────

const CONFIDENCE_BAR: Record<string, string> = {
  high: "bg-emerald-500",
  medium: "bg-amber-500",
  low: "bg-destructive",
};

/**
 * Agent-reported confidence (Security G4 / LOW: non-authoritative). The value
 * is self-declared by the proposing agent, not a verified score, so it is
 * explicitly labelled "agent" and never presented as a hard score.
 */
export function ConfidenceMeter({ confidence }: { confidence: number }) {
  const pct = confidencePercent(confidence);
  const band = confidenceBand(confidence);
  return (
    <div
      className="flex items-center gap-2"
      title={`Agent-reported confidence ${pct}% (self-declared, not verified)`}
      data-testid="confidence-meter"
      data-confidence-band={band}
    >
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        agent
      </span>
      <div
        className="h-1.5 w-20 rounded-full bg-muted overflow-hidden"
        role="meter"
        aria-label="Agent-reported confidence (self-declared, not verified)"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300",
            CONFIDENCE_BAR[band],
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">{pct}%</span>
    </div>
  );
}
