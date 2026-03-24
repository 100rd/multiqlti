// ─── Skill Market / Registry Adapter Types ──────────────────────────────────

/**
 * Options for searching an external skill registry.
 */
export interface RegistrySearchOptions {
  tags?: string[];
  category?: string;
  limit?: number;
  offset?: number;
  sort?: "relevance" | "popularity" | "newest";
}

/**
 * Summary of a skill returned from an external registry search.
 */
export interface ExternalSkillSummary {
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

/**
 * Full details of a skill retrieved from an external registry.
 */
export interface ExternalSkillDetails {
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
  publishedAt?: Date;
  updatedAt?: Date;
}

/**
 * Result of installing an external skill locally.
 */
export interface InstalledSkillResult {
  localSkillId: string;
  externalId: string;
  externalVersion: string;
  source: string;
  installedAt: Date;
}

/**
 * Information about an available update for an installed external skill.
 */
export interface SkillUpdateInfo {
  externalId: string;
  currentVersion: string;
  latestVersion: string;
  changelog?: string;
  breaking?: boolean;
}

/**
 * Search result set from a single external registry adapter.
 */
export interface ExternalSkillResult {
  items: ExternalSkillSummary[];
  total: number;
  source: string;
}

// ─── Adapter Interface ──────────────────────────────────────────────────────

/**
 * Contract for external skill registry integrations.
 *
 * Each adapter wraps a single external source (npm, GitHub marketplace,
 * community hub, etc.) and exposes a uniform API the RegistryManager
 * can call in parallel.
 */
export interface SkillRegistryAdapter {
  /** Unique identifier for this adapter (e.g. "npm", "github-marketplace"). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Optional icon URL or emoji. */
  icon?: string;
  /** Whether this adapter is currently active. */
  enabled: boolean;

  /** Search the external registry for skills matching the query. */
  search(query: string, options?: RegistrySearchOptions): Promise<ExternalSkillResult>;

  /** Retrieve full details for a single skill by its external identifier. */
  getDetails(externalId: string): Promise<ExternalSkillDetails>;

  /** Install an external skill for a given user. */
  install(externalId: string, userId: string): Promise<InstalledSkillResult>;

  /** Remove a previously installed external skill. */
  uninstall(localSkillId: string): Promise<void>;

  /** Check for available updates against a list of installed skills. */
  checkUpdates(
    installed: Array<{ externalId: string; externalVersion?: string }>,
  ): Promise<SkillUpdateInfo[]>;

  /** Quick connectivity / health probe. */
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}
