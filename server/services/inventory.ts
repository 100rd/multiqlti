/**
 * Inventory Service (issue #275)
 *
 * Builds a workspace-scoped dependency graph from storage data.
 *
 * INTERIM STATE (pipelines engine retirement, migration 0053): the graph is
 * connection-nodes only. It previously also derived pipeline/stage nodes
 * (from the now-removed `pipelines` table) plus skill/model nodes and
 * stage→{connection,skill,model} edges — all of which were sourced SOLELY
 * via a pipeline stage's config, with no other data source in this function.
 * `InventoryNodeType`/the FE legend (client/src/pages/Inventory.tsx) still
 * list "pipeline"/"stage"/"skill"/"model" — deliberately left broad so the
 * FE compiles untouched; those types simply never appear in a graph today.
 * Follow-up #54 repoints skill/model nodes to the skill/model registry and
 * connection-usage edges to a KEPT dependents source (consilium loops /
 * workspaces), then narrows the type and cleans the FE legend — mirroring
 * the WorkspaceTraces write-less-then-repoint pattern (task #29).
 *
 * Orphan detection: a connection node is flagged as an orphan when it has had
 * zero MCP tool-call activity in the last ORPHAN_DAYS days.
 */

import type { IStorage } from "../storage";
import type {
  InventoryNode,
  InventoryEdge,
  InventoryGraph,
} from "@shared/types";

// ─── Constants ────────────────────────────────────────────────────────────────

export const ORPHAN_DAYS = 30;

// ─── Build dependency graph ───────────────────────────────────────────────────

/**
 * Builds a connection-only dependency graph for the given workspace.
 * See the file-level INTERIM STATE note for why pipeline/stage/skill/model
 * nodes are absent for now.
 */
export async function buildInventoryGraph(
  storage: IStorage,
  workspaceId: string,
  nowMs = Date.now(),
): Promise<InventoryGraph> {
  const connections = await storage.getWorkspaceConnections(workspaceId);

  const nodes: InventoryNode[] = [];
  const edges: InventoryEdge[] = [];

  // ── Orphan detection: fetch usage metrics for each connection ─────────────

  const orphanThresholdMs = ORPHAN_DAYS * 24 * 60 * 60 * 1000;

  const connectionOrphanMap = new Map<string, boolean>();
  for (const conn of connections) {
    const metrics = await storage.getConnectionUsageMetrics(conn.id);
    const lastActivityMs = resolveLastActivityMs(metrics.callsPerDay, nowMs);
    const isOrphan = lastActivityMs === null || (nowMs - lastActivityMs) >= orphanThresholdMs;
    connectionOrphanMap.set(conn.id, isOrphan);
  }

  // ── Connection nodes ──────────────────────────────────────────────────────

  for (const conn of connections) {
    nodes.push({
      id: conn.id,
      type: "connection",
      label: conn.name,
      metadata: {
        connectionType: conn.type,
        status: conn.status,
        lastTestedAt: conn.lastTestedAt,
        hasSecrets: conn.hasSecrets,
      },
      isOrphan: connectionOrphanMap.get(conn.id) ?? true,
    });
  }

  return { nodes, edges };
}

// ─── Orphan query ─────────────────────────────────────────────────────────────

/**
 * Returns inventory nodes (connection type) that have had no activity for
 * >= ORPHAN_DAYS days.
 */
export async function getOrphanNodes(
  storage: IStorage,
  workspaceId: string,
  nowMs = Date.now(),
): Promise<InventoryNode[]> {
  const graph = await buildInventoryGraph(storage, workspaceId, nowMs);
  return graph.nodes.filter((n) => n.type === "connection" && n.isOrphan === true);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Derives the epoch-ms timestamp of the most recent activity from the
 * calls-per-day series. Returns null when the series is empty or all-zeros.
 */
function resolveLastActivityMs(
  callsPerDay: Array<{ date: string; count: number }>,
  nowMs: number,
): number | null {
  // Find the most recent date with count > 0
  const activeDays = callsPerDay
    .filter((d) => d.count > 0)
    .map((d) => Date.parse(d.date))
    .filter((ms) => !isNaN(ms));

  if (activeDays.length === 0) return null;
  return Math.max(...activeDays);
}
