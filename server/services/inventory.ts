/**
 * Inventory Service (issue #275)
 *
 * Builds a workspace-scoped dependency graph from storage data.
 *
 * Node types: connection, pipeline, stage, skill, model
 * Edge types:
 *   pipeline → stage  (contains)
 *   stage → connection (uses)
 *   stage → skill      (uses)
 *   stage → model      (uses)
 *
 * Orphan detection: a connection node is flagged as an orphan when it has had
 * zero MCP tool-call activity in the last ORPHAN_DAYS days.
 */

import type { IStorage } from "../storage";
import type {
  InventoryNode,
  InventoryEdge,
  InventoryGraph,
  ConnectionDependent,
  PipelineStageConfig,
} from "@shared/types";
import type { Pipeline } from "@shared/schema";

// ─── Constants ────────────────────────────────────────────────────────────────

export const ORPHAN_DAYS = 30;

// ─── Helper: unique ID for synthetic stage nodes ─────────────────────────────

function stageNodeId(pipelineId: string, stageIndex: number): string {
  return `stage:${pipelineId}:${stageIndex}`;
}

// ─── Build dependency graph ───────────────────────────────────────────────────

/**
 * Builds a full dependency graph for all entities in the given workspace.
 *
 * The graph is built from:
 *   - workspace connections
 *   - all pipelines (scoped to workspace via the connection membership)
 *   - skills / models referenced by pipeline stages
 *
 * Because pipelines are not directly scoped to a workspace in the current
 * data model, we include every pipeline whose stages reference at least one
 * connection in this workspace. Additionally, all other pipelines are included
 * so the graph always contains the full set of pipelines in the system.
 */
export async function buildInventoryGraph(
  storage: IStorage,
  workspaceId: string,
  nowMs = Date.now(),
): Promise<InventoryGraph> {
  const [connections, pipelines, skills, models] = await Promise.all([
    storage.getWorkspaceConnections(workspaceId),
    storage.getPipelines(),
    storage.getSkills(),
    storage.getModels(),
  ]);

  const nodes: InventoryNode[] = [];
  const edges: InventoryEdge[] = [];

  // ── Index lookups ─────────────────────────────────────────────────────────

  const connectionIdSet = new Set(connections.map((c) => c.id));
  const skillMap = new Map(skills.map((s) => [s.id, s]));
  const modelMap = new Map(models.map((m) => [m.slug, m]));

  // Used to avoid duplicate model/skill nodes
  const addedSkillNodes = new Set<string>();
  const addedModelNodes = new Set<string>();

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

  // ── Pipeline + stage nodes + edges ────────────────────────────────────────

  for (const pipeline of pipelines) {
    const rawStages = (pipeline.stages ?? []) as unknown[];
    const stageConfigs = rawStages as Record<string, unknown>[];

    nodes.push({
      id: pipeline.id,
      type: "pipeline",
      label: pipeline.name,
      metadata: {
        stageCount: stageConfigs.length,
        isTemplate: pipeline.isTemplate,
        createdAt: pipeline.createdAt,
      },
    });

    for (let idx = 0; idx < stageConfigs.length; idx++) {
      const stage = stageConfigs[idx] as Partial<PipelineStageConfig>;
      const sId = stageNodeId(pipeline.id, idx);

      nodes.push({
        id: sId,
        type: "stage",
        label: stage.teamId ?? `Stage ${idx}`,
        metadata: {
          teamId: stage.teamId,
          modelSlug: stage.modelSlug,
          skillId: stage.skillId,
          stageIndex: idx,
          pipelineId: pipeline.id,
        },
      });

      // pipeline → stage (contains)
      edges.push({ source: pipeline.id, target: sId, relation: "contains" });

      // stage → connection (uses)
      if (Array.isArray(stage.allowedConnections)) {
        for (const connId of stage.allowedConnections) {
          if (connectionIdSet.has(connId)) {
            edges.push({ source: sId, target: connId, relation: "uses" });
          }
        }
      }

      // stage → skill (uses)
      if (stage.skillId && skillMap.has(stage.skillId)) {
        if (!addedSkillNodes.has(stage.skillId)) {
          const skill = skillMap.get(stage.skillId)!;
          nodes.push({
            id: `skill:${skill.id}`,
            type: "skill",
            label: skill.name,
            metadata: { skillId: skill.id, teamId: skill.teamId },
          });
          addedSkillNodes.add(stage.skillId);
        }
        edges.push({ source: sId, target: `skill:${stage.skillId}`, relation: "uses" });
      }

      // stage → model (uses)
      if (stage.modelSlug) {
        const modelKey = `model:${stage.modelSlug}`;
        if (!addedModelNodes.has(stage.modelSlug)) {
          const model = modelMap.get(stage.modelSlug);
          nodes.push({
            id: modelKey,
            type: "model",
            label: model ? model.name : stage.modelSlug,
            metadata: {
              slug: stage.modelSlug,
              provider: model?.provider ?? null,
            },
          });
          addedModelNodes.add(stage.modelSlug);
        }
        edges.push({ source: sId, target: modelKey, relation: "uses" });
      }
    }
  }

  return { nodes, edges };
}

// ─── Dependents query ─────────────────────────────────────────────────────────

/**
 * Returns all pipelines/stages that reference the given connection via
 * `allowedConnections`.
 */
export async function getConnectionDependents(
  storage: IStorage,
  connectionId: string,
): Promise<ConnectionDependent[]> {
  const pipelines = await storage.getPipelines();
  const result: ConnectionDependent[] = [];

  for (const pipeline of pipelines) {
    const rawStages = (pipeline.stages ?? []) as unknown[];
    const stageConfigs = rawStages as Partial<PipelineStageConfig>[];
    let pipelineAdded = false;

    for (let idx = 0; idx < stageConfigs.length; idx++) {
      const stage = stageConfigs[idx];
      if (Array.isArray(stage.allowedConnections) && stage.allowedConnections.includes(connectionId)) {
        if (!pipelineAdded) {
          result.push({
            kind: "pipeline",
            pipelineId: pipeline.id,
            pipelineName: pipeline.name,
          });
          pipelineAdded = true;
        }
        result.push({
          kind: "stage",
          pipelineId: pipeline.id,
          pipelineName: pipeline.name,
          stageIndex: idx,
          stageTeamId: stage.teamId,
        });
      }
    }
  }

  return result;
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
