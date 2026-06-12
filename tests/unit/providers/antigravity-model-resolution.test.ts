/**
 * Unit tests for AntigravityProvider model-id -> agy LABEL resolution
 * (fix/antigravity-model-label-resolution).
 *
 * Root cause being fixed: callers (consensus voters, the debate gemini critic,
 * chat) pass the catalog SLUG (e.g. "gemini-3-1-pro-low") as the model id, but
 * the `agy` CLI only recognizes the HUMAN LABEL (e.g. "Gemini 3.1 Pro (Low)").
 * The provider must resolve an incoming SLUG *or* LABEL to a valid label before
 * invoking the CLI, using the live `agy models` label list.
 *
 * The label loader is INJECTED (a fake `loadModelLabels`) so:
 *   - no real `agy` process is spawned,
 *   - resolution is deterministic,
 *   - the caching contract (load-once) is assertable via the loader call count.
 *
 * The CLI adapter (`invokeAntigravityCli`) is mocked to assert the `model` that
 * reaches the CLI is the LABEL, not the slug.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderMessage } from "../../../shared/types.js";

// ─── Mock the CLI adapter (no real `agy` spawned) ────────────────────────────
const invokeAntigravityCli = vi.fn();
vi.mock("../../../server/gateway/providers/antigravity-cli.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../server/gateway/providers/antigravity-cli.js")
  >("../../../server/gateway/providers/antigravity-cli.js");
  return {
    ...actual,
    invokeAntigravityCli: (...args: unknown[]) => invokeAntigravityCli(...args),
  };
});

import { AntigravityProvider } from "../../../server/gateway/providers/antigravity.js";

const USER_MESSAGES: ProviderMessage[] = [{ role: "user", content: "What is 2+2?" }];

/** The 8 roster labels exactly as `agy models` would report them. */
const ROSTER_LABELS: readonly string[] = [
  "Gemini 3.1 Pro (High)",
  "Gemini 3.1 Pro (Low)",
  "Gemini 3.5 Flash (High)",
  "Gemini 3.5 Flash (Medium)",
  "Gemini 3.5 Flash (Low)",
  "GPT-OSS 120B (Medium)",
  "Claude Sonnet 4.6 (Thinking)",
  "Claude Opus 4.6 (Thinking)",
];

/** slug -> expected label, mirroring slugifyModelLabel(label) === slug. */
const SLUG_TO_LABEL: ReadonlyArray<readonly [string, string]> = [
  ["gemini-3-1-pro-high", "Gemini 3.1 Pro (High)"],
  ["gemini-3-1-pro-low", "Gemini 3.1 Pro (Low)"],
  ["gemini-3-5-flash-high", "Gemini 3.5 Flash (High)"],
  ["gemini-3-5-flash-medium", "Gemini 3.5 Flash (Medium)"],
  ["gemini-3-5-flash-low", "Gemini 3.5 Flash (Low)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
  ["claude-sonnet-4-6-thinking", "Claude Sonnet 4.6 (Thinking)"],
  ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"],
];

function makeLoader(labels: readonly string[] = ROSTER_LABELS) {
  return vi.fn(async () => [...labels]);
}

function mockCliText(text = "ok", promptBytes = 100): void {
  invokeAntigravityCli.mockResolvedValueOnce({ text, promptBytes });
}

function cliModelArg(callIndex = 0): string {
  return (invokeAntigravityCli.mock.calls[callIndex][0] as { model: string }).model;
}

describe("AntigravityProvider — resolveModelLabel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a catalog SLUG to the live agy LABEL (the core fix)", async () => {
    const loadModelLabels = makeLoader();
    const provider = new AntigravityProvider({ loadModelLabels });

    const label = await provider.resolveModelLabel("gemini-3-1-pro-low");

    expect(label).toBe("Gemini 3.1 Pro (Low)");
  });

  it("passes an exact LABEL through unchanged", async () => {
    const loadModelLabels = makeLoader();
    const provider = new AntigravityProvider({ loadModelLabels });

    const label = await provider.resolveModelLabel("Gemini 3.5 Flash (Medium)");

    expect(label).toBe("Gemini 3.5 Flash (Medium)");
  });

  it("returns the default model when the id is empty/whitespace", async () => {
    const loadModelLabels = makeLoader();
    const provider = new AntigravityProvider({
      loadModelLabels,
      defaultModel: "Gemini 3.5 Flash (Medium)",
    });

    expect(await provider.resolveModelLabel("")).toBe("Gemini 3.5 Flash (Medium)");
    expect(await provider.resolveModelLabel("   ")).toBe("Gemini 3.5 Flash (Medium)");
  });

  it("falls back to the id as-is for an unknown model (last resort)", async () => {
    const loadModelLabels = makeLoader();
    const provider = new AntigravityProvider({ loadModelLabels });

    const label = await provider.resolveModelLabel("totally-unknown-model");

    expect(label).toBe("totally-unknown-model");
  });

  it("falls back gracefully (no throw) when the label list cannot be loaded", async () => {
    const loadModelLabels = vi.fn(async () => {
      throw new Error("agy models failed: not logged in");
    });
    const provider = new AntigravityProvider({ loadModelLabels });

    // A slug cannot be mapped without the list, so it falls back to the id as-is.
    await expect(provider.resolveModelLabel("gemini-3-1-pro-low")).resolves.toBe(
      "gemini-3-1-pro-low",
    );
  });

  it("uses the default model on load failure when the id is empty", async () => {
    const loadModelLabels = vi.fn(async () => {
      throw new Error("agy models failed");
    });
    const provider = new AntigravityProvider({
      loadModelLabels,
      defaultModel: "Gemini 3.5 Flash (Medium)",
    });

    await expect(provider.resolveModelLabel("")).resolves.toBe("Gemini 3.5 Flash (Medium)");
  });

  it("round-trips every roster slug -> label", async () => {
    const loadModelLabels = makeLoader();
    const provider = new AntigravityProvider({ loadModelLabels });

    for (const [slug, expectedLabel] of SLUG_TO_LABEL) {
      expect(await provider.resolveModelLabel(slug)).toBe(expectedLabel);
    }
  });
});

