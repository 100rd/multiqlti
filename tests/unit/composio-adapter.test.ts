/**
 * Unit tests for ComposioAdapter.
 *
 * All HTTP calls are intercepted via global fetch mocking -- no real network
 * requests are made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ComposioAdapter } from "../../server/skill-market/adapters/composio-adapter.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE_URL = "https://backend.composio.dev/api/v1";
const TEST_API_KEY = "test-composio-api-key-abc123";

function makeAction(overrides: Record<string, unknown> = {}) {
  return {
    appName: "github",
    appId: "github-app-id",
    name: "GITHUB_CREATE_ISSUE",
    display_name: "Create GitHub Issue",
    description: "Creates an issue in a GitHub repository",
    tags: ["github", "issues"],
    logo: "https://composio.dev/icons/github.svg",
    parameters: {
      properties: {
        repo: { type: "string" },
        title: { type: "string" },
      },
      required: ["repo", "title"],
    },
    ...overrides,
  };
}

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    appId: "github-app-id",
    key: "github",
    name: "GitHub",
    description: "GitHub integration toolkit",
    logo: "https://composio.dev/icons/github.svg",
    categories: ["developer-tools", "vcs"],
    tags: ["git"],
    docs: "https://docs.composio.dev/apps/github",
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

describe("ComposioAdapter", () => {
  let adapter: ComposioAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new ComposioAdapter(TEST_API_KEY);
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Metadata & Enablement ──────────────────────────────────────────────

  it("exposes correct adapter metadata", () => {
    expect(adapter.id).toBe("composio");
    expect(adapter.name).toBe("Composio");
    expect(adapter.enabled).toBe(true);
  });

  it("is disabled when no API key is provided", () => {
    const noKeyAdapter = new ComposioAdapter("");
    expect(noKeyAdapter.enabled).toBe(false);
  });

  it("is disabled when constructed with undefined key and no env var", () => {
    const original = process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_API_KEY;
    try {
      const noKeyAdapter = new ComposioAdapter(undefined);
      expect(noKeyAdapter.enabled).toBe(false);
    } finally {
      if (original !== undefined) {
        process.env.COMPOSIO_API_KEY = original;
      }
    }
  });

  // ── search() ───────────────────────────────────────────────────────────

  it("search returns mapped results from actions endpoint when query is provided", async () => {
    const action = makeAction();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ items: [action] }),
    );

    const result = await adapter.search("create issue");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [calledUrl, calledOpts] = fetchSpy.mock.calls[0];
    expect(calledUrl).toContain(`${BASE_URL}/actions?useCase=create%20issue`);
    expect(calledUrl).toContain("limit=20");

    expect(result.source).toBe("composio");
    expect(result.items).toHaveLength(1);

    const item = result.items[0];
    expect(item.externalId).toBe("composio:github");
    expect(item.name).toBe("Create GitHub Issue");
    expect(item.description).toBe("Creates an issue in a GitHub repository");
    expect(item.author).toBe("composio");
    expect(item.version).toBe("latest");
    expect(item.tags).toEqual(["github", "issues"]);
    expect(item.icon).toBe("https://composio.dev/icons/github.svg");
  });

  it("search by use case passes custom limit", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await adapter.search("send email", { limit: 5 });

    const calledUrl: string = fetchSpy.mock.calls[0][0];
    expect(calledUrl).toContain("useCase=send%20email");
    expect(calledUrl).toContain("limit=5");
  });

  it("search lists apps when query is empty", async () => {
    const app = makeApp();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ items: [app] }));

    const result = await adapter.search("");

    const calledUrl: string = fetchSpy.mock.calls[0][0];
    expect(calledUrl).toContain(`${BASE_URL}/apps?limit=20`);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].externalId).toBe("composio:github");
    expect(result.items[0].name).toBe("GitHub");
    expect(result.items[0].tags).toEqual(["developer-tools", "vcs", "git"]);
  });

  it("search returns empty when adapter is disabled", async () => {
    const disabledAdapter = new ComposioAdapter("");
    const result = await disabledAdapter.search("anything");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("search encodes special characters in query", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await adapter.search("send & receive email");

    const calledUrl: string = fetchSpy.mock.calls[0][0];
    expect(calledUrl).toContain("useCase=send%20%26%20receive%20email");
  });

  // ── API key in headers ─────────────────────────────────────────────────

  it("sends API key in X-API-Key header", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await adapter.search("test");

    const calledOpts = fetchSpy.mock.calls[0][1];
    expect(calledOpts.headers["X-API-Key"]).toBe(TEST_API_KEY);
    expect(calledOpts.headers["Accept"]).toBe("application/json");
  });

  // ── getDetails() ───────────────────────────────────────────────────────

  it("getDetails returns toolkit with actions as tools", async () => {
    const app = makeApp();
    const action = makeAction();
    const action2 = makeAction({
      name: "GITHUB_LIST_REPOS",
      display_name: "List Repositories",
      description: "List user repositories",
      parameters: { properties: {}, required: [] },
    });

    // First call: GET /apps/{appName}, second: GET /actions?appNames={appName}
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(app))
      .mockResolvedValueOnce(jsonResponse({ items: [action, action2] }));

    const details = await adapter.getDetails("composio:github");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const appUrl: string = fetchSpy.mock.calls[0][0];
    const actionsUrl: string = fetchSpy.mock.calls[1][0];
    expect(appUrl).toBe(`${BASE_URL}/apps/github`);
    expect(actionsUrl).toContain(`${BASE_URL}/actions?appNames=github`);

    expect(details.externalId).toBe("composio:github");
    expect(details.name).toBe("GitHub");
    expect(details.description).toBe("GitHub integration toolkit");
    expect(details.author).toBe("composio");
    expect(details.version).toBe("latest");
    expect(details.icon).toBe("https://composio.dev/icons/github.svg");
    expect(details.homepage).toBe("https://docs.composio.dev/apps/github");
    expect(details.tags).toEqual(["developer-tools", "vcs", "git"]);
    expect(details.readme).toContain("Available Actions");
    expect(details.readme).toContain("Create GitHub Issue");
    expect(details.readme).toContain("List Repositories");
  });

  it("getDetails extracts required config from action parameters", async () => {
    const app = makeApp();
    const action = makeAction({
      parameters: {
        properties: { api_key: {}, repo: {} },
        required: ["api_key", "repo"],
      },
    });
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(app))
      .mockResolvedValueOnce(jsonResponse({ items: [action] }));

    const details = await adapter.getDetails("composio:github");

    expect(details.config).toBeDefined();
    const config = details.config as Record<
      string,
      { description: string; secret: boolean }
    >;
    expect(config.api_key.secret).toBe(true);
    expect(config.repo.secret).toBe(false);
  });

  // ── healthCheck() ──────────────────────────────────────────────────────

  it("healthCheck returns ok when API is reachable", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ items: [] }));

    const result = await adapter.healthCheck();

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();

    const calledUrl: string = fetchSpy.mock.calls[0][0];
    expect(calledUrl).toBe(`${BASE_URL}/apps?limit=1`);
  });

  it("healthCheck returns error when API is unreachable", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Connection refused"));

    const result = await adapter.healthCheck();

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Connection refused");
  });

  it("healthCheck returns error when adapter is disabled (no API key)", async () => {
    const disabledAdapter = new ComposioAdapter("");

    const result = await disabledAdapter.healthCheck();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("COMPOSIO_API_KEY");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── Rate limit handling ────────────────────────────────────────────────

  it("handles 429 rate limit gracefully", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Rate limit exceeded", { status: 429 }),
    );

    await expect(adapter.search("test")).rejects.toThrow(
      "Composio rate limit exceeded (429)",
    );
  });

  // ── checkUpdates() ─────────────────────────────────────────────────────

  it("checkUpdates always returns empty (SaaS, always latest)", async () => {
    const updates = await adapter.checkUpdates([
      { externalId: "composio:github", externalVersion: "latest" },
      { externalId: "composio:slack", externalVersion: "latest" },
    ]);

    expect(updates).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── install() ──────────────────────────────────────────────────────────

  it("install returns placeholder result with correct fields", async () => {
    const result = await adapter.install("composio:github", "user-456");

    expect(result.localSkillId).toBe("composio-github");
    expect(result.externalId).toBe("composio:github");
    expect(result.externalVersion).toBe("latest");
    expect(result.source).toBe("composio");
    expect(result.installedAt).toBeInstanceOf(Date);
  });

  // ── HTTP error handling ────────────────────────────────────────────────

  it("throws on non-ok HTTP status from search", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );

    await expect(adapter.search("test")).rejects.toThrow(
      "Composio HTTP 401",
    );
  });

  it("search handles empty items array gracefully", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ items: [] }));

    const result = await adapter.search("nonexistent-xyz");
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
