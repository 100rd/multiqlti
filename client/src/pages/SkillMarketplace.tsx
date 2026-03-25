import { useState, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Store } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { MarketplaceSkillCard } from "@/components/skills/MarketplaceSkillCard";
import { SkillDetailModal } from "@/components/skills/SkillDetailModal";
import {
  SkillFilterSidebar,
  EMPTY_FILTERS,
} from "@/components/skills/SkillFilterSidebar";
import type { MarketplaceSkillData } from "@/components/skills/MarketplaceSkillCard";
import type { MarketplaceFilters } from "@/components/skills/SkillFilterSidebar";

// ─── Types ───────────────────────────────────────────────────────────────────

interface MarketplaceResponse {
  skills: MarketplaceSkillData[];
  total: number;
}

// ─── API helpers ─────────────────────────────────────────────────────────────

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

function buildAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function fetchMarketplace(
  filters: MarketplaceFilters,
  offset: number,
  limit: number,
): Promise<MarketplaceResponse> {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.tags.length > 0) params.set("tags", filters.tags.join(","));
  if (filters.teamId !== "all") params.set("teamId", filters.teamId);
  params.set("sort", filters.sort);
  params.set("limit", String(limit));
  params.set("offset", String(offset));

  const res = await fetch(`/api/skills/marketplace?${params.toString()}`, {
    headers: buildAuthHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error((err.error ?? err.message ?? res.statusText) as string);
  }
  return res.json() as Promise<MarketplaceResponse>;
}

async function forkSkill(skillId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/skills/${skillId}/fork`, {
    method: "POST",
    headers: {
      ...buildAuthHeaders(),
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error((err.error ?? err.message ?? res.statusText) as string);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

async function rollbackSkill(skillId: string, version: string): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/skills/${skillId}/rollback/${version}`, {
    method: "POST",
    headers: {
      ...buildAuthHeaders(),
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error((err.error ?? err.message ?? res.statusText) as string);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

// ─── Component ───────────────────────────────────────────────────────────────

export default function SkillMarketplace() {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState<MarketplaceFilters>(EMPTY_FILTERS);
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(0);
  const [selectedSkill, setSelectedSkill] = useState<MarketplaceSkillData | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // Debounced search: the actual filter.search updates when the user commits
  const activeFilters = useMemo<MarketplaceFilters>(
    () => ({ ...filters, search: searchInput }),
    [filters, searchInput],
  );

  const offset = page * PAGE_SIZE;

  const { data, isLoading, error } = useQuery<MarketplaceResponse>({
    queryKey: ["skills-marketplace", activeFilters, offset],
    queryFn: () => fetchMarketplace(activeFilters, offset, PAGE_SIZE),
  });

  // Fork mutation
  const forkMutation = useMutation({
    mutationFn: forkSkill,
    onSuccess: () => {
      toast({ title: "Skill forked successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Fork failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Rollback mutation
  const rollbackMutation = useMutation({
    mutationFn: ({ skillId, version }: { skillId: string; version: string }) =>
      rollbackSkill(skillId, version),
    onSuccess: () => {
      toast({ title: "Skill rolled back successfully" });
      queryClient.invalidateQueries({ queryKey: ["skills-marketplace"] });
      queryClient.invalidateQueries({ queryKey: ["skill-versions"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Rollback failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handleFork = useCallback(
    (skillId: string) => {
      forkMutation.mutate(skillId);
    },
    [forkMutation],
  );

  const handleRollback = useCallback(
    (skillId: string, version: string) => {
      rollbackMutation.mutate({ skillId, version });
    },
    [rollbackMutation],
  );

  const handleSelectSkill = useCallback((skill: MarketplaceSkillData) => {
    setSelectedSkill(skill);
    setDetailOpen(true);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setDetailOpen(false);
    setSelectedSkill(null);
  }, []);

  const handleFiltersChange = useCallback((next: MarketplaceFilters) => {
    setFilters(next);
    setPage(0);
  }, []);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchInput(e.target.value);
    setPage(0);
  }, []);

  // Collect unique tags from results for the sidebar
  const availableTags = useMemo(() => {
    if (!data) return [];
    const tagSet = new Set<string>();
    for (const skill of data.skills) {
      for (const tag of skill.tags) {
        tagSet.add(tag);
      }
    }
    return Array.from(tagSet).sort();
  }, [data]);

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="h-16 border-b border-border flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-2">
          <Store className="h-5 w-5 text-primary" />
          <h1 className="text-base font-semibold">Skill Marketplace</h1>
          {data && (
            <span className="text-xs text-muted-foreground">
              ({data.total} skill{data.total !== 1 ? "s" : ""})
            </span>
          )}
        </div>
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            className="h-8 text-sm pl-8"
            placeholder="Search skills..."
            value={searchInput}
            onChange={handleSearchChange}
            aria-label="Search marketplace skills"
          />
        </div>
      </div>

      {/* Body: sidebar + grid */}
      <div className="flex-1 flex overflow-hidden">
        <SkillFilterSidebar
          filters={activeFilters}
          onFiltersChange={handleFiltersChange}
          availableTags={availableTags}
        />

        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto p-6">
            {isLoading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-44 rounded-lg" />
                ))}
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <p className="text-sm text-destructive">
                  Failed to load marketplace skills.
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {error instanceof Error ? error.message : "Unknown error"}
                </p>
              </div>
            ) : !data || data.skills.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Store className="h-8 w-8 text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {searchInput || filters.tags.length > 0 || filters.teamId !== "all"
                    ? "No skills match the current filters."
                    : "The marketplace is empty. Share your skills to get started."}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {data.skills.map((skill) => (
                  <MarketplaceSkillCard
                    key={skill.id}
                    skill={skill}
                    onFork={handleFork}
                    onSelect={handleSelectSkill}
                    isForkPending={forkMutation.isPending}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Pagination */}
          {data && totalPages > 1 && (
            <div className="flex items-center justify-between px-6 py-3 border-t border-border text-xs text-muted-foreground shrink-0">
              <span>{data.total} total</span>
              <div className="flex gap-2 items-center">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page <= 0}
                  className="px-2 py-1 rounded border border-border disabled:opacity-40 hover:border-primary/50 transition-colors"
                  aria-label="Previous page"
                >
                  Prev
                </button>
                <span>
                  {page + 1} / {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="px-2 py-1 rounded border border-border disabled:opacity-40 hover:border-primary/50 transition-colors"
                  aria-label="Next page"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Detail modal */}
      <SkillDetailModal
        skill={selectedSkill}
        open={detailOpen}
        onClose={handleCloseDetail}
        onFork={handleFork}
        onRollback={handleRollback}
        isForkPending={forkMutation.isPending}
        isRollbackPending={rollbackMutation.isPending}
        currentUserId={user?.id}
      />
    </div>
  );
}
