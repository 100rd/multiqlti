/**
 * Card list with filters (status, reviewState, topic) and a selectable list of
 * compact card rows. Owns its filter state; fetches via usePracticeCards.
 */
import { useState } from "react";
import { Library, Filter } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  usePracticeCards,
  type PracticeCard,
  type PracticeCardFilters,
} from "@/hooks/use-practice-cards";
import {
  PRACTICE_CARD_STATUSES,
  PRACTICE_CARD_REVIEW_STATES,
} from "@shared/schema";
import { StatusBadge, ReviewStateBadge, FreshnessBadge } from "./CardBadges";
import {
  CardListSkeleton,
  QueryError,
  EmptyState,
  errorMessage,
} from "./QueryStates";
import { STATUS_LABELS, REVIEW_STATE_LABELS } from "@/lib/practice-cards";

const ALL = "__all__";

interface CardListProps {
  workspaceId: string;
  selectedCardId: string | null;
  onSelectCard: (card: PracticeCard) => void;
}

export function CardList({
  workspaceId,
  selectedCardId,
  onSelectCard,
}: CardListProps) {
  const [status, setStatus] = useState<string>(ALL);
  const [reviewState, setReviewState] = useState<string>(ALL);
  const [topic, setTopic] = useState("");

  const filters: PracticeCardFilters = {
    status: status === ALL ? undefined : (status as PracticeCardFilters["status"]),
    reviewState:
      reviewState === ALL
        ? undefined
        : (reviewState as PracticeCardFilters["reviewState"]),
    topic: topic.trim() || undefined,
  };

  const { data, isLoading, isError, error, refetch } = usePracticeCards(
    workspaceId,
    filters,
  );

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div
        className="flex flex-wrap items-center gap-2"
        role="search"
        aria-label="Card filters"
      >
        <Filter className="h-4 w-4 text-muted-foreground" />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger
            className="h-8 w-[150px]"
            data-testid="filter-status"
            aria-label="Filter by status"
          >
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {PRACTICE_CARD_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={reviewState} onValueChange={setReviewState}>
          <SelectTrigger
            className="h-8 w-[180px]"
            data-testid="filter-review-state"
            aria-label="Filter by review state"
          >
            <SelectValue placeholder="Review state" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All review states</SelectItem>
            {PRACTICE_CARD_REVIEW_STATES.map((r) => (
              <SelectItem key={r} value={r}>
                {REVIEW_STATE_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Filter by topic…"
          className="h-8 w-[200px]"
          data-testid="filter-topic"
          aria-label="Filter by topic"
        />
      </div>

      {/* Results */}
      {isLoading ? (
        <CardListSkeleton />
      ) : isError ? (
        <QueryError message={errorMessage(error)} onRetry={() => refetch()} />
      ) : !data || data.cards.length === 0 ? (
        <EmptyState
          icon={<Library className="h-10 w-10" />}
          title="No practice cards"
          description="No cards match these filters. Cards arrive via the ingestion pipeline and appear here once proposed."
        />
      ) : (
        <ul className="space-y-2" data-testid="card-list">
          {data.cards.map((card) => (
            <li key={card.id}>
              <CardRow
                card={card}
                selected={card.id === selectedCardId}
                onSelect={() => onSelectCard(card)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CardRow({
  card,
  selected,
  onSelect,
}: {
  card: PracticeCard;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-testid="card-row"
      data-card-id={card.id}
      className={cn(
        "w-full rounded-lg border px-4 py-3 text-left transition-colors",
        "hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary bg-primary/5" : "border-border",
      )}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <StatusBadge status={card.status} />
        <ReviewStateBadge reviewState={card.reviewState} />
        <FreshnessBadge lastVerifiedAt={card.lastVerifiedAt} />
      </div>
      <p className="text-sm font-medium leading-snug line-clamp-2">
        {card.statement}
      </p>
      <p className="mt-1 text-xs text-muted-foreground font-mono truncate">
        {card.topic}
      </p>
    </button>
  );
}
