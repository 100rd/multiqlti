/**
 * Semantic search over practice cards. Submits an explicit query (not
 * search-as-you-type) and renders hydrated hits with their similarity score.
 */
import { useState } from "react";
import { Search, SearchX } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  usePracticeCardSearch,
  type PracticeCard,
} from "@/hooks/use-practice-cards";
import { StatusBadge, FreshnessBadge } from "./CardBadges";
import {
  CardListSkeleton,
  QueryError,
  EmptyState,
  errorMessage,
} from "./QueryStates";

interface SearchPanelProps {
  workspaceId: string;
  onSelectCard: (card: PracticeCard) => void;
}

export function SearchPanel({ workspaceId, onSelectCard }: SearchPanelProps) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");

  const { data, isLoading, isError, error, refetch, isFetched } =
    usePracticeCardSearch(workspaceId, query);

  function submit() {
    setQuery(draft.trim());
  }

  return (
    <div className="space-y-4">
      <form
        role="search"
        aria-label="Semantic card search"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex gap-2"
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search practice cards semantically…"
          aria-label="Search query"
          data-testid="search-input"
        />
        <Button type="submit" disabled={!draft.trim()} data-testid="search-submit">
          <Search className="mr-2 h-4 w-4" />
          Search
        </Button>
      </form>

      {!query ? (
        <p className="text-sm text-muted-foreground">
          Enter a query to find related practice cards by meaning, not keywords.
        </p>
      ) : isLoading ? (
        <CardListSkeleton rows={3} />
      ) : isError ? (
        <QueryError message={errorMessage(error)} onRetry={() => refetch()} />
      ) : isFetched && (!data || data.length === 0) ? (
        <EmptyState
          icon={<SearchX className="h-10 w-10" />}
          title="No matches"
          description="No cards scored above the relevance threshold for this query."
        />
      ) : (
        <ul className="space-y-2" data-testid="search-results">
          {data?.map((hit) => (
            <li key={hit.card.id}>
              <button
                type="button"
                onClick={() => onSelectCard(hit.card)}
                className="w-full rounded-lg border border-border px-4 py-3 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="search-result"
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <StatusBadge status={hit.card.status} />
                    <FreshnessBadge lastVerifiedAt={hit.card.lastVerifiedAt} />
                  </div>
                  <Badge
                    variant="secondary"
                    className="shrink-0 text-xs tabular-nums"
                  >
                    {Math.round(hit.score * 100)}% match
                  </Badge>
                </div>
                <p className="text-sm font-medium leading-snug line-clamp-2">
                  {hit.card.statement}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
