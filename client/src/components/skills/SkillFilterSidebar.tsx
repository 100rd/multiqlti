import { memo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { X, Filter } from "lucide-react";
import { SDLC_TEAMS } from "@shared/constants";

// ─── Types ───────────────────────────────────────────────────────────────────

export type MarketplaceSortField = "usageCount" | "newest" | "name";

export interface MarketplaceFilters {
  search: string;
  tags: string[];
  teamId: string;
  sort: MarketplaceSortField;
}

interface SkillFilterSidebarProps {
  filters: MarketplaceFilters;
  onFiltersChange: (filters: MarketplaceFilters) => void;
  availableTags: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SORT_OPTIONS: { value: MarketplaceSortField; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "usageCount", label: "Most Used" },
  { value: "name", label: "Name (A-Z)" },
];

const EMPTY_FILTERS: MarketplaceFilters = {
  search: "",
  tags: [],
  teamId: "all",
  sort: "newest",
};

// ─── Component ───────────────────────────────────────────────────────────────

export const SkillFilterSidebar = memo(function SkillFilterSidebar({
  filters,
  onFiltersChange,
  availableTags,
}: SkillFilterSidebarProps) {
  const teamEntries = Object.entries(SDLC_TEAMS);

  const hasActiveFilters =
    filters.search !== "" ||
    filters.tags.length > 0 ||
    filters.teamId !== "all" ||
    filters.sort !== "newest";

  function updateFilter<K extends keyof MarketplaceFilters>(
    key: K,
    value: MarketplaceFilters[K],
  ) {
    onFiltersChange({ ...filters, [key]: value });
  }

  function toggleTag(tag: string) {
    const next = filters.tags.includes(tag)
      ? filters.tags.filter((t) => t !== tag)
      : [...filters.tags, tag];
    updateFilter("tags", next);
  }

  function clearFilters() {
    onFiltersChange(EMPTY_FILTERS);
  }

  return (
    <aside
      className="w-56 shrink-0 border-r border-border p-4 space-y-5 overflow-y-auto"
      aria-label="Marketplace filters"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Filter className="h-3.5 w-3.5" />
          Filters
        </div>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Clear all filters"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Sort */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground" id="sort-label">
          Sort by
        </label>
        <Select
          value={filters.sort}
          onValueChange={(value: string) =>
            updateFilter("sort", value as MarketplaceSortField)
          }
          aria-labelledby="sort-label"
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Team filter */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground" id="team-filter-label">
          Team
        </label>
        <Select
          value={filters.teamId}
          onValueChange={(value: string) => updateFilter("teamId", value)}
          aria-labelledby="team-filter-label"
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="All teams" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All teams</SelectItem>
            {teamEntries.map(([id, config]) => (
              <SelectItem key={id} value={id}>
                {config.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Tags filter */}
      {availableTags.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Tags
          </label>
          <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto">
            {availableTags.map((tag) => {
              const isSelected = filters.tags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  aria-pressed={isSelected}
                  className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-md outline-none"
                >
                  <Badge
                    variant={isSelected ? "default" : "secondary"}
                    className="text-[10px] px-1.5 py-0.5 cursor-pointer"
                  >
                    {tag}
                    {isSelected && <X className="h-2 w-2 ml-0.5" />}
                  </Badge>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Selected tags summary */}
      {filters.tags.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground">
            {filters.tags.length} tag{filters.tags.length !== 1 ? "s" : ""} selected
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px] px-2"
            onClick={() => updateFilter("tags", [])}
          >
            Clear tags
          </Button>
        </div>
      )}
    </aside>
  );
});

export { EMPTY_FILTERS };
