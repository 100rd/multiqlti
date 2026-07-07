import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../../server/storage.js";

describe("MemStorage", () => {
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
  });

  // ─── Models ────────────────────────────────────────────────────────────────

  describe("Models", () => {
    it("createModel() returns a model with generated id and timestamps", async () => {
      const model = await storage.createModel({
        name: "Test Model",
        slug: "test-model",
        provider: "mock",
        contextLimit: 4096,
        isActive: true,
        capabilities: [],
      });

      expect(model.id).toBeTruthy();
      expect(model.name).toBe("Test Model");
      expect(model.slug).toBe("test-model");
      expect(model.provider).toBe("mock");
      expect(model.isActive).toBe(true);
    });

    it("getModels() returns all models", async () => {
      await storage.createModel({ name: "A", slug: "a", provider: "mock", contextLimit: 4096, isActive: true, capabilities: [] });
      await storage.createModel({ name: "B", slug: "b", provider: "mock", contextLimit: 4096, isActive: true, capabilities: [] });

      const models = await storage.getModels();
      expect(models).toHaveLength(2);
    });

    it("getActiveModels() returns only active models", async () => {
      await storage.createModel({ name: "Active", slug: "active", provider: "mock", contextLimit: 4096, isActive: true, capabilities: [] });
      await storage.createModel({ name: "Inactive", slug: "inactive", provider: "mock", contextLimit: 4096, isActive: false, capabilities: [] });

      const active = await storage.getActiveModels();
      expect(active).toHaveLength(1);
      expect(active[0].slug).toBe("active");
    });

    it("getActiveModels() returns empty array when no active models", async () => {
      await storage.createModel({ name: "Off", slug: "off", provider: "mock", contextLimit: 4096, isActive: false, capabilities: [] });
      const active = await storage.getActiveModels();
      expect(active).toHaveLength(0);
    });

    it("getModelBySlug() returns the correct model", async () => {
      await storage.createModel({ name: "Target", slug: "target-slug", provider: "mock", contextLimit: 4096, isActive: true, capabilities: [] });

      const found = await storage.getModelBySlug("target-slug");
      expect(found).toBeDefined();
      expect(found?.name).toBe("Target");
    });

    it("getModelBySlug() returns undefined for unknown slug", async () => {
      const found = await storage.getModelBySlug("nonexistent");
      expect(found).toBeUndefined();
    });
  });
});
