/**
 * Unit tests for the local-provider de-emphasis logic (issue #346).
 *
 * These pure functions/constants are the single source of truth the Settings
 * UI consumes to decide:
 *   - which providers are "local / experimental" (vLLM / Ollama / LM Studio),
 *   - that the collapsible block is collapsed on a clean install, and
 *   - whether any local provider is active (drives default model-picker state).
 */

import { describe, it, expect } from "vitest";
import {
  LOCAL_PROVIDER_KEYS,
  CLOUD_PROVIDER_KEYS,
  LOCAL_MODELS_SECTION_TITLE,
  LOCAL_MODELS_SECTION_DEFAULT_OPEN,
  isLocalProvider,
  isCloudProvider,
  hasActiveLocalProvider,
  VISIBLE_PROVIDER_KEYS,
  isVisibleProvider,
} from "../../client/src/lib/local-providers.js";

describe("local provider keys", () => {
  it("treats vLLM, Ollama and LM Studio as local providers", () => {
    expect([...LOCAL_PROVIDER_KEYS]).toEqual(["vllm", "ollama", "lmstudio"]);
  });

  it("keeps the prominent cloud providers separate from local ones", () => {
    expect([...CLOUD_PROVIDER_KEYS]).toEqual(["anthropic", "google", "xai"]);
    for (const key of CLOUD_PROVIDER_KEYS) {
      expect(isLocalProvider(key)).toBe(false);
    }
  });
});

describe("collapsible block defaults", () => {
  it("is labelled in Russian as experimental", () => {
    expect(LOCAL_MODELS_SECTION_TITLE).toBe("Local models (experimental)");
  });

  it("is COLLAPSED by default on a clean install", () => {
    expect(LOCAL_MODELS_SECTION_DEFAULT_OPEN).toBe(false);
  });
});

describe("isLocalProvider()", () => {
  it("returns true for every local provider key", () => {
    expect(isLocalProvider("vllm")).toBe(true);
    expect(isLocalProvider("ollama")).toBe(true);
    expect(isLocalProvider("lmstudio")).toBe(true);
  });

  it("returns false for cloud providers and unknown keys", () => {
    expect(isLocalProvider("anthropic")).toBe(false);
    expect(isLocalProvider("google")).toBe(false);
    expect(isLocalProvider("xai")).toBe(false);
    expect(isLocalProvider("mock")).toBe(false);
    expect(isLocalProvider("")).toBe(false);
  });
});

describe("isCloudProvider()", () => {
  it("returns true for cloud providers", () => {
    expect(isCloudProvider("anthropic")).toBe(true);
    expect(isCloudProvider("google")).toBe(true);
    expect(isCloudProvider("xai")).toBe(true);
  });

  it("returns false for local providers", () => {
    expect(isCloudProvider("vllm")).toBe(false);
    expect(isCloudProvider("ollama")).toBe(false);
    expect(isCloudProvider("lmstudio")).toBe(false);
  });
});

describe("visible-provider allowlist", () => {
  it("mirrors the server VISIBLE_PROVIDER_KEYS set (anthropic/antigravity/google)", () => {
    expect([...VISIBLE_PROVIDER_KEYS]).toEqual(["anthropic", "antigravity", "google"]);
  });

  it("isVisibleProvider() returns true only for allowlisted providers", () => {
    expect(isVisibleProvider("anthropic")).toBe(true);
    expect(isVisibleProvider("antigravity")).toBe(true);
    expect(isVisibleProvider("google")).toBe(true);
  });

  it("isVisibleProvider() hides local + billed providers (vllm/ollama/lmstudio/xai/mock)", () => {
    expect(isVisibleProvider("vllm")).toBe(false);
    expect(isVisibleProvider("ollama")).toBe(false);
    expect(isVisibleProvider("lmstudio")).toBe(false);
    expect(isVisibleProvider("xai")).toBe(false);
    expect(isVisibleProvider("mock")).toBe(false);
    expect(isVisibleProvider("")).toBe(false);
  });
});

describe("hasActiveLocalProvider()", () => {
  it("is false on a clean install (no status)", () => {
    expect(hasActiveLocalProvider(null)).toBe(false);
    expect(hasActiveLocalProvider(undefined)).toBe(false);
  });

  it("is false when every local provider is inactive", () => {
    expect(
      hasActiveLocalProvider({ vllm: false, ollama: false, lmstudio: false }),
    ).toBe(false);
    expect(hasActiveLocalProvider({})).toBe(false);
  });

  it("is true once a local provider endpoint has been enabled", () => {
    expect(hasActiveLocalProvider({ vllm: true })).toBe(true);
    expect(hasActiveLocalProvider({ ollama: true })).toBe(true);
    expect(hasActiveLocalProvider({ lmstudio: true })).toBe(true);
  });

  it("ignores cloud-provider fields it does not own", () => {
    const status = { vllm: false, ollama: false, lmstudio: false } as Record<string, boolean>;
    status.anthropic = true;
    expect(hasActiveLocalProvider(status)).toBe(false);
  });
});