describe("AntigravityProvider — caching the label list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads the label list at most once across N resolves", async () => {
    const loadModelLabels = makeLoader();
    const provider = new AntigravityProvider({ loadModelLabels });

    await provider.resolveModelLabel("gemini-3-1-pro-low");
    await provider.resolveModelLabel("gemini-3-5-flash-high");
    await provider.resolveModelLabel("Gemini 3.1 Pro (High)");

    expect(loadModelLabels).toHaveBeenCalledTimes(1);
  });

  it("retries the loader after a failed load (does not cache failure forever)", async () => {
    const loadModelLabels = vi
      .fn<[], Promise<string[]>>()
      .mockRejectedValueOnce(new Error("transient agy failure"))
      .mockResolvedValueOnce([...ROSTER_LABELS]);
    const provider = new AntigravityProvider({ loadModelLabels });

    // First resolve: load fails -> graceful fallback to id-as-is.
    expect(await provider.resolveModelLabel("gemini-3-1-pro-low")).toBe("gemini-3-1-pro-low");
    // Second resolve: loader retried, succeeds -> slug now maps to label.
    expect(await provider.resolveModelLabel("gemini-3-1-pro-low")).toBe("Gemini 3.1 Pro (Low)");
    expect(loadModelLabels).toHaveBeenCalledTimes(2);
  });
});

describe("AntigravityProvider — complete() sends the LABEL to the CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the resolved LABEL (not the slug) to invokeAntigravityCli", async () => {
    const loadModelLabels = makeLoader();
    const provider = new AntigravityProvider({ loadModelLabels });
    mockCliText("4", 40);

    const result = await provider.complete("gemini-3-1-pro-low", USER_MESSAGES);

    expect(cliModelArg()).toBe("Gemini 3.1 Pro (Low)");
    expect(result.content).toBe("4");
    expect(result.finishReason).toBe("stop");
  });

  it("only loads the label list once across multiple complete() calls", async () => {
    const loadModelLabels = makeLoader();
    const provider = new AntigravityProvider({ loadModelLabels });
    mockCliText("a");
    mockCliText("b");

    await provider.complete("gemini-3-1-pro-low", USER_MESSAGES);
    await provider.complete("gemini-3-5-flash-high", USER_MESSAGES);

    expect(loadModelLabels).toHaveBeenCalledTimes(1);
    expect(cliModelArg(0)).toBe("Gemini 3.1 Pro (Low)");
    expect(cliModelArg(1)).toBe("Gemini 3.5 Flash (High)");
  });

  it("still sends a usable model when the label list fails to load", async () => {
    const loadModelLabels = vi.fn(async () => {
      throw new Error("agy models failed");
    });
    const provider = new AntigravityProvider({
      loadModelLabels,
      defaultModel: "Gemini 3.5 Flash (Medium)",
    });
    mockCliText("ok");

    await provider.complete("", USER_MESSAGES);

    expect(cliModelArg()).toBe("Gemini 3.5 Flash (Medium)");
  });
});
