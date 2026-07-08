/**
 * Inventory Service (issue #275)
 *
 * Builds a workspace-scoped dependency graph from storage data.
 *
 * DERIVATION (#54 — registry-backed redesign, follow-up to the pipelines
 * engine retirement, migration 0053):
 *   - `connection` nodes — `storage.getWorkspaceConnections(workspaceId)`, workspace-scoped.
 *   - `skill` nodes — `storage.getSkills()`, project-scoped (tenant context), ALL
 *     skills in the project (not filtered to this workspace — skills have no
 *     workspace FK). Metadata surfaces `sourceType` ("manual"|"git") and
 *     `gitSourceId` for provenance (git-sync rows are a parallel, separate PR).
 *   - `model` nodes — `storage.getModels()`, project-or-global catalog. Metadata
 *     surfaces `provider` and `isActive`.
 *   - `"compatible"` edges (model ↔ skill) — `storage.getAllModelSkillBindings()`
 *     (bulk read, avoids an N+1 per-model lookup), a curated capability match,
 *     NOT an observed-usage signal.
 *   - `"uses"` edges (task → model) — `storage.getWorkspaceTaskModelUsage(workspaceId)`,
 *     genuine observed usage but SPARSE/best-effort: only tasks with both a
 *     non-null `modelSlug` and a `workspaceId` matching this workspace are
 *     included (`tasks.workspaceId` is populated only via the consilium loop
 *     DEV handoff path — most tasks have none, so this edge set is partial by
 *     design, not a bug).
 *   - NO skill-usage edge (workspace/task → skill): no kept table supports this
 *     link (no `skillId` FK exists on `tasks`/`taskExecutions`/consilium-loop
 *     tables — the only skill-adjacent FK is `skill_proposals.skillId`, a
 *     nullable DREAM-4 feedback reference, "NEVER an FK write target" per its
 *     own schema comment). Deliberately not fabricated via a `teamId` string
 *     match — too imprecise, would risk false dependency edges.
 *
 * `InventoryNodeType` is narrowed to "connection"|"skill"|"model" (dropped
 * "pipeline"|"stage", dead since the pipelines-engine retirement — no source
 * data ever populated them). `InventoryEdge.relation` drops "contains"
 * (pipeline→stage, now dead) for "compatible"|"uses" (see @shared/types.ts).
 * FE (client/src/pages/Inventory.tsx) legend/filter cleanup is a separate,
 * follow-up PR.
 *
 * Orphan detection: a connection node is flagged as an orphan when it has had
 * zero MCP tool-call activity in the last ORPHAN_DAYS days. Skill/model nodes
 * are never flagged as orphans (no comparable per-node usage series exists).
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
 * Builds the workspace dependency graph: connection nodes (workspace-scoped)
 * plus skill/model registry nodes (project-scoped) and their compatible/uses
 * edges. See the file-level DERIVATION note for exact sourcing per node/edge.
 */
export async function buildInventoryGraph(
  storage: IStorage,
  workspaceId: string,
  nowMs = Date.now(),
): Promise<InventoryGraph> {
  const connections = await storage.getWorkspaceConnections(workspaceId);
  const skills = await storage.getSkills();
  const models = await storage.getModels();
  const bindings = await storage.getAllModelSkillBindings();
  const taskModelUsage = await storage.getWorkspaceTaskModelUsage(workspaceId);

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

  // ── Skill nodes ────────────────────────────────────────────────────────────

  for (const skill of skills) {
    nodes.push({
      id: skill.id,
      type: "skill",
      label: skill.name,
      metadata: {
        sourceType: skill.sourceType,
        gitSourceId: skill.gitSourceId,
      },
    });
  }

  // ── Model nodes ────────────────────────────────────────────────────────────
  // model_skill_bindings.modelId and tasks.modelSlug both reference a model by
  // its stable slug-ish identifier (route validation at
  // server/routes/model-skill-bindings.ts accepts either models.slug or the
  // provider-side models.modelId) — index both so edge resolution below is a
  // single map lookup, no N+1 per-edge query.

  const modelNodeIdByIdentifier = new Map<string, string>();
  for (const model of models) {
    modelNodeIdByIdentifier.set(model.slug, model.id);
    if (model.modelId) modelNodeIdByIdentifier.set(model.modelId, model.id);
    nodes.push({
      id: model.id,
      type: "model",
      label: model.name,
      metadata: {
        provider: model.provider,
        isActive: model.isActive,
      },
    });
  }

  // ── "compatible" edges: model ↔ skill (curated bindings) ───────────────────

  for (const binding of bindings) {
    const modelNodeId = modelNodeIdByIdentifier.get(binding.modelId);
    if (!modelNodeId) continue; // binding references a model outside this catalog
    edges.push({ source: modelNodeId, target: binding.skillId, relation: "compatible" });
  }

  // ── "uses" edges: task → model (sparse, observed — see file header) ────────

  for (const usage of taskModelUsage) {
    const modelNodeId = modelNodeIdByIdentifier.get(usage.modelSlug);
    if (!modelNodeId) continue; // modelSlug doesn't resolve to a known model row
    edges.push({ source: usage.taskId, target: modelNodeId, relation: "uses" });
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
