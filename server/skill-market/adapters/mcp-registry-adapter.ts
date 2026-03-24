/**
 * MCP Registry Adapter
 *
 * Integrates with the official MCP Registry at registry.modelcontextprotocol.io
 * to search, inspect, install, and update MCP server skills.
 *
 * API docs: https://registry.modelcontextprotocol.io
 * No authentication required.
 */
import type {
  SkillRegistryAdapter,
  RegistrySearchOptions,
  ExternalSkillResult,
  ExternalSkillSummary,
  ExternalSkillDetails,
  InstalledSkillResult,
  SkillUpdateInfo,
} from "../types.js";

const BASE_URL = "https://registry.modelcontextprotocol.io";
const REQUEST_TIMEOUT_MS = 10_000;

// ─── MCP Registry response shapes ──────────────────────────────────────────

interface McpPackage {
  registry_name?: string;
  name?: string;
  version?: string;
  runtime?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpTool {
  name: string;
  description?: string;
}

interface McpServer {
  id: string;
  name?: string;
  description?: string;
  repository?: { url?: string };
  version_detail?: { version?: string };
  packages?: McpPackage[];
  tools?: McpTool[];
  remotes?: Array<{ transportType?: string; url?: string }>;
  tags?: string[];
  downloads?: number;
  stars?: number;
  readme?: string;
  license?: string;
  updated_at?: string;
}

interface McpSearchResponse {
  servers: McpServer[];
  next_cursor?: string;
  total?: number;
}

// ─── Adapter Implementation ─────────────────────────────────────────────────

export class McpRegistryAdapter implements SkillRegistryAdapter {
  id = "mcp-registry";
  name = "MCP Registry";
  icon = "mcp";
  enabled = true;

  async search(
    query: string,
    options?: RegistrySearchOptions,
  ): Promise<ExternalSkillResult> {
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;
    const url = `${BASE_URL}/v0/servers?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`;

    const res = await this.fetchWithTimeout(url);
    const data: McpSearchResponse = await res.json();

    const items: ExternalSkillSummary[] = (data.servers ?? []).map((s) =>
      this.toSummary(s),
    );

    return {
      items,
      total: data.total ?? items.length,
      source: this.id,
    };
  }

  async getDetails(externalId: string): Promise<ExternalSkillDetails> {
    const serverId = this.stripPrefix(externalId);
    const res = await this.fetchWithTimeout(
      `${BASE_URL}/v0/servers/${encodeURIComponent(serverId)}`,
    );
    const s: McpServer = await res.json();

    return {
      externalId,
      name: s.name ?? s.id,
      description: s.description ?? "",
      source: this.id,
      tags: this.extractTags(s),
      author: this.extractGithubOwner(s.repository?.url) ?? "unknown",
      version: s.version_detail?.version ?? "0.0.0",
      popularity: s.downloads ?? s.stars ?? 0,
      icon: undefined,
      readme: s.readme,
      repository: s.repository?.url,
      license: s.license,
      updatedAt: s.updated_at ? new Date(s.updated_at) : undefined,
      config: this.extractRequiredConfig(s),
    };
  }

  async install(
    externalId: string,
    _userId: string,
  ): Promise<InstalledSkillResult> {
    // Retrieve details so we can record the version being installed.
    // In a full implementation this would also:
    //   1. Create an mcp_servers row
    //   2. Connect via McpClientManager
    //   3. Create a skill entry
    const details = await this.getDetails(externalId);
    const serverId = this.stripPrefix(externalId);

    return {
      localSkillId: `mcp-${serverId}`,
      externalId,
      externalVersion: details.version,
      source: this.id,
      installedAt: new Date(),
    };
  }

  async uninstall(_localSkillId: string): Promise<void> {
    // Would disconnect MCP server and remove skill entry.
    // No-op placeholder until full MCP connection management is wired.
  }

  async checkUpdates(
    installed: Array<{ externalId: string; externalVersion?: string }>,
  ): Promise<SkillUpdateInfo[]> {
    const updates: SkillUpdateInfo[] = [];

    for (const item of installed) {
      try {
        const details = await this.getDetails(item.externalId);
        if (
          details.version &&
          item.externalVersion &&
          details.version !== item.externalVersion
        ) {
          updates.push({
            externalId: item.externalId,
            currentVersion: item.externalVersion,
            latestVersion: details.version,
          });
        }
      } catch {
        // Skip unreachable entries — the caller can retry later.
      }
    }

    return updates;
  }

  async healthCheck(): Promise<{
    ok: boolean;
    latencyMs: number;
    error?: string;
  }> {
    const start = Date.now();
    try {
      const res = await this.fetchWithTimeout(
        `${BASE_URL}/v0/servers?limit=1`,
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private toSummary(s: McpServer): ExternalSkillSummary {
    return {
      externalId: `mcp-registry:${s.id}`,
      name: s.name ?? s.id,
      description: s.description ?? "",
      source: this.id,
      tags: this.extractTags(s),
      author: this.extractGithubOwner(s.repository?.url) ?? "unknown",
      version: s.version_detail?.version ?? "0.0.0",
      popularity: s.downloads ?? s.stars ?? 0,
    };
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(
          `MCP Registry HTTP ${res.status}: ${await res.text()}`,
        );
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  private extractTags(server: McpServer): string[] {
    const tags: string[] = [];
    if (server.tags && Array.isArray(server.tags)) {
      tags.push(...server.tags);
    }
    if (server.packages?.[0]?.registry_name) {
      tags.push(server.packages[0].registry_name);
    }
    return tags;
  }

  /* exported for testing */
  extractGithubOwner(url: string | undefined): string | undefined {
    if (!url) return undefined;
    const match = url.match(/github\.com\/([^/]+)/);
    return match?.[1];
  }

  private extractRequiredConfig(
    server: McpServer,
  ): Record<string, unknown> | undefined {
    const env = server.packages?.[0]?.env;
    if (!env || typeof env !== "object") return undefined;

    const config: Record<string, unknown> = {};
    for (const [key, desc] of Object.entries(env)) {
      config[key] = {
        description: String(desc),
        secret:
          key.toLowerCase().includes("key") ||
          key.toLowerCase().includes("token") ||
          key.toLowerCase().includes("secret"),
      };
    }
    return config;
  }

  private stripPrefix(externalId: string): string {
    return externalId.replace(/^mcp-registry:/, "");
  }
}
