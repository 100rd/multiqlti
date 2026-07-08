/**
 * Unit tests for the Inventory graph's legend/type-filter/provenance-badge
 * PURE helpers (#54 FE — client/src/pages/Inventory.tsx). Like
 * task-iterations-logic.test.ts / task-form.test.ts, these exercise the pure
 * helpers behind the page without a DOM renderer (the repo has no jsdom /
 * @testing-library/react) — they import from @/lib/inventory-graph-legend
 * (no React):
 *   - NODE_COLOUR / NODE_ICON_LABEL / GRAPH_LEGEND_ITEMS — the legend lists
 *     exactly connection/skill/model (the retired pipeline/stage node types
 *     are gone for real, see #54 BE's DERIVATION note).
 *   - TYPE_FILTER_OPTIONS — the type filter's options match the legend types
 *     (+ "all").
 *   - getNodeProvenanceBadges — skill (git-sourced incl. gitSourceId, vs
 *     manual) and model (provider + active/inactive) badge selection, run
 *     against a mixed-graph-shaped fixture (connection + skill + model
 *     nodes), plus the "no badges for a connection node" case.
 */
import { describe, it, expect } from "vitest";
import {
  NODE_COLOUR,
  NODE_ICON_LABEL,
  GRAPH_LEGEND_ITEMS,
  TYPE_FILTER_OPTIONS,
  getNodeProvenanceBadges,
} from "../../client/src/lib/inventory-graph-legend";
import type { InventoryNode } from "../../shared/types";

const ALL_NODE_TYPES = ["connection", "skill", "model"] as const;

// ─── A mixed-graph-shaped fixture (connection + skill + model nodes) ────────

function mixedGraphFixture(): InventoryNode[] {
  return [
    {
      id: "conn-1",
      type: "connection",
      label: "GitHub Conn",
      metadata: { connectionType: "github", status: "active" },
    },
    {
      id: "skill-git",
      type: "skill",
      label: "Code Review",
      metadata: { sourceType: "git", gitSourceId: "git-src-1" },
    },
    {
      id: "skill-manual",
      type: "skill",
      label: "Summarizer",
      metadata: { sourceType: "manual", gitSourceId: null },
    },
    {
      id: "model-active",
      type: "model",
      label: "Sonnet",
      metadata: { provider: "anthropic", isActive: true },
    },
    {
      id: "model-inactive",
      type: "model",
      label: "Legacy Model",
      metadata: { provider: "openai", isActive: false },
    },
  ];
}

// ─── Legend ──────────────────────────────────────────────────────────────────

describe("GRAPH_LEGEND_ITEMS", () => {
  it("lists exactly connection, skill, model — no pipeline/stage remnants", () => {
    expect(GRAPH_LEGEND_ITEMS.map((i) => i.type)).toEqual(ALL_NODE_TYPES.slice());
    for (const item of GRAPH_LEGEND_ITEMS) {
      expect(item.type).not.toBe("pipeline");
      expect(item.type).not.toBe("stage");
    }
  });
});

describe("NODE_COLOUR / NODE_ICON_LABEL", () => {
  it("has exactly one entry per node type, no pipeline/stage keys", () => {
    expect(Object.keys(NODE_COLOUR).sort()).toEqual(ALL_NODE_TYPES.slice().sort());
    expect(Object.keys(NODE_ICON_LABEL).sort()).toEqual(ALL_NODE_TYPES.slice().sort());
    expect(NODE_COLOUR).not.toHaveProperty("pipeline");
    expect(NODE_COLOUR).not.toHaveProperty("stage");
    expect(NODE_ICON_LABEL).not.toHaveProperty("pipeline");
    expect(NODE_ICON_LABEL).not.toHaveProperty("stage");
  });
});

// ─── Type filter ─────────────────────────────────────────────────────────────

describe("TYPE_FILTER_OPTIONS", () => {
  it("matches the legend types plus 'all', no pipeline/stage remnants", () => {
    expect(TYPE_FILTER_OPTIONS.map((o) => o.value)).toEqual(["all", ...ALL_NODE_TYPES]);
    for (const opt of TYPE_FILTER_OPTIONS) {
      expect(opt.value).not.toBe("pipeline");
      expect(opt.value).not.toBe("stage");
    }
  });
});

// ─── Provenance badges (mixed-graph fixture) ─────────────────────────────────

describe("getNodeProvenanceBadges", () => {
  const fixture = mixedGraphFixture();

  it("returns a git-sourced badge (with gitSourceId) for a git skill", () => {
    const skill = fixture.find((n) => n.id === "skill-git")!;
    const badges = getNodeProvenanceBadges(skill);
    expect(badges).toEqual([{ kind: "git-sourced", label: "Git-sourced · git-src-1" }]);
  });

  it("returns a manual badge for a manual skill", () => {
    const skill = fixture.find((n) => n.id === "skill-manual")!;
    const badges = getNodeProvenanceBadges(skill);
    expect(badges).toEqual([{ kind: "manual", label: "Manual" }]);
  });

  it("omits the gitSourceId suffix when git-sourced with no gitSourceId", () => {
    const skill: InventoryNode = {
      id: "skill-git-no-src",
      type: "skill",
      label: "X",
      metadata: { sourceType: "git", gitSourceId: null },
    };
    expect(getNodeProvenanceBadges(skill)).toEqual([
      { kind: "git-sourced", label: "Git-sourced" },
    ]);
  });

  it("returns provider + active badges for an active model", () => {
    const model = fixture.find((n) => n.id === "model-active")!;
    const badges = getNodeProvenanceBadges(model);
    expect(badges).toEqual([
      { kind: "provider", label: "anthropic" },
      { kind: "active", label: "Active" },
    ]);
  });

  it("returns provider + inactive badges for an inactive model", () => {
    const model = fixture.find((n) => n.id === "model-inactive")!;
    const badges = getNodeProvenanceBadges(model);
    expect(badges).toEqual([
      { kind: "provider", label: "openai" },
      { kind: "inactive", label: "Inactive" },
    ]);
  });

  it("returns no badges for a connection node", () => {
    const conn = fixture.find((n) => n.id === "conn-1")!;
    expect(getNodeProvenanceBadges(conn)).toEqual([]);
  });

  it("renders skill+model badges for every registry node in the mixed-graph fixture", () => {
    const registryNodes = fixture.filter((n) => n.type === "skill" || n.type === "model");
    for (const node of registryNodes) {
      expect(getNodeProvenanceBadges(node).length).toBeGreaterThan(0);
    }
  });
});
