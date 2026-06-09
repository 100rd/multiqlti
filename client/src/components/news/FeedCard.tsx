/**
 * A single news item card (internal or external feed).
 *
 * SECURITY:
 *  - Every item-derived string (title, summary, whyRelevant, sourceName,
 *    provider, sourceUri) is UNTRUSTED and rendered as INERT React text — no
 *    dangerouslySetInnerHTML, no markdown-to-HTML.
 *  - `sourceUri` is only made a clickable anchor when `safeHttpsHref` proves it
 *    is an absolute https URL (M2); otherwise it is shown as plain text. Links
 *    use rel="noopener noreferrer" and are never auto-followed.
 *  - relevanceScore is a system-derived signal (RelevanceMeter), not user-set.
 */
import { ExternalLink, Sparkles } from "lucide-react";
import {
  CategoryBadge,
  SourceBadge,
  FreshnessBadge,
  RelevanceMeter,
} from "./badges";
import { FeedbackControls } from "./FeedbackControls";
import { safeHttpsHref } from "@/lib/news";
import { cn } from "@/lib/utils";
import type { NewsItem } from "@/hooks/use-news";

interface FeedCardProps {
  workspaceId: string;
  item: NewsItem;
}

export function FeedCard({ workspaceId, item }: FeedCardProps) {
  const href = safeHttpsHref(item.sourceUri);
  const isRead = item.readState === "read";

  return (
    <article
      className={cn(
        "group rounded-xl border bg-card p-4 transition-colors",
        "hover:border-primary/40",
        isRead ? "border-border/60 opacity-80" : "border-border",
      )}
      data-testid="feed-card"
      data-item-id={item.id}
      data-category={item.category}
      data-read-state={item.readState}
      aria-label={`${item.category} news item`}
    >
      {/* Meta row */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <CategoryBadge category={item.category} />
        <SourceBadge sourceName={item.sourceName} provider={item.provider} />
        <FreshnessBadge createdAt={item.createdAt} />
        <div className="ml-auto">
          <RelevanceMeter score={item.relevanceScore} />
        </div>
      </div>

      {/* Title — inert text */}
      <h3 className="text-base font-semibold leading-snug tracking-tight">
        {item.title}
      </h3>

      {/* Summary — inert text */}
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground whitespace-pre-line">
        {item.summary}
      </p>

      {/* Why relevant — inert text */}
      {item.whyRelevant && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <p className="text-xs leading-relaxed text-foreground/90">
            <span className="font-medium text-primary">Why this matters to you: </span>
            {item.whyRelevant}
          </p>
        </div>
      )}

      {/* Footer: source link (https-guarded) + feedback controls */}
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-3">
        <SourceLink uri={item.sourceUri} href={href} />
        <FeedbackControls workspaceId={workspaceId} item={item} />
      </div>
    </article>
  );
}

/**
 * Renders the source URI: an https-guarded anchor when safe, otherwise the
 * literal URI as inert text. Never auto-followed.
 */
function SourceLink({ uri, href }: { uri: string | null; href: string | null }) {
  if (!uri) return <span aria-hidden className="text-xs text-muted-foreground/50">—</span>;

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 truncate text-xs text-primary hover:underline"
        data-testid="source-link"
        title={href}
      >
        <ExternalLink className="h-3 w-3 shrink-0" />
        <span className="truncate">{uri}</span>
      </a>
    );
  }

  // Non-https / unparseable: render as inert plain text, NOT a link (M2).
  return (
    <span
      className="truncate text-xs text-muted-foreground"
      data-testid="source-unlinked"
      title="Source is not an https URL — shown as text, not linked"
    >
      {uri}
    </span>
  );
}
