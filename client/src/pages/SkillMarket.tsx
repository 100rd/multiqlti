import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, ShoppingBag, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  useSkillMarketSearch,
  useSkillMarketSources,
  useSkillMarketInstall,
} from "@/hooks/useSkillMarket";
import type { SkillMarketSearchResult } from "@/hooks/useSkillMarket";
import { SkillMarketCard } from "@/components/skill-market/SkillCard";
import { SkillMarketDetailModal } from "@/components/skill-market/SkillMarketDetailModal";
import { cn } from "@/lib/utils";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 300;
const DEFAULT_LIMIT = 20;

const SORT_OPTIONS = [
  { value: "relevance", label: "Relevance" },
  { value: "popularity", label: "Most Popular" },
  { value: "newest", label: "Newest" },
] as const;

// ─── Component ───────────────────────────────────────────────────────────────

export default function SkillMarket() {
  const { toast } = useToast();

  // ── Search state ────────────────────────────────────────────────────────
  const [inputValue, setInputValue] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [sort, setSort] = useState<string>("relevance");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Detail modal state ──────────────────────────────────────────────────
  const [selectedSkill, setSelectedSkill] =
    useState<SkillMarketSearchResult | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // ── Debounce search input ───────────────────────────────────────────────
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(inputValue);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [inputValue]);

  // ── Data fetching ───────────────────────────────────────────────────────
  const searchOpts = useMemo(
    () => ({
      sources: selectedSources.length > 0 ? selectedSources : undefined,
      limit: DEFAULT_LIMIT,
      sort,
    }),
    [selectedSources, sort],
  );

  const {
    data: searchData,
    isLoading: isSearching,
    error: searchError,
  } = useSkillMarketSearch(debouncedQuery, searchOpts);

  const { data: sources = [] } = useSkillMarketSources();

  const installMutation = useSkillMarketInstall();

  // ── Handlers ────────────────────────────────────────────────────────────
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setInputValue(e.target.value);
    },
    [],
  );

  const toggleSource = useCallback((sourceId: string) => {
    setSelectedSources((prev) =>
      prev.includes(sourceId)
        ? prev.filter((s) => s !== sourceId)
        : [...prev, sourceId],
    );
  }, []);

  const clearSourceFilter = useCallback(() => {
    setSelectedSources([]);
  }, []);

  const handleInstall = useCallback(
    (externalId: string, source: string) => {
      installMutation.mutate(
        { externalId, source },
        {
          onSuccess: (result) => {
            toast({
              title: "Skill installed",
              description: `Installed ${result.externalId} from ${result.source}.`,
            });
          },
          onError: (err: Error) => {
            toast({
              title: "Install failed",
              description: err.message,
              variant: "destructive",
            });
          },
        },
      );
    },
    [installMutation, toast],
  );

  const handleSelectSkill = useCallback((skill: SkillMarketSearchResult) => {
    setSelectedSkill(skill);
    setDetailOpen(true);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setDetailOpen(false);
    setSelectedSkill(null);
  }, []);

  // ── Derived ─────────────────────────────────────────────────────────────
  const results = searchData?.results ?? [];
  const total = searchData?.total ?? 0;

  const hasActiveFilters =
    inputValue.length > 0 || selectedSources.length > 0 || sort !== "relevance";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="h-16 border-b border-border flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-2">
          <ShoppingBag className="h-5 w-5 text-primary" />
          <h1 className="text-base font-semibold">Skill Market</h1>
          {searchData && (
            <span className="text-xs text-muted-foreground">
              ({total} result{total !== 1 ? "s" : ""})
            </span>
          )}
        </div>

        {/* Search input */}
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            className="h-8 text-sm pl-8 pr-8"
            placeholder="Search external skills..."
            value={inputValue}
            onChange={handleInputChange}
            aria-label="Search external skill market"
          />
          {inputValue && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setInputValue("")}
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Filter bar: source chips + sort */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border shrink-0 flex-wrap">
        {/* Source filter chips */}
        {sources.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground mr-1">Sources:</span>
            {sources
              .filter((s) => s.enabled)
              .map((source) => {
                const isSelected = selectedSources.includes(source.id);
                return (
                  <button
                    key={source.id}
                    type="button"
                    onClick={() => toggleSource(source.id)}
                    aria-pressed={isSelected}
                    className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-md outline-none"
                  >
                    <Badge
                      variant={isSelected ? "default" : "secondary"}
                      className={cn(
                        "text-[10px] px-2 py-0.5 cursor-pointer flex items-center gap-1",
                        isSelected && "pr-1.5",
                      )}
                    >
                      {source.icon && (
                        <img
                          src={source.icon}
                          alt=""
                          className="h-3 w-3 rounded-sm"
                          aria-hidden="true"
                        />
                      )}
                      {source.name}
                      {isSelected && <X className="h-2 w-2 ml-0.5" />}
                    </Badge>
                  </button>
                );
              })}
            {selectedSources.length > 0 && (
              <button
                type="button"
                onClick={clearSourceFilter}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors ml-1"
                aria-label="Clear source filter"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {/* Sort */}
        <div className="flex items-center rounded-md border border-border overflow-hidden text-xs ml-auto">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setSort(opt.value)}
              className={cn(
                "px-3 py-1.5 transition-colors",
                sort === opt.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Clear all */}
        {hasActiveFilters && (
          <button
            type="button"
            onClick={() => {
              setInputValue("");
              setSelectedSources([]);
              setSort("relevance");
            }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Source health indicators */}
      {searchData?.sources && Object.keys(searchData.sources).length > 0 && (
        <div className="flex items-center gap-3 px-6 py-1.5 border-b border-border text-[10px] text-muted-foreground shrink-0">
          {Object.entries(searchData.sources).map(([id, info]) => (
            <span key={id} className="flex items-center gap-1">
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  info.error ? "bg-destructive" : "bg-emerald-500",
                )}
              />
              {id}: {info.count} result{info.count !== 1 ? "s" : ""}{" "}
              ({info.latencyMs}ms)
              {info.error && (
                <span className="text-destructive"> - {info.error}</span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Results grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {isSearching ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-44 rounded-lg" />
            ))}
          </div>
        ) : searchError ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-sm text-destructive">
              Failed to search the skill market.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {searchError instanceof Error
                ? searchError.message
                : "Unknown error"}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-4"
              onClick={() => setDebouncedQuery((q) => q)}
            >
              Retry
            </Button>
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <ShoppingBag className="h-8 w-8 text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">
              {debouncedQuery || selectedSources.length > 0
                ? "No skills match the current search."
                : "Search for external skills to browse available integrations."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {results.map((skill) => (
              <SkillMarketCard
                key={`${skill.source}:${skill.externalId}`}
                name={skill.name}
                description={skill.description}
                source={skill.source}
                sourceIcon={skill.icon}
                tags={skill.tags}
                popularity={skill.popularity}
                installable={true}
                installed={false}
                onInstall={() => handleInstall(skill.externalId, skill.source)}
                onSelect={() => handleSelectSkill(skill)}
                isInstallPending={installMutation.isPending}
              />
            ))}
          </div>
        )}
      </div>

      {/* Detail modal */}
      <SkillMarketDetailModal
        skill={selectedSkill}
        open={detailOpen}
        onClose={handleCloseDetail}
        onInstall={handleInstall}
        isInstallPending={installMutation.isPending}
      />
    </div>
  );
}
