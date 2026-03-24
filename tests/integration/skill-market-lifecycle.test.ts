/**
 * Integration tests for the Skill Market full lifecycle (Phase 9.9).
 *
 * Tests cover the RegistryManager, all three adapters (MCP, Composio, CrewAI),
 * and the SkillUpdateChecker working together — all with mocked HTTP/fetch.
 *
 * Closes #211
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RegistryManager } from "../../server/skill-market/registry-manager.js";
import type {
  SkillRegistryAdapter,
  ExternalSkillResult,
  ExternalSkillDetails,
  InstalledSkillResult,
  SkillUpdateInfo,
} from "../../server/skill-market/types.js";

// ─── Shared mock adapter factory ─────────────────────────────────────────────

function makeMockAdapter(
  id: string,
  overrides: Partial<SkillRegistryAdapter> = {},
): SkillRegistryAdapter {
  return {
    id,
    name: `${id} Mock`,
    icon: "test",
    enabled: true,
    search: vi.fn(async (): Promise<ExternalSkillResult> => ({
      items: [
        {
          externalId: `${id}:skill-1`,
          name: `${id} Skill 1`,
          description: "A mock skill",
          author: "tester",
          version: "1.0.0",
          tags: ["test"],
          popularity: 10,
          source: id,
        },
      ],
      total: 1,
      source: id,
    })),
    getDetails: vi.fn(async (externalId: string): Promise<ExternalSkillDetails> => ({
      externalId,
      name: `Details for ${externalId}`,
      description: "Mock details",
      author: "tester",
      version: "2.0.0",
      tags: ["test"],
      popularity: 99,
      source: id,
      readme: "# Mock",
      license: "MIT",
      config: { API_KEY: { description: "The key", secret: true } },
    })),
    install: vi.fn(async (externalId: string): Promise<InstalledSkillResult> => ({
      localSkillId: `local-${externalId}`,
      externalId,
      externalVersion: "1.0.0",
      source: id,
      installedAt: new Date(),
    })),
    uninstall: vi.fn(async () => {}),
    checkUpdates: vi.fn(async (): Promise<SkillUpdateInfo[]> => []),
    healthCheck: vi.fn(async () => ({ ok: true, latencyMs: 5 })),
    ...overrides,
  };
}

// =============================================================================
// Registry Manager Lifecycle Tests
// =============================================================================

describe("RegistryManager — lifecycle integration", () => {
  let manager: RegistryManager;

  beforeEach(() => {
    manager = new RegistryManager();
  });

  it("register and unregister adapters", () => {
    const a = makeMockAdapter("alpha");
    const b = makeMockAdapter("beta");

    manager.register(a);
    manager.register(b);
    expect(manager.listAdapters()).toHaveLength(2);

    manager.unregister("alpha");
    expect(manager.listAdapters()).toHaveLength(1);
    expect(manager.getAdapter("alpha")).toBeUndefined();
    expect(manager.getAdapter("beta")).toBe(b);
  });

  it("searchAll merges results from multiple mock adapters", async () => {
    const a = makeMockAdapter("alpha");
    const b = makeMockAdapter("beta");
    manager.register(a);
    manager.register(b);

    const result = await manager.searchAll("test");

    expect(result.results).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.sources.alpha).toBeDefined();
    expect(result.sources.beta).toBeDefined();
    expect(result.sources.alpha.count).toBe(1);
    expect(result.sources.beta.count).toBe(1);
  });

  it("searchAll handles adapter timeout gracefully (partial results)", async () => {
    const fast = makeMockAdapter("fast");
    const slow = makeMockAdapter("slow", {
      search: vi.fn(
        () => new Promise(() => {/* never resolves */}),
      ),
    });

    manager.register(fast);
    manager.register(slow);

    const result = await manager.searchAll("test", { timeoutMs: 50 });

    // Only the fast adapter should have returned results.
    expect(result.results).toHaveLength(1);
    expect(result.sources.fast.count).toBe(1);
    expect(result.sources.slow.count).toBe(0);
    expect(result.sources.slow.error).toContain("timeout");
  });

  it("searchAll filters by source", async () => {
    const a = makeMockAdapter("alpha");
    const b = makeMockAdapter("beta");
    manager.register(a);
    manager.register(b);

    const result = await manager.searchAll("test", { sources: ["beta"] });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].source).toBe("beta");
    expect(result.sources.alpha).toBeUndefined();
    expect(result.sources.beta).toBeDefined();
  });

  it("healthCheckAll aggregates all adapter health", async () => {
    const ok = makeMockAdapter("ok-adapter");
    const bad = makeMockAdapter("bad-adapter", {
      healthCheck: vi.fn(async () => ({
        ok: false,
        latencyMs: 100,
        error: "connection refused",
      })),
    });

    manager.register(ok);
    manager.register(bad);

    const health = await manager.healthCheckAll();

    expect(health["ok-adapter"].ok).toBe(true);
    expect(health["bad-adapter"].ok).toBe(false);
    expect(health["bad-adapter"].error).toBe("connection refused");
  });
});

// =============================================================================
// MCP Registry Adapter (mocked fetch)
// =============================================================================

