/**
 * Pure, DOM-free helpers backing the Inventory graph's legend/type-filter/
 * provenance-badge UI (#54 FE — client/src/pages/Inventory.tsx).
 *
 * Extracted out of the page component so the node/edge-type surface (which
 * types the legend lists, which options the type filter offers, which
 * provenance badge a skill/model node gets) is unit-testable without a DOM
 * rendering harness — this repo has no RTL/jsdom setup (no
 * @testing-library/react, no jsdom/happy-dom in package.json or
 * node_modules), and the established pattern for FE logic coverage here is
 * exactly this: extract pure functions/constants into client/src/lib and
 * test them under vitest's plain "node" environment (see the sibling
 * task-iterations.ts / task-form-logic.ts modules). See
 * tests/unit/inventory-graph-legend.test.ts.
 */
import type { InventoryNode, InventoryNodeType } from "@shared/types";

// ─── Node colour + short icon label ────────────────────────────────────────

export const NODE_COLOUR: Record<InventoryNodeType, string> = {
  connection: "#6366f1", // indigo
  skill: "#8b5cf6", // violet
  model: "#3b82f6", // blue
};

export const NODE_ICON_LABEL: Record<InventoryNodeType, string> = {
  connection: "Conn",
  skill: "Skill",
  model: "Mdl",
};

// ─── Graph legend ───────────────────────────────────────────────────────────

export const GRAPH_LEGEND_ITEMS: Array<{ type: InventoryNodeType; label: string }> = [
  { type: "connection", label: "Connection" },
  { type: "skill", label: "Skill" },
  { type: "model", label: "Model" },
];

// ─── Type filter ────────────────────────────────────────────────────────────

export type TypeFilter = InventoryNodeType | "all";

export const TYPE_FILTER_OPTIONS: Array<{ value: TypeFilter; label: string }> = [
  { value: "all", label: "All types" },
  { value: "connection", label: "Connection" },
  { value: "skill", label: "Skill" },
  { value: "model", label: "Model" },
];

// ─── Provenance badges (side panel) ────────────────────────────────────────

export interface ProvenanceBadge {
  kind: "git-sourced" | "manual" | "provider" | "active" | "inactive";
  label: string;
}

/**
 * Derives the provenance badge descriptor(s) for a skill/model node's side
 * panel: skill.metadata.sourceType ("git" vs "manual", + gitSourceId when
 * present) and model.metadata.provider/isActive. Connection nodes (and any
 * future node type) get no provenance badges.
 */
export function getNodeProvenanceBadges(
  node: Pick<InventoryNode, "type" | "metadata">,
): ProvenanceBadge[] {
  if (node.type === "skill") {
    const sourceType = node.metadata.sourceType as string | undefined;
    const gitSourceId = node.metadata.gitSourceId as string | null | undefined;
    if (sourceType === "git") {
      return [
        {
          kind: "git-sourced",
          label: gitSourceId ? `Git-sourced · ${gitSourceId}` : "Git-sourced",
        },
      ];
    }
    return [{ kind: "manual", label: "Manual" }];
  }

  if (node.type === "model") {
    const badges: ProvenanceBadge[] = [];
    const provider = node.metadata.provider as string | undefined;
    if (provider) badges.push({ kind: "provider", label: provider });
    const isActive = node.metadata.isActive as boolean | undefined;
    badges.push(
      isActive ? { kind: "active", label: "Active" } : { kind: "inactive", label: "Inactive" },
    );
    return badges;
  }

  return [];
}
