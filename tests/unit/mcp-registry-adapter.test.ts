/**
 * Unit tests for McpRegistryAdapter.
 *
 * All HTTP calls are intercepted via global fetch mocking — no real network
 * requests are made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpRegistryAdapter } from "../../server/skill-market/adapters/mcp-registry-adapter.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE_URL = "https://registry.modelcontextprotocol.io";

function makeServer(overrides: Record<string, unknown> = {}) {
  return {
    id: "github-mcp-server",
    name: "GitHub MCP Server",
    description: "Interact with GitHub repositories",
    repository: { url: "https://github.com/modelcontextprotocol/servers" },
    version_detail: { version: "1.2.0" },
    packages: [
      {
        registry_name: "npm",
        name: "@modelcontextprotocol/server-github",
        version: "1.2.0",
        runtime: "node",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
      },
    ],
    tools: [
      { name: "create_issue", description: "Create a GitHub issue" },
      { name: "list_repos", description: "List repositories" },
    ],
    tags: ["github", "vcs"],
    downloads: 5000,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe("McpRegistryAdapter", () => {
  let adapter: McpRegistryAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new McpRegistryAdapter();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Metadata ────────────────────────────────────────────────────────────

  it("exposes correct adapter metadata", () => {
    expect(adapter.id).toBe("mcp-registry");
    expect(adapter.name).toBe("MCP Registry");
    expect(adapter.enabled).toBe(true);
  });

  // ── search() ────────────────────────────────────────────────────────────

  it("search returns mapped ExternalSkillSummary items", async () => {
    const server = makeServer();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ servers: [server], total: 1 }),
    );

    const result = await adapter.search("github");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const calledUrl = fetchSpy.mock.calls[0][0];
    expect(calledUrl).toContain(`${BASE_URL}/v0/servers?q=github`);

    expect(result.source).toBe("mcp-registry");
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);

    const item = result.items[0];
    expect(item.externalId).toBe("mcp-registry:github-mcp-server");
    expect(item.name).toBe("GitHub MCP Server");
    expect(item.description).toBe("Interact with GitHub repositories");
    expect(item.author).toBe("modelcontextprotocol");
    expect(item.version).toBe("1.2.0");
    expect(item.tags).toEqual(["github", "vcs", "npm"]);
    expect(item.popularity).toBe(5000);
  });

  it("search handles empty results", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ servers: [], total: 0 }),
    );

    const result = await adapter.search("nonexistent-xyz");
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("search passes query and pagination params to the API", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ servers: [], total: 0 }),
    );

    await adapter.search("slack", { limit: 10, offset: 5 });

    const calledUrl: string = fetchSpy.mock.calls[0][0];
    expect(calledUrl).toContain("q=slack");
    expect(calledUrl).toContain("limit=10");
    expect(calledUrl).toContain("offset=5");
  });

  it("search encodes special characters in query", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ servers: [], total: 0 }),
    );

    await adapter.search("hello world & more");

    const calledUrl: string = fetchSpy.mock.calls[0][0];
    expect(calledUrl).toContain("q=hello%20world%20%26%20more");
  });

  it("search uses default author when repository URL is missing", async () => {
    const server = makeServer({ repository: undefined });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ servers: [server], total: 1 }),
    );

    const result = await adapter.search("test");
    expect(result.items[0].author).toBe("unknown");
  });

  it("search uses server id as name when name is missing", async () => {
    const server = makeServer({ name: undefined });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ servers: [server], total: 1 }),
    );

    const result = await adapter.search("test");
    expect(result.items[0].name).toBe("github-mcp-server");
  });

  // ── getDetails() ────────────────────────────────────────────────────────

  it("getDetails returns full ExternalSkillDetails with tools", async () => {
    const server = {
      ...makeServer(),
      readme: "# GitHub MCP Server\nFull readme here.",
      license: "MIT",
      updated_at: "2026-01-15T10:00:00Z",
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(server));

    const details = await adapter.getDetails("mcp-registry:github-mcp-server");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const calledUrl: string = fetchSpy.mock.calls[0][0];
    expect(calledUrl).toBe(`${BASE_URL}/v0/servers/github-mcp-server`);

    expect(details.externalId).toBe("mcp-registry:github-mcp-server");
    expect(details.name).toBe("GitHub MCP Server");
    expect(details.author).toBe("modelcontextprotocol");
    expect(details.version).toBe("1.2.0");
    expect(details.readme).toContain("GitHub MCP Server");
    expect(details.license).toBe("MIT");
    expect(details.repository).toBe(
      "https://github.com/modelcontextprotocol/servers",
    );
    expect(details.updatedAt).toEqual(new Date("2026-01-15T10:00:00Z"));
  });

  it("getDetails extracts required config from packages env", async () => {
    const server = makeServer({
      packages: [
        {
          registry_name: "npm",
          name: "@mcp/server-github",
          env: {
            GITHUB_TOKEN: "Personal access token",
            GITHUB_API_KEY: "API key for enterprise",
            LOG_LEVEL: "Logging verbosity",
          },
        },
      ],
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse(server));

    const details = await adapter.getDetails("mcp-registry:github-mcp-server");

    expect(details.config).toBeDefined();
    const config = details.config as Record<
      string,
      { description: string; secret: boolean }
    >;
    expect(config.GITHUB_TOKEN.secret).toBe(true);
    expect(config.GITHUB_API_KEY.secret).toBe(true);
    expect(config.LOG_LEVEL.secret).toBe(false);
    expect(config.LOG_LEVEL.description).toBe("Logging verbosity");
  });

  // ── healthCheck() ──────────────────────────────────────────────────────

  it("healthCheck returns ok when registry is reachable", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ servers: [], total: 0 }),
    );

    const result = await adapter.healthCheck();

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("healthCheck returns error when registry is unreachable", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Network failure"));

    const result = await adapter.healthCheck();

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Network failure");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // ── checkUpdates() ─────────────────────────────────────────────────────

  it("checkUpdates detects version mismatch", async () => {
    const server = makeServer({ version_detail: { version: "2.0.0" } });
    fetchSpy.mockResolvedValueOnce(jsonResponse(server));

    const updates = await adapter.checkUpdates([
      { externalId: "mcp-registry:github-mcp-server", externalVersion: "1.0.0" },
    ]);

    expect(updates).toHaveLength(1);
    expect(updates[0].currentVersion).toBe("1.0.0");
    expect(updates[0].latestVersion).toBe("2.0.0");
    expect(updates[0].externalId).toBe("mcp-registry:github-mcp-server");
  });

  it("checkUpdates skips when versions match", async () => {
    const server = makeServer({ version_detail: { version: "1.0.0" } });
    fetchSpy.mockResolvedValueOnce(jsonResponse(server));

    const updates = await adapter.checkUpdates([
      { externalId: "mcp-registry:github-mcp-server", externalVersion: "1.0.0" },
    ]);

    expect(updates).toHaveLength(0);
  });

  it("checkUpdates handles unreachable entries gracefully", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("timeout"));

    const updates = await adapter.checkUpdates([
      { externalId: "mcp-registry:broken-server", externalVersion: "1.0.0" },
    ]);

    expect(updates).toHaveLength(0);
  });

  // ── install() ──────────────────────────────────────────────────────────

  it("install returns placeholder result with correct fields", async () => {
    const server = makeServer();
    fetchSpy.mockResolvedValueOnce(jsonResponse(server));

    const result = await adapter.install(
      "mcp-registry:github-mcp-server",
      "user-123",
    );

    expect(result.localSkillId).toBe("mcp-github-mcp-server");
    expect(result.externalId).toBe("mcp-registry:github-mcp-server");
    expect(result.externalVersion).toBe("1.2.0");
    expect(result.source).toBe("mcp-registry");
    expect(result.installedAt).toBeInstanceOf(Date);
  });

  // ── extractGithubOwner() ──────────────────────────────────────────────

  it("extractGithubOwner parses GitHub URL correctly", () => {
    expect(
      adapter.extractGithubOwner("https://github.com/anthropic/mcp-server"),
    ).toBe("anthropic");
    expect(
      adapter.extractGithubOwner("https://github.com/org-name/repo"),
    ).toBe("org-name");
    expect(adapter.extractGithubOwner(undefined)).toBeUndefined();
    expect(adapter.extractGithubOwner("https://gitlab.com/foo/bar")).toBeUndefined();
  });

  // ── HTTP error handling ───────────────────────────────────────────────

  it("throws on non-ok HTTP status from search", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404 }),
    );

    await expect(adapter.search("test")).rejects.toThrow(
      "MCP Registry HTTP 404",
    );
  });
});