describe("McpRegistryAdapter — mocked fetch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("search returns paginated ExternalSkillSummary items", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          servers: [
            {
              id: "srv-1",
              name: "Server One",
              description: "The first server",
              repository: { url: "https://github.com/owner/srv-1" },
              version_detail: { version: "0.5.0" },
              downloads: 200,
              tags: ["devops"],
            },
            {
              id: "srv-2",
              name: "Server Two",
              description: "The second server",
              downloads: 50,
            },
          ],
          total: 2,
        }),
        { status: 200 },
      ),
    ) as any;

    const { McpRegistryAdapter } = await import(
      "../../server/skill-market/adapters/mcp-registry-adapter.js"
    );
    const adapter = new McpRegistryAdapter();
    const result = await adapter.search("devops", { limit: 10, offset: 0 });

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.source).toBe("mcp-registry");
    expect(result.items[0].externalId).toBe("mcp-registry:srv-1");
    expect(result.items[0].name).toBe("Server One");
    expect(result.items[0].author).toBe("owner");
    expect(result.items[0].version).toBe("0.5.0");
  });

  it("getDetails returns tools and config", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "my-server",
          name: "My Server",
          description: "A detailed server",
          repository: { url: "https://github.com/me/my-server" },
          version_detail: { version: "1.2.3" },
          packages: [{ env: { API_KEY: "Your API key", DB_TOKEN: "DB token" } }],
          readme: "# My Server\nReadme content",
          license: "MIT",
          downloads: 500,
          updated_at: "2026-01-15T00:00:00Z",
        }),
        { status: 200 },
      ),
    ) as any;

    const { McpRegistryAdapter } = await import(
      "../../server/skill-market/adapters/mcp-registry-adapter.js"
    );
    const adapter = new McpRegistryAdapter();
    const details = await adapter.getDetails("mcp-registry:my-server");

    expect(details.name).toBe("My Server");
    expect(details.version).toBe("1.2.3");
    expect(details.readme).toContain("Readme content");
    expect(details.license).toBe("MIT");
    expect(details.config).toBeDefined();
    expect(details.config!.API_KEY).toMatchObject({ secret: true });
    expect(details.config!.DB_TOKEN).toMatchObject({ secret: true });
  });

  it("healthCheck returns ok when server responds", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ servers: [] }), { status: 200 }),
    ) as any;

    const { McpRegistryAdapter } = await import(
      "../../server/skill-market/adapters/mcp-registry-adapter.js"
    );
    const adapter = new McpRegistryAdapter();
    const health = await adapter.healthCheck();

    expect(health.ok).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.error).toBeUndefined();
  });

  it("healthCheck returns error on HTTP failure", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("Service Unavailable", { status: 503 }),
    ) as any;

    const { McpRegistryAdapter } = await import(
      "../../server/skill-market/adapters/mcp-registry-adapter.js"
    );
    const adapter = new McpRegistryAdapter();
    const health = await adapter.healthCheck();

    expect(health.ok).toBe(false);
    expect(health.error).toBeDefined();
  });

  it("checkUpdates detects version changes", async () => {
    // getDetails will be called once per installed skill.
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "my-server",
          name: "My Server",
          description: "",
          version_detail: { version: "2.0.0" },
        }),
        { status: 200 },
      ),
    ) as any;

    const { McpRegistryAdapter } = await import(
      "../../server/skill-market/adapters/mcp-registry-adapter.js"
    );
    const adapter = new McpRegistryAdapter();
    const updates = await adapter.checkUpdates([
      { externalId: "mcp-registry:my-server", externalVersion: "1.0.0" },
    ]);

    expect(updates).toHaveLength(1);
    expect(updates[0].currentVersion).toBe("1.0.0");
    expect(updates[0].latestVersion).toBe("2.0.0");
  });
});

// =============================================================================
// Composio Adapter (mocked fetch)
// =============================================================================

describe("ComposioAdapter — mocked fetch", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.COMPOSIO_API_KEY;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.COMPOSIO_API_KEY = originalEnv;
    } else {
      delete process.env.COMPOSIO_API_KEY;
    }
  });

  it("search by use case returns action summaries", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              appName: "github",
              name: "create_issue",
              display_name: "Create Issue",
              description: "Creates a GitHub issue",
              tags: ["github", "issues"],
            },
          ],
        }),
        { status: 200 },
      ),
    ) as any;

    const { ComposioAdapter } = await import(
      "../../server/skill-market/adapters/composio-adapter.js"
    );
    const adapter = new ComposioAdapter("test-api-key");
    const result = await adapter.search("create github issue");

    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("Create Issue");
    expect(result.source).toBe("composio");
  });

  it("disabled when no API key", async () => {
    delete process.env.COMPOSIO_API_KEY;

    const { ComposioAdapter } = await import(
      "../../server/skill-market/adapters/composio-adapter.js"
    );
    const adapter = new ComposioAdapter("");
    expect(adapter.enabled).toBe(false);

    const result = await adapter.search("anything");
    expect(result.items).toHaveLength(0);
  });

  it("API key sent in X-API-Key header", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    ) as any;
    globalThis.fetch = fetchSpy;

    const { ComposioAdapter } = await import(
      "../../server/skill-market/adapters/composio-adapter.js"
    );
    const adapter = new ComposioAdapter("my-secret-key");
    await adapter.search("test");

    expect(fetchSpy).toHaveBeenCalled();
    const callArgs = fetchSpy.mock.calls[0];
    const headers = callArgs[1]?.headers;
    expect(headers?.["X-API-Key"]).toBe("my-secret-key");
  });
});

