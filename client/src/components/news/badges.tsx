/**
 * Small presentational badges for the Morning Brief: category, freshness,
 * relevance meter, and a blast-radius impact badge. Kept pure — all
 * classification logic lives in @/lib/news.
 *
 * SECURITY: relevance / impact are SYSTEM-DERIVED signals (ranker /
 * blast_radius), surfaced as such (labelled, never presented as a user score).
 */
import { Radio, Globe, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  computeFreshness,
  freshnessLabel,
  relevanceBand,
  relevancePercent,
  impactBand,
  impactPercent,
  type ImpactBand,
} from "@/lib/news";
import type { NewsCategory } from "@/hooks/use-news";

// ─── Category ─────────────────────────────────────────────────────────────────

const CATEGORY_META: Record<
  NewsCategory,
  { label: string; className: string; icon: React.ReactNode }
> = {
  internal: {
    label: "Internal",
    className: "bg-violet-500/15 text-violet-600 border-violet-500/30",
    icon: <Radio className="h-3 w-3" />,
  },
  external: {
    label: "External",
    className: "bg-sky-500/15 text-sky-600 border-sky-500/30",
    icon: <Globe className="h-3 w-3" />,
  },
};

export function CategoryBadge({ category }: { category: NewsCategory }) {
  const meta = CATEGORY_META[category];
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 text-xs", meta.className)}
      data-testid={`category-badge-${category}`}
    >
      {meta.icon}
      {meta.label}
    </Badge>
  );
}

// ─── Source / provider ────────────────────────────────────────────────────────

/** Provider/source name shown as inert text (untrusted). */
export function SourceBadge({
  sourceName,
  provider,
}: {
  sourceName: string | null;
  provider: string | null;
}) {
  const label = sourceName ?? provider;
  if (!label) return null;
  return (
    <Badge variant="secondary" className="text-xs font-mono" data-testid="source-badge">
      {label}
    </Badge>
  );
}

// ─── Freshness ────────────────────────────────────────────────────────────────

export function FreshnessBadge({
  createdAt,
  now,
}: {
  createdAt: string | null | undefined;
  now?: Date;
}) {
  const info = computeFreshness(createdAt, now);
  return (
    <span
      className="flex items-center gap-1 text-[11px] text-muted-foreground"
      data-testid="freshness-badge"
      data-freshness={info.freshness}
      title={freshnessLabel(info)}
    >
      <Clock className="h-3 w-3" />
      {freshnessLabel(info)}
    </span>
  );
}

// ─── Relevance meter ──────────────────────────────────────────────────────────

const RELEVANCE_BAR: Record<string, string> = {
  high: "bg-emerald-500",
  medium: "bg-amber-500",
  low: "bg-muted-foreground/40",
};

/**
 * System-derived relevance (ranker output). Explicitly labelled "match" and
 * presented as a signal, never as a user-authoritative score.
 */
export function RelevanceMeter({ score }: { score: number }) {
  const pct = relevancePercent(score);
  const band = relevanceBand(score);
  return (
    <div
      className="flex items-center gap-2"
      title={`System relevance ${pct}% (ranker signal, not user-set)`}
      data-testid="relevance-meter"
      data-relevance-band={band}
    >
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        match
      </span>
      <div
        className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label="System-derived relevance signal"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-300", RELEVANCE_BAR[band])}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

// ─── Impact ───────────────────────────────────────────────────────────────────

const IMPACT_CLASSES: Record<ImpactBand, string> = {
  high: "bg-destructive/10 text-destructive border-destructive/30",
  medium: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  low: "bg-muted text-muted-foreground border-border",
};

/**
 * Blast-radius impact badge. `impactScore` is SYSTEM-DERIVED from
 * blast_radius.impacted (Security C2) — surfaced as a signal, never user-set.
 */
export function ImpactBadge({ impactScore }: { impactScore: number }) {
  const band = impactBand(impactScore);
  const pct = impactPercent(impactScore);
  return (
    <Badge
      variant="outline"
      className={cn("text-xs tabular-nums", IMPACT_CLASSES[band])}
      data-testid="impact-badge"
      data-impact-band={band}
      title={`Blast-radius impact ${pct}% (system-derived)`}
    >
      {pct}%
    </Badge>
  );
}
