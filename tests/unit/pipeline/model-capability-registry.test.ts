/**
 * Unit tests for ModelCapabilityRegistry — model capability lookup and routing.
 */
import { describe, it, expect } from "vitest";
import { ModelCapabilityRegistry } from "../../../server/pipeline/model-capability-registry.js";

describe("ModelCapabilityRegistry", () => {
  describe("getCapabilities — default lookup", () => {
    it("returns capabilities for known model prefix (claude-3.5-sonnet)", () => {
      const registry = new ModelCapabilityRegistry();
      const caps = registry.getCapabilities("claude-3.5-sonnet-20241022");

      expect(caps.costTier).toBe("high");
      expect(caps.agenticCapability).toBe(true);
      expect(caps.strengths).toContain("reasoning");
      expect(caps.contextWindow).toBe(200_000);
    });

    it("returns capabilities for known model prefix (gemini-2.0-flash)", () => {
      const registry = new ModelCapabilityRegistry();
      const caps = registry.getCapabilities("gemini-2.0-flash-exp");

      expect(caps.costTier).toBe("low");
      expect(caps.recommendedForSplitting).toBe(true);
      expect(caps.contextWindow).toBe(1_000_000);
    });

    it("returns capabilities for mock model", () => {
      const registry = new ModelCapabilityRegistry();
      const caps = registry.getCapabilities("mock");

      expect(caps.maxConcurrentAgents).toBe(100);
      expect(caps.rateLimit).toBe(1000);
    });

    it("returns fallback capabilities for unknown model", () => {
      const registry = new ModelCapabilityRegistry();
      const caps = registry.getCapabilities("totally-unknown-model");

      expect(caps.maxConcurrentAgents).toBe(3);
      expect(caps.costTier).toBe("medium");
      expect(caps.agenticCapability).toBe(false);
    });

    it("returns grok-3-mini as non-agentic", () => {
      const registry = new ModelCapabilityRegistry();
      const caps = registry.getCapabilities("grok-3-mini-fast");

      expect(caps.agenticCapability).toBe(false);
      expect(caps.costTier).toBe("low");
    });
  });

  describe("custom overrides", () => {
    it("setCapabilities overrides default lookup", () => {
      const registry = new ModelCapabilityRegistry();
      registry.setCapabilities("my-custom-model", {
        maxConcurrentAgents: 15,
        supportedMergeStrategies: ["concatenate"],
        recommendedForSplitting: true,
        rateLimit: 200,
        costTier: "low",
        strengths: ["custom-task"],
        agenticCapability: true,
        contextWindow: 64_000,
      });

      const caps = registry.getCapabilities("my-custom-model");
      expect(caps.maxConcurrentAgents).toBe(15);
      expect(caps.strengths).toContain("custom-task");
    });

    it("override takes precedence over prefix match", () => {
      const registry = new ModelCapabilityRegistry();
      registry.setCapabilities("claude-3.5-sonnet-custom", {
        maxConcurrentAgents: 99,
        supportedMergeStrategies: ["concatenate"],
        recommendedForSplitting: true,
        rateLimit: 500,
        costTier: "low",
        strengths: ["fast"],
        agenticCapability: false,
        contextWindow: 32_000,
      });

      const caps = registry.getCapabilities("claude-3.5-sonnet-custom");
      expect(caps.maxConcurrentAgents).toBe(99);
      expect(caps.costTier).toBe("low");
    });

    it("removeOverride reverts to default", () => {
      const registry = new ModelCapabilityRegistry();
      registry.setCapabilities("mock", {
        maxConcurrentAgents: 1,
        supportedMergeStrategies: [],
        recommendedForSplitting: false,
        rateLimit: 1,
        costTier: "high",
        strengths: [],
        agenticCapability: false,
        contextWindow: 1000,
      });

      expect(registry.getCapabilities("mock").maxConcurrentAgents).toBe(1);

      registry.removeOverride("mock");
      expect(registry.getCapabilities("mock").maxConcurrentAgents).toBe(100);
    });
  });

  describe("helper methods", () => {
    it("isAgenticCapable returns correct value", () => {
      const registry = new ModelCapabilityRegistry();
      expect(registry.isAgenticCapable("claude-3.5-sonnet")).toBe(true);
      expect(registry.isAgenticCapable("grok-3-mini")).toBe(false);
    });

    it("getCostTier returns correct tier", () => {
      const registry = new ModelCapabilityRegistry();
      expect(registry.getCostTier("claude-3.5-haiku")).toBe("low");
      expect(registry.getCostTier("grok-3")).toBe("medium");
      expect(registry.getCostTier("claude-3.5-sonnet")).toBe("high");
    });

    it("getRateLimit returns correct limit", () => {
      const registry = new ModelCapabilityRegistry();
      expect(registry.getRateLimit("mock")).toBe(1000);
      expect(registry.getRateLimit("grok-3")).toBe(30);
    });
  });

  describe("selectModelForSubtask", () => {
    it("returns null for empty model list", () => {
      const registry = new ModelCapabilityRegistry();
      const result = registry.selectModelForSubtask([], "medium", []);
      expect(result).toBeNull();
    });

    it("prefers low-cost model for low complexity", () => {
      const registry = new ModelCapabilityRegistry();
      const result = registry.selectModelForSubtask(
        ["claude-3.5-sonnet", "claude-3.5-haiku"],
        "low",
        [],
      );
      expect(result).toBe("claude-3.5-haiku");
    });

    it("penalizes non-agentic models for high complexity", () => {
      const registry = new ModelCapabilityRegistry();
      const result = registry.selectModelForSubtask(
        ["grok-3-mini", "grok-3"],
        "high",
        [],
      );
      expect(result).toBe("grok-3");
    });

    it("favors models matching required strengths", () => {
      const registry = new ModelCapabilityRegistry();
      const result = registry.selectModelForSubtask(
        ["claude-3.5-haiku", "claude-3.5-sonnet"],
        "medium",
        ["reasoning", "review"],
      );
      expect(result).toBe("claude-3.5-sonnet");
    });

    it("returns the only available model", () => {
      const registry = new ModelCapabilityRegistry();
      const result = registry.selectModelForSubtask(
        ["mock"],
        "medium",
        ["code"],
      );
      expect(result).toBe("mock");
    });
  });
});
