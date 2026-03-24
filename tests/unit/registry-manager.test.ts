import { describe, it, expect, vi, beforeEach } from "vitest";
import { RegistryManager } from "../../server/skill-market/registry-manager.js";
import type {
  SkillRegistryAdapter,
  ExternalSkillResult,
  ExternalSkillDetails,
  InstalledSkillResult,
  SkillUpdateInfo,
  RegistrySearchOptions,
} from "../../server/skill-market/types.js";

// ─── Mock Adapter Factory ───────────────────────────────────────────────────

function createMockAdapter(
  overrides: Partial<SkillRegistryAdapter> = {},
): SkillRegistryAdapter {
  return {
    id: overrides.id ?? "mock-registry",
    name: overrides.name ?? "Mock Registry",
    icon: overrides.icon,
    enabled: overrides.enabled ?? true,
    search: overrides.search ?? vi.fn(async (): Promise<ExternalSkillResult> => ({
      items: [],
      total: 0,
      source: overrides.id ?? "mock-registry",
    })),
    getDetails: overrides.getDetails ?? vi.fn(async (): Promise<ExternalSkillDetails> => ({
      externalId: "ext-1",
      name: "Test Skill",
      description: "A test skill",
      author: "tester",
      version: "1.0.0",
      tags: [],
      source: overrides.id ?? "mock-registry",
    })),
    install: overrides.install ?? vi.fn(async (): Promise<InstalledSkillResult> => ({
      localSkillId: "local-1",
      externalId: "ext-1",
      externalVersion: "1.0.0",
      source: overrides.id ?? "mock-registry",
      installedAt: new Date(),
    })),
    uninstall: overrides.uninstall ?? vi.fn(async () => {}),
    checkUpdates: overrides.checkUpdates ?? vi.fn(async (): Promise<SkillUpdateInfo[]> => []),
    healthCheck: overrides.healthCheck ?? vi.fn(async () => ({ ok: true, latencyMs: 10 })),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("RegistryManager", () => {
  let manager: RegistryManager;

  beforeEach(() => {
    manager = new RegistryManager();
  });

  // ── Adapter lifecycle ────────────────────────────────────────────────────

  it("register adds an adapter", () => {
    const adapter = createMockAdapter({ id: "npm" });
    manager.register(adapter);
    expect(manager.listAdapters()).toHaveLength(1);
    expect(manager.listAdapters()[0].id).toBe("npm");
  });

  it("unregister removes an adapter", () => {
    const adapter = createMockAdapter({ id: "npm" });
    manager.register(adapter);
    manager.unregister("npm");
    expect(manager.listAdapters()).toHaveLength(0);
  });

  it("unregister is a no-op for unknown ids", () => {
    manager.unregister("nonexistent");
    expect(manager.listAdapters()).toHaveLength(0);
  });

  it("register overwrites adapter with same id", () => {
    manager.register(createMockAdapter({ id: "npm", name: "Old" }));
    manager.register(createMockAdapter({ id: "npm", name: "New" }));
    expect(manager.listAdapters()).toHaveLength(1);
    expect(manager.listAdapters()[0].name).toBe("New");
  });

  // ── Listing ──────────────────────────────────────────────────────────────

  it("listAdapters returns all registered adapters", () => {
    manager.register(createMockAdapter({ id: "a", enabled: true }));
    manager.register(createMockAdapter({ id: "b", enabled: false }));
    expect(manager.listAdapters()).toHaveLength(2);
  });

  it("listEnabled returns only enabled adapters", () => {
    manager.register(createMockAdapter({ id: "a", enabled: true }));
    manager.register(createMockAdapter({ id: "b", enabled: false }));
    manager.register(createMockAdapter({ id: "c", enabled: true }));
    const enabled = manager.listEnabled();
    expect(enabled).toHaveLength(2);
    expect(enabled.map((a) => a.id).sort()).toEqual(["a", "c"]);
  });

  // ── getAdapter ───────────────────────────────────────────────────────────

  it("getAdapter returns the correct adapter", () => {
    const adapter = createMockAdapter({ id: "github" });
    manager.register(adapter);
    expect(manager.getAdapter("github")).toBe(adapter);
  });

  it("getAdapter returns undefined for unknown id", () => {
    expect(manager.getAdapter("nonexistent")).toBeUndefined();
  });

  // ── searchAll ────────────────────────────────────────────────────────────

  it("searchAll merges results from multiple adapters", async () => {
    manager.register(
      createMockAdapter({
        id: "a",
        search: vi.fn(async () => ({
          items: [
            { externalId: "a1", name: "Skill A1", description: "", author: "x", version: "1.0.0", tags: [], popularity: 5, source: "a" },
          ],
          total: 1,
          source: "a",
        })),
      }),
    );
    manager.register(
      createMockAdapter({
        id: "b",
        search: vi.fn(async () => ({
          items: [
            { externalId: "b1", name: "Skill B1", description: "", author: "y", version: "2.0.0", tags: [], popularity: 10, source: "b" },
          ],
          total: 1,
          source: "b",
        })),
      }),
    );

    const res = await manager.searchAll("test");
    expect(res.results).toHaveLength(2);
    expect(res.total).toBe(2);
    expect(res.sources["a"].count).toBe(1);
    expect(res.sources["b"].count).toBe(1);
  });

  it("searchAll sorts merged results by popularity descending", async () => {
    manager.register(
      createMockAdapter({
        id: "a",
        search: vi.fn(async () => ({
          items: [
            { externalId: "a1", name: "Low Pop", description: "", author: "x", version: "1.0.0", tags: [], popularity: 2, source: "a" },
          ],
          total: 1,
          source: "a",
        })),
      }),
    );
    manager.register(
      createMockAdapter({
        id: "b",
        search: vi.fn(async () => ({
          items: [
            { externalId: "b1", name: "High Pop", description: "", author: "y", version: "1.0.0", tags: [], popularity: 100, source: "b" },
          ],
          total: 1,
          source: "b",
        })),
      }),
    );

    const res = await manager.searchAll("test");
    expect(res.results[0].name).toBe("High Pop");
    expect(res.results[1].name).toBe("Low Pop");
  });

  it("searchAll handles adapter failure gracefully", async () => {
    manager.register(
      createMockAdapter({
        id: "good",
        search: vi.fn(async () => ({
          items: [
            { externalId: "g1", name: "Good Skill", description: "", author: "x", version: "1.0.0", tags: [], popularity: 1, source: "good" },
          ],
          total: 1,
          source: "good",
        })),
      }),
    );
    manager.register(
      createMockAdapter({
        id: "bad",
        search: vi.fn(async () => {
          throw new Error("Network failure");
        }),
      }),
    );

    const res = await manager.searchAll("test");
    expect(res.results).toHaveLength(1);
    expect(res.sources["good"].count).toBe(1);
    expect(res.sources["good"].error).toBeUndefined();
    expect(res.sources["bad"].count).toBe(0);
    expect(res.sources["bad"].error).toBe("Network failure");
  });

  it("searchAll handles adapter timeout", async () => {
    manager.register(
      createMockAdapter({
        id: "slow",
        search: vi.fn(
          () => new Promise((resolve) => setTimeout(() => resolve({ items: [], total: 0, source: "slow" }), 10_000)),
        ),
      }),
    );

    const res = await manager.searchAll("test", { timeoutMs: 50 });
    expect(res.results).toHaveLength(0);
    expect(res.sources["slow"].error).toBe("Adapter timeout");
  });

  it("searchAll filters by sources when specified", async () => {
    manager.register(
      createMockAdapter({
        id: "a",
        search: vi.fn(async () => ({
          items: [{ externalId: "a1", name: "A", description: "", author: "", version: "1.0.0", tags: [], source: "a" }],
          total: 1,
          source: "a",
        })),
      }),
    );
    manager.register(
      createMockAdapter({
        id: "b",
        search: vi.fn(async () => ({
          items: [{ externalId: "b1", name: "B", description: "", author: "", version: "1.0.0", tags: [], source: "b" }],
          total: 1,
          source: "b",
        })),
      }),
    );

    const res = await manager.searchAll("test", { sources: ["a"] });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].source).toBe("a");
    expect(res.sources["b"]).toBeUndefined();
  });

  it("searchAll skips disabled adapters", async () => {
    const searchFn = vi.fn(async () => ({
      items: [{ externalId: "d1", name: "D", description: "", author: "", version: "1.0.0", tags: [], source: "disabled" }],
      total: 1,
      source: "disabled",
    }));
    manager.register(
      createMockAdapter({ id: "disabled", enabled: false, search: searchFn }),
    );

    const res = await manager.searchAll("test");
    expect(res.results).toHaveLength(0);
    expect(searchFn).not.toHaveBeenCalled();
  });

  // ── healthCheckAll ───────────────────────────────────────────────────────

  it("healthCheckAll aggregates results from all adapters", async () => {
    manager.register(
      createMockAdapter({
        id: "healthy",
        healthCheck: vi.fn(async () => ({ ok: true, latencyMs: 5 })),
      }),
    );
    manager.register(
      createMockAdapter({
        id: "sick",
        enabled: false,
        healthCheck: vi.fn(async () => ({
          ok: false,
          latencyMs: 999,
          error: "Connection refused",
        })),
      }),
    );

    const res = await manager.healthCheckAll();
    expect(res["healthy"].ok).toBe(true);
    expect(res["sick"].ok).toBe(false);
    expect(res["sick"].error).toBe("Connection refused");
  });

  it("healthCheckAll includes disabled adapters", async () => {
    manager.register(
      createMockAdapter({
        id: "disabled",
        enabled: false,
        healthCheck: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
      }),
    );

    const res = await manager.healthCheckAll();
    expect(res["disabled"]).toBeDefined();
    expect(res["disabled"].ok).toBe(true);
  });
});
