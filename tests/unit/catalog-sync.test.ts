/**
 * Unit tests for reconcileModelCatalog (server/gateway/catalog-sync.ts).
 *
 * The reconciler aligns the DB model catalog with the LIVE provider-discovered
 * models (already gated by VISIBLE_PROVIDER_KEYS). Discovered models are
 * upserted + activated; any catalog model whose provider is not on the
 * allowlist, or whose slug is no longer discovered, is DEACTIVATED (never
 * deleted, so pipeline stage slugs still resolve).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../../server/storage.js";
import { reconcileModelCatalog } from "../../server/gateway/catalog-sync.js";

// ─── Discover payload shape (matches Gateway.discoverModels) ────────────────

type DiscoverPayload = Record<
  string,
  { available: boolean; models: unknown[]; error?: string }
>;

/** Minimal gateway stub exposing only discoverModels. */
function makeGateway(payload: DiscoverPayload | (() => Promise<DiscoverPayload>)) {
  return {
    discoverModels: async (): Promise<DiscoverPayload> =>
      typeof payload === "function" ? payload() : payload,
  };
}

/** A realistic allowlisted discover payload (antigravity + anthropic). */
function visibleDiscovery(): DiscoverPayload {
  return {
    antigravity: {
      available: true,
      models: [
        { id: "Gemini 2.5 Pro", name: "Gemini 2.5 Pro", provider: "antigravity", modelId: "Gemini 2.5 Pro", slug: "gemini-2-5-pro" },
      ],
    },
    anthropic: {
      available: true,
      models: [
        { id: "opus", name: "Claude Opus", provider: "anthropic", modelId: "opus", slug: "claude-opus", contextLimit: 200000 },
        { id: "sonnet", name: "Claude Sonnet", provider: "anthropic", modelId: "sonnet", slug: "claude-sonnet", contextLimit: 200000 },
      ],
    },
  };
}

async function seedStaleCatalog(storage: MemStorage): Promise<void> {
  // Non-allowlisted providers that must be deactivated.
  await storage.createModel({ name: "Llama 3 70B", slug: "llama3-70b", provider: "mock", contextLimit: 8192, capabilities: [], isActive: true });
  await storage.createModel({ name: "DeepSeek Coder", slug: "deepseek-coder", provider: "vllm", contextLimit: 16384, capabilities: [], isActive: true });
  await storage.createModel({ name: "Grok 3", slug: "grok-3", provider: "xai", contextLimit: 131072, capabilities: [], isActive: true });
  // Allowlisted-provider model whose slug is no longer discovered.
  await storage.createModel({ name: "Claude Sonnet 4.6 (stale)", slug: "claude-sonnet-4-6", provider: "anthropic", contextLimit: 200000, capabilities: [], isActive: true });
}

