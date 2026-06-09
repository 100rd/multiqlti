/**
 * "Affects you" panel — the board headline.
 *
 * Aggregates every internal item's `affects[]` (sourced ONLY from
 * blast_radius.impacted — Security C2) into one impact-ranked list, surfacing
 * which of YOUR platform entities are touched. impactScore/confidence are
 * system-derived signals. Entity names + dependency-path edges are UNTRUSTED
 * and rendered as INERT text only.
 *
 * Degraded / empty states are first-class: when Omniscience is unavailable the
 * page passes `degraded`, and we show a clear non-error note (not a failure).
 */
import { Crosshair, ArrowRight, ShieldOff } from "lucide-react";
import { ImpactBadge } from "./badges";
import { aggregateAffects, confidencePercent } from "@/lib/news";
import type { NewsItem } from "@/hooks/use-news";

interface AffectsPanelProps {
  items: NewsItem[];
  /** True when the internal/Omniscience feed is degraded (not an error). */
  degraded: boolean;
}

export function AffectsPanel({ items, degraded }: AffectsPanelProps) {
  const affects = aggregateAffects(items);

  return (
    <section
      className="rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/5 to-transparent p-5"
      aria-labelledby="affects-you-heading"
      data-testid="affects-you-panel"
      data-degraded={degraded ? "true" : "false"}
    >
      <header className="mb-3 flex items-center gap-2">
        <Crosshair className="h-5 w-5 text-amber-600" />
        <h2 id="affects-you-heading" className="text-base font-semibold tracking-tight">
          Affects your platform
        </h2>
        {!degraded && affects.length > 0 && (
          <span className="ml-auto rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold tabular-nums text-amber-600">
            {affects.length}
          </span>
        )}
      </header>

      {degraded ? (
        <DegradedNote />
      ) : affects.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="affects-empty">
          Nothing in today&apos;s brief is predicted to impact your platform
          entities. Blast-radius impact is computed from Omniscience, not
          inferred from article text.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="affects-list">
          {affects.map((a) => (
            <li
              key={`${a.itemId}-${a.entityId}-${a.entityType}`}
              className="rounded-lg border border-border bg-card/60 p-3"
              data-testid="affects-row"
              data-entity-id={a.entityId}
              data-impact-score={a.impactScore}
            >
              <div className="flex items-center gap-2">
                <ImpactBadge impactScore={a.impactScore} />
                <span className="font-mono text-sm font-medium">{a.entityId}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {a.entityType}
                </span>
                <span
                  className="ml-auto text-[11px] tabular-nums text-muted-foreground"
                  title="blast-radius confidence (system-derived)"
                >
                  {confidencePercent(a.confidence)}% conf.
                </span>
              </div>

              {a.path.length > 0 && <DependencyPath path={a.path} />}

              <p className="mt-1.5 truncate text-xs text-muted-foreground" title={a.itemTitle}>
                via: {a.itemTitle}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Inert-rendered dependency path (entity names from blast_radius). */
function DependencyPath({
  path,
}: {
  path: Array<{ fromEntity: string; toEntity: string; edgeType: string }>;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
      <span className="font-mono">{path[0]?.fromEntity}</span>
      {path.map((step, i) => (
        <span key={`${step.fromEntity}-${step.toEntity}-${i}`} className="flex items-center gap-1">
          <ArrowRight className="h-3 w-3 opacity-60" />
          <span className="rounded bg-muted px-1 text-[10px]">{step.edgeType}</span>
          <ArrowRight className="h-3 w-3 opacity-60" />
          <span className="font-mono">{step.toEntity}</span>
        </span>
      ))}
    </div>
  );
}

function DegradedNote() {
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
      role="note"
      data-testid="affects-degraded"
    >
      <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        The &quot;affects you&quot; signal needs the internal Omniscience feed,
        which is currently unavailable. Blast-radius impact will appear once it is
        configured.
      </p>
    </div>
  );
}
