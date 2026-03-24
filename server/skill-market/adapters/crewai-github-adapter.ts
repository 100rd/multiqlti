// ─── CrewAI / GitHub Open Source Adapter ────────────────────────────────────
//
// Indexes open-source agent tools from GitHub repositories (CrewAI, LangChain,
// MCP servers, etc.) using the public GitHub REST API.  Supports optional
// authentication via the GITHUB_TOKEN environment variable to raise the
// rate-limit ceiling from 60 to 5 000 requests/hour.
//
// Phase 9.4 — Issue #206
// ─────────────────────────────────────────────────────────────────────────────

import type {
  SkillRegistryAdapter,
  RegistrySearchOptions,
  ExternalSkillResult,
  ExternalSkillDetails,
  InstalledSkillResult,
  SkillUpdateInfo,
} from "../types.js";

/** Well-known repositories to surface even without a search query. */
interface KnownRepo {
  owner: string;
  repo: string;
  description: string;
}

/** Minimal shape of the GitHub Search API `items[]` entries we use. */
interface GitHubRepoItem {
  full_name: string;
  name: string;
  description: string | null;
  owner: { login: string } | null;
  topics: string[] | null;
  stargazers_count: number;
  html_url: string;
  license: { spdx_id: string } | null;
  updated_at: string | null;
}

/** Shape of the GitHub Search API response. */
interface GitHubSearchResponse {
  total_count?: number;
  items?: GitHubRepoItem[];
}

const GITHUB_API = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export class CrewAiGithubAdapter implements SkillRegistryAdapter {
  // ─── SkillRegistryAdapter identity ──────────────────────────────────────────

  readonly id = "crewai-github";
  readonly name = "CrewAI & Open Source";
  readonly icon = "🐍";
  enabled = true;

  // ─── Pre-configured catalog ─────────────────────────────────────────────────

  private readonly knownRepos: KnownRepo[] = [
    { owner: "crewAIInc", repo: "crewAI-tools", description: "CrewAI agent tools" },
    { owner: "modelcontextprotocol", repo: "servers", description: "Official MCP servers" },
  ];

  // ─── SkillRegistryAdapter implementation ────────────────────────────────────

  async search(
    query: string,
    options?: RegistrySearchOptions,
  ): Promise<ExternalSkillResult> {
    const limit = options?.limit ?? 20;
    const url =
      `${GITHUB_API}/search/repositories` +
      `?q=${encodeURIComponent(query)}+topic:mcp-server` +
      `&per_page=${limit}` +
      `&sort=stars`;

    const res = await this.ghFetch(url);
    const data: GitHubSearchResponse = await res.json();

    const rawItems = data.items ?? [];
    const items = rawItems.map((repo) => this.toSummary(repo));

    return {
      items,
      total: data.total_count ?? items.length,
      source: this.id,
    };
  }

  async getDetails(externalId: string): Promise<ExternalSkillDetails> {
    const repoPath = this.extractRepoPath(externalId);
    const res = await this.ghFetch(`${GITHUB_API}/repos/${repoPath}`);
    const repo: GitHubRepoItem = await res.json();

    return {
      externalId,
      name: repo.name,
      description: repo.description ?? "",
      source: this.id,
      tags: repo.topics ?? [],
      author: repo.owner?.login ?? "unknown",
      version: "latest",
      popularity: repo.stargazers_count ?? 0,
      icon: this.icon,
      repository: repo.html_url,
      license: repo.license?.spdx_id ?? undefined,
      updatedAt: repo.updated_at ? new Date(repo.updated_at) : undefined,
      readme: undefined, // Could be fetched from /repos/:owner/:repo/readme
    };
  }

  async install(externalId: string, _userId: string): Promise<InstalledSkillResult> {
    const repoPath = this.extractRepoPath(externalId);
    return {
      localSkillId: `github-${repoPath.replace("/", "-")}`,
      externalId,
      externalVersion: "latest",
      source: this.id,
      installedAt: new Date(),
    };
  }

  async uninstall(_localSkillId: string): Promise<void> {
    // GitHub repos are not truly "installed" locally — nothing to clean up.
  }

  async checkUpdates(
    _installed: Array<{ externalId: string; externalVersion?: string }>,
  ): Promise<SkillUpdateInfo[]> {
    // Git repositories don't have discrete versions in the npm/registry sense.
    return [];
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const res = await this.ghFetch(`${GITHUB_API}/rate_limit`);
      return { ok: res.ok, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  /** Expose known repos for testing / UI use. */
  getKnownRepos(): readonly KnownRepo[] {
    return this.knownRepos;
  }

  /** Strip the adapter prefix from an externalId to get "owner/repo". */
  private extractRepoPath(externalId: string): string {
    return externalId.replace(`${this.id}:`, "");
  }

  /** Map a raw GitHub repo payload to an ExternalSkillSummary. */
  private toSummary(repo: GitHubRepoItem) {
    return {
      externalId: `${this.id}:${repo.full_name}`,
      name: repo.name,
      description: repo.description ?? "",
      source: this.id,
      tags: repo.topics ?? [],
      author: repo.owner?.login ?? "unknown",
      version: "latest",
      popularity: repo.stargazers_count ?? 0,
      icon: this.icon,
    };
  }

  /**
   * Thin wrapper around `fetch` with:
   *  - AbortController-based timeout
   *  - GitHub Accept header
   *  - Optional Bearer token from GITHUB_TOKEN env var
   *  - Non-2xx rejection
   */
  private async ghFetch(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
    };

    const token = process.env.GITHUB_TOKEN;
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    try {
      const res = await fetch(url, { signal: controller.signal, headers });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`GitHub API ${res.status}: ${body}`);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
}
