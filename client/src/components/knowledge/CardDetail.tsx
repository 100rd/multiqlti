/**
 * Full detail view for a single practice card: statement, rationale, scope,
 * cited sources (version + fetched date), confidence, freshness, status, the
 * supersession graph, and adversarial-curation provenance.
 *
 * Security (G4 / MEDIUM): every card-derived string here is UNREVIEWED,
 * agent-supplied content (a card may be in any reviewState). It is rendered
 * INERT — as plain JSX text children only. No dangerouslySetInnerHTML, no
 * markdown-to-HTML. Source URLs are shown as their literal text and, when
 * linked, use rel="noopener noreferrer" + target="_blank"; they are never
 * auto-followed. Confidence is presented as agent-reported (see ConfidenceMeter).
 */
import { ExternalLink, Link2, User, ShieldCheck, ArrowRightLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  StatusBadge,
  ReviewStateBadge,
  FreshnessBadge,
  ConfidenceMeter,
} from "./CardBadges";
import type { PracticeCard } from "@/hooks/use-practice-cards";

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
      {children}
    </p>
  );
}

function ScopeChips({ card }: { card: PracticeCard }) {
  const appliesTo = card.appliesTo ?? { tool: "" };
  const tool = appliesTo.tool ?? "";
  const resourceKinds = appliesTo.resourceKinds ?? [];
  const tags = appliesTo.tags ?? [];
  return (
    <div className="flex flex-wrap gap-1.5">
      {tool && (
        <Badge variant="secondary" className="text-xs font-mono">
          {tool}
        </Badge>
      )}
      {resourceKinds.map((k) => (
        <Badge key={`rk-${k}`} variant="outline" className="text-xs font-mono">
          {k}
        </Badge>
      ))}
      {tags.map((t) => (
        <Badge key={`tag-${t}`} variant="outline" className="text-xs">
          #{t}
        </Badge>
      ))}
      {!tool && resourceKinds.length === 0 && tags.length === 0 && (
        <span className="text-xs text-muted-foreground">No scope declared</span>
      )}
    </div>
  );
}

interface CardDetailProps {
  card: PracticeCard;
  /** Resolve a related card id to a name/statement for supersession links. */
  resolveCardLabel?: (id: string) => string | undefined;
  onSelectCard?: (id: string) => void;
}

export function CardDetail({
  card,
  resolveCardLabel,
  onSelectCard,
}: CardDetailProps) {
  return (
    <article
      className="space-y-5"
      aria-label="Practice card detail"
      data-testid="card-detail"
      data-card-id={card.id}
    >
      {/* Header: badges */}
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={card.status} />
        <ReviewStateBadge reviewState={card.reviewState} />
        <FreshnessBadge lastVerifiedAt={card.lastVerifiedAt} />
        <ConfidenceMeter confidence={card.confidence} />
      </div>

      {/* Statement — inert text (unreviewed, agent-supplied) */}
      <div className="space-y-1.5">
        <SectionLabel>Statement</SectionLabel>
        <h2 className="text-base font-semibold leading-snug">{card.statement}</h2>
      </div>

      {/* Rationale — inert text (unreviewed, agent-supplied) */}
      <div className="space-y-1.5">
        <SectionLabel>Rationale</SectionLabel>
        <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
          {card.rationale}
        </p>
      </div>

      <Separator />

      {/* Scope */}
      <div className="space-y-2">
        <SectionLabel>Applies to</SectionLabel>
        <ScopeChips card={card} />
      </div>

      {/* Sources — URL shown as literal text; link is rel="noopener noreferrer",
          target="_blank", never auto-followed */}
      <div className="space-y-2">
        <SectionLabel>Cited sources</SectionLabel>
        {card.sources.length === 0 ? (
          <p className="text-xs text-muted-foreground">No sources cited.</p>
        ) : (
          <ul className="space-y-1.5">
            {card.sources.map((s, i) => (
              <li
                key={`${s.url}-${i}`}
                className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm text-primary hover:underline break-all"
                >
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                  {s.url}
                </a>
                <div className="flex shrink-0 flex-col items-end gap-0.5 text-[11px] text-muted-foreground">
                  {s.sourceVersion && (
                    <span className="font-mono">{s.sourceVersion}</span>
                  )}
                  <span>fetched {formatDate(s.fetchedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Supersession graph */}
      {(card.supersedes.length > 0 || card.supersededBy.length > 0) && (
        <>
          <Separator />
          <div className="space-y-2">
            <SectionLabel>Supersession</SectionLabel>
            <SupersedeLinks
              ids={card.supersedes}
              direction="replaces"
              resolveCardLabel={resolveCardLabel}
              onSelectCard={onSelectCard}
            />
            <SupersedeLinks
              ids={card.supersededBy}
              direction="replaced-by"
              resolveCardLabel={resolveCardLabel}
              onSelectCard={onSelectCard}
            />
          </div>
        </>
      )}

      <Separator />

      {/* Provenance: adversarial curation */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <SectionLabel>Proposed by</SectionLabel>
          <p className="flex items-center gap-1.5 text-sm">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-mono">{card.ingestedBy}</span>
          </p>
        </div>
        <div className="space-y-1">
          <SectionLabel>Verified by</SectionLabel>
          <p className="flex items-center gap-1.5 text-sm">
            <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-mono">{card.verifiedBy ?? "—"}</span>
          </p>
        </div>
      </div>
    </article>
  );
}

function SupersedeLinks({
  ids,
  direction,
  resolveCardLabel,
  onSelectCard,
}: {
  ids: string[];
  direction: "replaces" | "replaced-by";
  resolveCardLabel?: (id: string) => string | undefined;
  onSelectCard?: (id: string) => void;
}) {
  if (ids.length === 0) return null;
  const label = direction === "replaces" ? "Replaces" : "Replaced by";
  const Icon = direction === "replaces" ? ArrowRightLeft : Link2;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}:
      </span>
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelectCard?.(id)}
          disabled={!onSelectCard}
          className="rounded border border-border px-2 py-0.5 text-xs font-mono hover:border-primary/50 hover:text-primary disabled:cursor-default disabled:hover:border-border disabled:hover:text-inherit transition-colors"
        >
          {resolveCardLabel?.(id) ?? id.slice(0, 8)}
        </button>
      ))}
    </div>
  );
}
