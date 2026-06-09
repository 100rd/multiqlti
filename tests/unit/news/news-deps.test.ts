/**
 * Unit tests for buildNewsLiveDeps gating (Security H3 — board.enabled opt-in).
 *
 * The board internal feed must activate ONLY when backend === "omniscience" AND
 * omniscience.board.enabled === true. Otherwise boardProvider is null and the
 * generator degrades (internalDegraded). These cases never open an MCP client,
 * so no network/token is needed.
 */
import { describe, it, expect } from "vitest";
import { ConfigSchema, type AppConfig } from "../../../server/config/schema";
import { buildNewsLiveDeps, parseSummary } from "../../../server/news/news-deps";
import type { Gateway } from "../../../server/gateway/index";

/** Minimal Gateway stand-in — buildNewsLiveDeps only closes over it, never calls it here. */
const fakeGateway = {} as unknown as Gateway;

function configWith(overrides: {
  backend?: "local" | "omniscience";
  boardEnabled?: boolean;
}): AppConfig {
  return ConfigSchema.parse({
    memory: {
      retrieval: {
        backend: overrides.backend ?? "local",
        omniscience: {
          board: { enabled: overrides.boardEnabled ?? false },
        },
      },
    },
  });
}

describe("buildNewsLiveDeps — H3 board.enabled gating", () => {
  it("backend=local → boardProvider null (degraded), external+summarize still wired", async () => {
    const live = await buildNewsLiveDeps(configWith({ backend: "local" }), fakeGateway);
    expect(live.deps.boardProvider).toBeNull();
    expect(typeof live.deps.fetchExternal).toBe("function");
    expect(typeof live.deps.summarize).toBe("function");
    // searchInternal yields nothing when the board is off.
    await expect(live.deps.searchInternal("2026-06-09T05:00:00.000Z")).resolves.toEqual([]);
    await live.close();
  });

  it("backend=omniscience but board.enabled=false → boardProvider null (no silent activation)", async () => {
    const live = await buildNewsLiveDeps(
      configWith({ backend: "omniscience", boardEnabled: false }),
      fakeGateway,
    );
    expect(live.deps.boardProvider).toBeNull();
    await expect(live.deps.searchInternal("2026-06-09T05:00:00.000Z")).resolves.toEqual([]);
    await live.close();
  });

  it("close() is always safe to call when no client was opened", async () => {
    const live = await buildNewsLiveDeps(configWith({ backend: "local" }), fakeGateway);
    await expect(live.close()).resolves.toBeUndefined();
  });
});

describe("parseSummary — defensive gateway-output parsing", () => {
  it("extracts {summary, whyRelevant} from JSON output", () => {
    const r = parseSummary(JSON.stringify({ summary: "s", whyRelevant: "w" }), "title");
    expect(r).toEqual({ summary: "s", whyRelevant: "w" });
  });

  it("falls back to raw content as the summary when not JSON", () => {
    const r = parseSummary("just prose", "title");
    expect(r.summary).toBe("just prose");
    expect(r.whyRelevant).toBe("");
  });

  it("falls back to the title when content is empty", () => {
    const r = parseSummary("", "Fallback Title");
    expect(r.summary).toBe("Fallback Title");
  });
});
