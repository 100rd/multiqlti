import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SkillMarketSearchResult {
  externalId: string;
  name: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  popularity?: number;
  source: string;
  icon?: string;
}

export interface SkillMarketSearchResponse {
  results: SkillMarketSearchResult[];
  total: number;
  sources: Record<
    string,
    { count: number; latencyMs: number; error?: string }
  >;
}

export interface SkillMarketSource {
  id: string;
  name: string;
  icon?: string;
  enabled: boolean;
  health?: { ok: boolean; latencyMs: number; error?: string };
}

export interface SkillMarketDetails {
  externalId: string;
  name: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  popularity?: number;
  source: string;
  icon?: string;
  readme?: string;
  changelog?: string;
  license?: string;
  repository?: string;
  homepage?: string;
  config?: Record<string, unknown>;
  publishedAt?: string;
  updatedAt?: string;
}

export interface SkillMarketInstallResult {
  localSkillId: string;
  externalId: string;
  externalVersion: string;
  source: string;
  installedAt: string;
}

export interface SkillMarketCategory {
  name: string;
  count: number;
}

export interface SkillMarketSearchOptions {
  sources?: string[];
  limit?: number;
  sort?: string;
}

// ─── API Helpers ─────────────────────────────────────────────────────────────

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

function buildAuthHeaders(hasBody = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (hasBody) headers["Content-Type"] = "application/json";
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText })) as { message?: string };
    throw new Error(body.message ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// ─── Query Key Factories ─────────────────────────────────────────────────────

const keys = {
  all: ["skill-market"] as const,
  search: (query: string, opts?: SkillMarketSearchOptions) =>
    ["skill-market", "search", query, opts] as const,
  sources: () => ["skill-market", "sources"] as const,
  details: (source: string, externalId: string) =>
    ["skill-market", "details", source, externalId] as const,
  categories: () => ["skill-market", "categories"] as const,
};

// ─── Hooks ───────────────────────────────────────────────────────────────────

/**
 * Search the external skill market across all registered sources.
 * Disabled when query is empty.
 */
export function useSkillMarketSearch(
  query: string,
  options?: SkillMarketSearchOptions,
) {
  return useQuery<SkillMarketSearchResponse>({
    queryKey: keys.search(query, options),
    queryFn: () => {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (options?.sources?.length) params.set("sources", options.sources.join(","));
      if (options?.limit) params.set("limit", String(options.limit));
      if (options?.sort) params.set("sort", options.sort);

      return apiFetch<SkillMarketSearchResponse>(
        `/api/skill-market/search?${params.toString()}`,
        { headers: buildAuthHeaders() },
      );
    },
    // Enable the query even when query is empty to show "browse all"
    enabled: true,
    staleTime: 30_000,
  });
}

/**
 * Fetch the list of available external skill sources (adapters).
 */
export function useSkillMarketSources() {
  return useQuery<SkillMarketSource[]>({
    queryKey: keys.sources(),
    queryFn: () =>
      apiFetch<SkillMarketSource[]>("/api/skill-market/sources", {
        headers: buildAuthHeaders(),
      }),
    staleTime: 60_000,
  });
}

/**
 * Fetch full details for a single external skill.
 * Disabled when source or externalId is falsy.
 */
export function useSkillMarketDetails(source: string, externalId: string) {
  return useQuery<SkillMarketDetails>({
    queryKey: keys.details(source, externalId),
    queryFn: () =>
      apiFetch<SkillMarketDetails>(
        `/api/skill-market/details/${encodeURIComponent(source)}/${encodeURIComponent(externalId)}`,
        { headers: buildAuthHeaders() },
      ),
    enabled: Boolean(source && externalId),
    staleTime: 60_000,
  });
}

/**
 * Install an external skill from the skill market.
 * Invalidates skills list after successful install.
 */
export function useSkillMarketInstall() {
  const qc = useQueryClient();
  return useMutation<
    SkillMarketInstallResult,
    Error,
    { externalId: string; source: string; config?: Record<string, unknown> }
  >({
    mutationFn: (payload) =>
      apiFetch<SkillMarketInstallResult>("/api/skill-market/install", {
        method: "POST",
        headers: buildAuthHeaders(true),
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/skills"] });
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

/**
 * Fetch aggregated categories from all sources.
 */
export function useSkillMarketCategories() {
  return useQuery<SkillMarketCategory[]>({
    queryKey: keys.categories(),
    queryFn: () =>
      apiFetch<SkillMarketCategory[]>("/api/skill-market/categories", {
        headers: buildAuthHeaders(),
      }),
    staleTime: 60_000,
  });
}
