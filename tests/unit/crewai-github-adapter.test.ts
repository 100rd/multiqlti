/**
 * Unit tests for the CrewAI / GitHub Open Source Adapter (Phase 9.4, #206).
 *
 * All HTTP calls are intercepted via vi.stubGlobal("fetch", ...) so no real
 * network traffic is generated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CrewAiGithubAdapter } from "../../server/skill-market/adapters/crewai-github-adapter.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function fakeRepo(overrides: Record<string, unknown> = {}) {
  return {
    full_name: "crewAIInc/crewAI-tools",
    name: "crewAI-tools",
    description: "CrewAI agent tools",
    owner: { login: "crewAIInc" },
    topics: ["mcp-server", "agents"],
    stargazers_count: 420,
    html_url: "https://github.com/crewAIInc/crewAI-tools",
    license: { spdx_id: "MIT" },
    updated_at: "2026-01-15T10:00:00Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe("CrewAiGithubAdapter", () => {
  let adapter: CrewAiGithubAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;
  const savedToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    adapter = new CrewAiGithubAdapter();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedToken !== undefined) {
      process.env.GITHUB_TOKEN = savedToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  });

  // ── Identity ──────────────────────────────────────────────────────────────

  it("exposes the correct adapter identity", () => {
    expect(adapter.id).toBe("crewai-github");
    expect(adapter.name).toBe("CrewAI & Open Source");
    expect(adapter.enabled).toBe(true);
  });

  // ── search() ──────────────────────────────────────────────────────────────

  it("search returns repos mapped to ExternalSkillSummary", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ total_count: 1, items: [fakeRepo()] }),
    );

    const result = await adapter.search("crewai");

    expect(result.source).toBe("crewai-github");
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);

    const item = result.items[0];
    expect(item.externalId).toBe("crewai-github:crewAIInc/crewAI-tools");
    expect(item.name).toBe("crewAI-tools");
    expect(item.description).toBe("CrewAI agent tools");
    expect(item.author).toBe("crewAIInc");
    expect(item.version).toBe("latest");
    expect(item.popularity).toBe(420);
    expect(item.tags).toContain("mcp-server");
  });

  it("search passes query with topic:mcp-server filter and sort=stars", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ total_count: 0, items: [] }),
    );

    await adapter.search("langchain tools");

    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain("q=langchain%20tools+topic:mcp-server");
    expect(calledUrl).toContain("sort=stars");
  });

  it("search respects limit from options", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ total_count: 0, items: [] }),
    );

    await adapter.search("tools", { limit: 5 });

    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain("per_page=5");
  });

  it("search returns empty items when GitHub returns empty results", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ total_count: 0, items: [] }),
    );

    const result = await adapter.search("nonexistent-xyz");
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("search handles repos with null description and topics", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        total_count: 1,
        items: [fakeRepo({ description: null, topics: null, owner: null })],
      }),
    );

    const result = await adapter.search("bare");
    const item = result.items[0];
    expect(item.description).toBe("");
    expect(item.tags).toEqual([]);
    expect(item.author).toBe("unknown");
  });

  // ── getDetails() ──────────────────────────────────────────────────────────

  it("getDetails returns full repo details with correct fields", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(fakeRepo()));

    const details = await adapter.getDetails("crewai-github:crewAIInc/crewAI-tools");

    expect(details.externalId).toBe("crewai-github:crewAIInc/crewAI-tools");
    expect(details.name).toBe("crewAI-tools");
    expect(details.author).toBe("crewAIInc");
    expect(details.repository).toBe("https://github.com/crewAIInc/crewAI-tools");
    expect(details.license).toBe("MIT");
    expect(details.updatedAt).toEqual(new Date("2026-01-15T10:00:00Z"));
    expect(details.source).toBe("crewai-github");
    expect(details.version).toBe("latest");
  });

  it("getDetails calls the correct repo endpoint", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(fakeRepo()));

    await adapter.getDetails("crewai-github:modelcontextprotocol/servers");

    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toBe(
      "https://api.github.com/repos/modelcontextprotocol/servers",
    );
  });

  // ── install() ─────────────────────────────────────────────────────────────

  it("install returns a placeholder InstalledSkillResult", async () => {
    const result = await adapter.install("crewai-github:crewAIInc/crewAI-tools", "user-1");

    expect(result.localSkillId).toBe("github-crewAIInc-crewAI-tools");
    expect(result.externalId).toBe("crewai-github:crewAIInc/crewAI-tools");
    expect(result.externalVersion).toBe("latest");
    expect(result.source).toBe("crewai-github");
    expect(result.installedAt).toBeInstanceOf(Date);
  });

  // ── uninstall() ───────────────────────────────────────────────────────────

  it("uninstall completes without error", async () => {
    await expect(adapter.uninstall("github-crewAIInc-crewAI-tools")).resolves.toBeUndefined();
  });

  // ── checkUpdates() ────────────────────────────────────────────────────────

  it("checkUpdates returns an empty array", async () => {
    const updates = await adapter.checkUpdates([
      { externalId: "crewai-github:crewAIInc/crewAI-tools", externalVersion: "latest" },
    ]);
    expect(updates).toEqual([]);
  });

  // ── healthCheck() ─────────────────────────────────────────────────────────

  it("healthCheck uses rate_limit endpoint and reports ok", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ resources: {}, rate: { limit: 60 } }),
    );

    const health = await adapter.healthCheck();

    expect(health.ok).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.error).toBeUndefined();

    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://api.github.com/rate_limit");
  });

  it("healthCheck reports failure when fetch throws", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Network unreachable"));

    const health = await adapter.healthCheck();

    expect(health.ok).toBe(false);
    expect(health.error).toBe("Network unreachable");
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // ── Authentication ────────────────────────────────────────────────────────

  it("sends Authorization header when GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "ghp_test_token_123";

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ total_count: 0, items: [] }),
    );

    await adapter.search("anything");

    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ghp_test_token_123");
  });

  it("omits Authorization header when GITHUB_TOKEN is absent", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ total_count: 0, items: [] }),
    );

    await adapter.search("anything");

    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it("throws on 403 rate-limit response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: "API rate limit exceeded" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(adapter.search("test")).rejects.toThrow("GitHub API 403");
  });

  it("throws on 404 response in getDetails", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: "Not Found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      adapter.getDetails("crewai-github:nonexistent/repo"),
    ).rejects.toThrow("GitHub API 404");
  });

  // ── knownRepos ────────────────────────────────────────────────────────────

  it("exposes pre-configured known repos", () => {
    const known = adapter.getKnownRepos();
    expect(known.length).toBeGreaterThanOrEqual(2);
    expect(known[0].owner).toBe("crewAIInc");
    expect(known[1].repo).toBe("servers");
  });
});