// =============================================================================
// CrewAI / GitHub Adapter (mocked fetch)
// =============================================================================

describe("CrewAiGithubAdapter — mocked fetch", () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken !== undefined) {
      process.env.GITHUB_TOKEN = originalToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("search returns GitHub repos", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          total_count: 1,
          items: [
            {
              full_name: "org/mcp-tool",
              name: "mcp-tool",
              description: "An MCP tool",
              owner: { login: "org" },
              topics: ["mcp-server"],
              stargazers_count: 150,
              html_url: "https://github.com/org/mcp-tool",
              license: { spdx_id: "Apache-2.0" },
              updated_at: "2026-03-01T00:00:00Z",
            },
          ],
        }),
        { status: 200 },
      ),
    ) as any;

    const { CrewAiGithubAdapter } = await import(
      "../../server/skill-market/adapters/crewai-github-adapter.js"
    );
    const adapter = new CrewAiGithubAdapter();
    const result = await adapter.search("mcp tool");

    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("mcp-tool");
    expect(result.items[0].author).toBe("org");
    expect(result.items[0].popularity).toBe(150);
    expect(result.source).toBe("crewai-github");
  });

  it("GITHUB_TOKEN sent in Authorization header when set", async () => {
    process.env.GITHUB_TOKEN = "ghp_test123";
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({ total_count: 0, items: [] }),
        { status: 200 },
      ),
    ) as any;
    globalThis.fetch = fetchSpy;

    const { CrewAiGithubAdapter } = await import(
      "../../server/skill-market/adapters/crewai-github-adapter.js"
    );
    const adapter = new CrewAiGithubAdapter();
    await adapter.search("test");

    expect(fetchSpy).toHaveBeenCalled();
    const callArgs = fetchSpy.mock.calls[0];
    const headers = callArgs[1]?.headers;
    expect(headers?.Authorization).toBe("Bearer ghp_test123");
  });
});

// =============================================================================
// Update Checker (RegistryManager-level, no DB)
// =============================================================================

describe("SkillUpdateChecker — integration", () => {
  let manager: RegistryManager;

  beforeEach(() => {
    manager = new RegistryManager();
  });

  it("check completes without crash and sets lastCheck", async () => {
    const { SkillUpdateChecker } = await import(
      "../../server/skill-market/update-checker.js"
    );
    const checker = new SkillUpdateChecker(manager, 60_000);

    // check() may succeed (no DB) or produce errors (DB exists but table missing).
    // Either way it should not throw and should set lastCheck.
    const result = await checker.check();
    expect(result.checked).toBeTypeOf("number");
    expect(result.updatesFound).toBeTypeOf("number");
    expect(result.errors).toBeInstanceOf(Array);

    // Confirm lastCheck is set.
    expect(checker.lastCheck).toBeInstanceOf(Date);
  });

  it("getPendingUpdates returns array after check", async () => {
    const { SkillUpdateChecker } = await import(
      "../../server/skill-market/update-checker.js"
    );
    const checker = new SkillUpdateChecker(manager, 60_000);
    await checker.check();

    const pending = checker.getPendingUpdates();
    expect(pending).toBeInstanceOf(Array);
  });

  it("applyAllUpdates counts results (zero when no pending)", async () => {
    const { SkillUpdateChecker } = await import(
      "../../server/skill-market/update-checker.js"
    );
    const checker = new SkillUpdateChecker(manager, 60_000);

    const result = await checker.applyAllUpdates();
    expect(result.updated).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("start and stop lifecycle works without errors", async () => {
    const { SkillUpdateChecker } = await import(
      "../../server/skill-market/update-checker.js"
    );
    const checker = new SkillUpdateChecker(manager, 60_000);

    checker.start();
    expect(checker.running).toBe(true);

    // Give the fire-and-forget check a tick to settle.
    await new Promise((r) => setTimeout(r, 50));

    checker.stop();
    expect(checker.running).toBe(false);
  });

  it("hasPendingUpdate returns false for unknown skill", async () => {
    const { SkillUpdateChecker } = await import(
      "../../server/skill-market/update-checker.js"
    );
    const checker = new SkillUpdateChecker(manager, 60_000);
    expect(checker.hasPendingUpdate("nonexistent")).toBe(false);
  });

  it("applyUpdate throws for unknown skill", async () => {
    const { SkillUpdateChecker } = await import(
      "../../server/skill-market/update-checker.js"
    );
    const checker = new SkillUpdateChecker(manager, 60_000);
    await expect(checker.applyUpdate("nonexistent")).rejects.toThrow(
      "No pending update",
    );
  });
});