describe("reconcileModelCatalog", () => {
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
  });

  it("upserts discovered models as active", async () => {
    const result = await reconcileModelCatalog(storage, makeGateway(visibleDiscovery()));

    expect(result.upserted).toBe(3);
    const opus = await storage.getModelBySlug("claude-opus");
    expect(opus).toBeDefined();
    expect(opus?.isActive).toBe(true);
    expect(opus?.provider).toBe("anthropic");
    expect(opus?.modelId).toBe("opus");
    expect(opus?.contextLimit).toBe(200000);

    const gemini = await storage.getModelBySlug("gemini-2-5-pro");
    expect(gemini?.provider).toBe("antigravity");
    expect(gemini?.isActive).toBe(true);
  });

  it("deactivates non-allowlisted-provider models (vllm/mock/xai)", async () => {
    await seedStaleCatalog(storage);

    await reconcileModelCatalog(storage, makeGateway(visibleDiscovery()));

    const llama = await storage.getModelBySlug("llama3-70b");
    const deepseek = await storage.getModelBySlug("deepseek-coder");
    const grok = await storage.getModelBySlug("grok-3");
    expect(llama?.isActive).toBe(false);
    expect(deepseek?.isActive).toBe(false);
    expect(grok?.isActive).toBe(false);
    // Not deleted — still resolvable for pipeline stage slugs.
    expect(llama).toBeDefined();
    expect(grok).toBeDefined();
  });

  it("deactivates an allowlisted-provider model whose slug is not in discovery", async () => {
    await seedStaleCatalog(storage);

    const result = await reconcileModelCatalog(storage, makeGateway(visibleDiscovery()));

    const staleClaude = await storage.getModelBySlug("claude-sonnet-4-6");
    expect(staleClaude).toBeDefined();
    expect(staleClaude?.isActive).toBe(false);
    expect(result.deactivated).toBe(4); // mock, vllm, xai, + stale anthropic slug
  });

  it("does NOT wipe the catalog when discovery throws, but still deactivates non-allowlisted models", async () => {
    await seedStaleCatalog(storage);

    const throwingGateway = makeGateway(() => {
      throw new Error("agy CLI unavailable");
    });
    const result = await reconcileModelCatalog(storage, throwingGateway);

    expect(result.upserted).toBe(0);
    // Non-allowlisted (mock/vllm/xai) deactivated regardless of discovery failure.
    expect((await storage.getModelBySlug("llama3-70b"))?.isActive).toBe(false);
    expect((await storage.getModelBySlug("deepseek-coder"))?.isActive).toBe(false);
    expect((await storage.getModelBySlug("grok-3"))?.isActive).toBe(false);
    // Allowlisted-provider model NOT deactivated when discovery is unavailable
    // (we cannot tell if it is still valid — avoid wiping the catalog).
    expect((await storage.getModelBySlug("claude-sonnet-4-6"))?.isActive).toBe(true);
  });

  it("does NOT wipe allowlisted models when discovery returns no visible models", async () => {
    await seedStaleCatalog(storage);

    const emptyGateway = makeGateway({});
    await reconcileModelCatalog(storage, emptyGateway);

    expect((await storage.getModelBySlug("grok-3"))?.isActive).toBe(false);
    expect((await storage.getModelBySlug("claude-sonnet-4-6"))?.isActive).toBe(true);
  });

  it("dedupes discovered models by slug across provider aliases", async () => {
    const dupPayload: DiscoverPayload = {
      antigravity: {
        available: true,
        models: [{ id: "x", name: "X", provider: "antigravity", modelId: "x", slug: "dup-slug" }],
      },
      google: {
        available: true,
        models: [{ id: "x", name: "X", provider: "antigravity", modelId: "x", slug: "dup-slug" }],
      },
    };
    const result = await reconcileModelCatalog(storage, makeGateway(dupPayload));
    expect(result.upserted).toBe(1);
  });

  it("ignores unavailable provider groups and entries without a slug", async () => {
    const payload: DiscoverPayload = {
      anthropic: {
        available: true,
        models: [
          { id: "opus", name: "Claude Opus", provider: "anthropic", modelId: "opus", slug: "claude-opus", contextLimit: 200000 },
          { name: "No Slug", provider: "anthropic" }, // skipped: no slug and no id
        ],
      },
      antigravity: { available: false, models: [{ id: "y", name: "Y", provider: "antigravity", slug: "y" }] }, // skipped: unavailable
    };
    const result = await reconcileModelCatalog(storage, makeGateway(payload));
    expect(result.upserted).toBe(1);
    expect(await storage.getModelBySlug("claude-opus")).toBeDefined();
    expect(await storage.getModelBySlug("y")).toBeUndefined();
  });

  it("is idempotent — running twice leaves a stable catalog", async () => {
    await seedStaleCatalog(storage);
    const gateway = makeGateway(visibleDiscovery());

    await reconcileModelCatalog(storage, gateway);
    const first = await storage.getModels();

    const second = await reconcileModelCatalog(storage, gateway);
    const after = await storage.getModels();

    expect(after.length).toBe(first.length);
    // Second run upserts (updates) the same discovered set, deactivates nothing new.
    expect(second.deactivated).toBe(0);
    const activeSlugs = after.filter((m) => m.isActive).map((m) => m.slug).sort();
    expect(activeSlugs).toEqual(["claude-opus", "claude-sonnet", "gemini-2-5-pro"]);
  });

  it("updates an existing discovered model in place (no duplicate row)", async () => {
    await storage.createModel({ name: "Old Name", slug: "claude-opus", provider: "anthropic", modelId: "old", contextLimit: 100, capabilities: [], isActive: false });

    await reconcileModelCatalog(storage, makeGateway(visibleDiscovery()));

    const rows = (await storage.getModels()).filter((m) => m.slug === "claude-opus");
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("Claude Opus");
    expect(rows[0].modelId).toBe("opus");
    expect(rows[0].isActive).toBe(true);
  });
});
