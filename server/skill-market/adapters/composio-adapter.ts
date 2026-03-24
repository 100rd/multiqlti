/**
 * Composio Adapter
 *
 * Integrates with the Composio API at https://backend.composio.dev/api/v1
 * to search, inspect, and install Composio toolkits (apps) and actions as skills.
 *
 * Authentication: X-API-Key header from COMPOSIO_API_KEY environment variable.
 * If the key is not set, the adapter is disabled and healthCheck returns an error.
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

const BASE_URL = "https://backend.composio.dev/api/v1";
const REQUEST_TIMEOUT_MS = 10_000;

// ─── Composio API response shapes ──────────────────────────────────────────

interface ComposioApp {
  appId?: string;
  key?: string;
  name?: string;
  description?: string;
  logo?: string;
  categories?: string[];
  tags?: string[];
  meta?: Record<string, unknown>;
  docs?: string;
}

interface ComposioAction {
  appName?: string;
  appId?: string;
  name?: string;
  display_name?: string;
  description?: string;
  tags?: string[];
  logo?: string;
  parameters?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

// ─── Adapter Implementation ─────────────────────────────────────────────────

export class ComposioAdapter implements SkillRegistryAdapter {
  id = "composio";
  name = "Composio";
  icon = "composio";
  enabled: boolean;

  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.COMPOSIO_API_KEY ?? "";
    this.enabled = this.apiKey.length > 0;
  }

  async search(
    query: string,
    options?: RegistrySearchOptions,
  ): Promise<ExternalSkillResult> {
    if (!this.enabled) {
      return { items: [], total: 0, source: this.id };
    }

    const limit = options?.limit ?? 20;

    // When a query is provided, search actions by use case for better relevance.
    // When empty, list available apps/toolkits instead.
    if (query.trim().length > 0) {
      return this.searchByUseCase(query, limit);
    }

    return this.listApps(limit);
  }

  async getDetails(externalId: string): Promise<ExternalSkillDetails> {
    const appName = this.stripPrefix(externalId);

    // Fetch app metadata and its actions in parallel.
    const [appRes, actionsRes] = await Promise.all([
      this.fetchWithTimeout(
        `${BASE_URL}/apps/${encodeURIComponent(appName)}`,
      ),
      this.fetchWithTimeout(
        `${BASE_URL}/actions?appNames=${encodeURIComponent(appName)}&limit=50`,
      ),
    ]);

    const app: ComposioApp = await appRes.json();
    const actionsData: { items?: ComposioAction[] } = await actionsRes.json();
    const actions: ComposioAction[] = actionsData.items ?? [];

    const toolDescriptions = actions
      .map((a) => `- ${a.display_name ?? a.name}: ${a.description ?? ""}`)
      .join("\n");

    return {
      externalId,
      name: app.name ?? appName,
      description: app.description ?? "",
      source: this.id,
      tags: this.extractTags(app),
      author: "composio",
      version: "latest",
      popularity: undefined,
      icon: app.logo,
      readme: toolDescriptions.length > 0
        ? `## Available Actions\n\n${toolDescriptions}`
        : undefined,
      homepage: app.docs,
      config: this.extractConfig(actions),
    };
  }

  async install(
    externalId: string,
    _userId: string,
  ): Promise<InstalledSkillResult> {
    // Placeholder: In a full implementation this would:
    //   1. Create a connected account via Composio
    //   2. Register tools that proxy to the Composio execute endpoint
    //   3. Store the connection in the local skill registry
    const appName = this.stripPrefix(externalId);

    return {
      localSkillId: `composio-${appName}`,
      externalId,
      externalVersion: "latest",
      source: this.id,
      installedAt: new Date(),
    };
  }

  async uninstall(_localSkillId: string): Promise<void> {
    // Would disconnect the Composio integration and remove local skill entry.
    // No-op placeholder until full connection management is wired.
  }

  async checkUpdates(
    _installed: Array<{ externalId: string; externalVersion?: string }>,
  ): Promise<SkillUpdateInfo[]> {
    // Composio is a SaaS platform -- actions are always at the latest version.
    // No version-pinning concept exists, so there is nothing to update.
    return [];
  }

  async healthCheck(): Promise<{
    ok: boolean;
    latencyMs: number;
    error?: string;
  }> {
    if (!this.enabled) {
      return {
        ok: false,
        latencyMs: 0,
        error: "COMPOSIO_API_KEY is not configured",
      };
    }

    const start = Date.now();
    try {
      const res = await this.fetchWithTimeout(`${BASE_URL}/apps?limit=1`);
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

  private async searchByUseCase(
    query: string,
    limit: number,
  ): Promise<ExternalSkillResult> {
    const url = `${BASE_URL}/actions?useCase=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await this.fetchWithTimeout(url);
    const data: { items?: ComposioAction[] } = await res.json();
    const actions: ComposioAction[] = data.items ?? [];

    const items: ExternalSkillSummary[] = actions.map((a) =>
      this.actionToSummary(a),
    );

    return {
      items,
      total: items.length,
      source: this.id,
    };
  }

  private async listApps(limit: number): Promise<ExternalSkillResult> {
    const url = `${BASE_URL}/apps?limit=${limit}`;
    const res = await this.fetchWithTimeout(url);
    const data: { items?: ComposioApp[] } = await res.json();
    const apps: ComposioApp[] = data.items ?? [];

    const items: ExternalSkillSummary[] = apps.map((a) =>
      this.appToSummary(a),
    );

    return {
      items,
      total: items.length,
      source: this.id,
    };
  }

  private actionToSummary(action: ComposioAction): ExternalSkillSummary {
    return {
      externalId: `composio:${action.appName ?? action.appId ?? "unknown"}`,
      name: action.display_name ?? action.name ?? "Unknown Action",
      description: action.description ?? "",
      source: this.id,
      tags: action.tags ?? [],
      author: "composio",
      version: "latest",
      popularity: undefined,
      icon: action.logo,
    };
  }

  private appToSummary(app: ComposioApp): ExternalSkillSummary {
    return {
      externalId: `composio:${app.key ?? app.appId ?? "unknown"}`,
      name: app.name ?? app.key ?? "Unknown App",
      description: app.description ?? "",
      source: this.id,
      tags: this.extractTags(app),
      author: "composio",
      version: "latest",
      popularity: undefined,
      icon: app.logo,
    };
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "X-API-Key": this.apiKey,
          "Accept": "application/json",
        },
      });
      if (res.status === 429) {
        throw new Error(
          "Composio rate limit exceeded (429). Retry after a brief wait.",
        );
      }
      if (!res.ok) {
        throw new Error(
          `Composio HTTP ${res.status}: ${await res.text()}`,
        );
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  private extractTags(app: ComposioApp): string[] {
    const tags: string[] = [];
    if (app.categories && Array.isArray(app.categories)) {
      tags.push(...app.categories);
    }
    if (app.tags && Array.isArray(app.tags)) {
      tags.push(...app.tags);
    }
    return tags;
  }

  private extractConfig(
    actions: ComposioAction[],
  ): Record<string, unknown> | undefined {
    // Collect all required parameters across actions to surface what config
    // the user would need to provide.
    const allRequired = new Set<string>();
    for (const action of actions) {
      if (action.parameters?.required) {
        for (const r of action.parameters.required) {
          allRequired.add(r);
        }
      }
    }
    if (allRequired.size === 0) return undefined;

    const config: Record<string, unknown> = {};
    for (const key of allRequired) {
      config[key] = {
        description: `Required parameter for action execution`,
        secret:
          key.toLowerCase().includes("key") ||
          key.toLowerCase().includes("token") ||
          key.toLowerCase().includes("secret") ||
          key.toLowerCase().includes("password"),
      };
    }
    return config;
  }

  private stripPrefix(externalId: string): string {
    return externalId.replace(/^composio:/, "");
  }
}
