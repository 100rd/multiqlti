/**
 * DAG Structure Validator — Phase 6.2
 *
 * Validates PipelineDAG for structural correctness:
 * - No cycles (Kahn's algorithm)
 * - All edge from/to IDs reference valid stage IDs
 * - No duplicate stage IDs
 * - At least one stage
 */
import type { PipelineDAG } from "@shared/types";

export interface DAGValidationResult {
  ok: boolean;
  reason?: string;
}

/** Returns true if the DAG contains a cycle. Uses Kahn's BFS-based algorithm. */
function hasCycle(stages: PipelineDAG["stages"], edges: PipelineDAG["edges"]): boolean {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const stage of stages) {
    inDegree.set(stage.id, 0);
    adjacency.set(stage.id, []);
  }

  for (const edge of edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    const neighbors = adjacency.get(edge.from) ?? [];
    neighbors.push(edge.to);
    adjacency.set(edge.from, neighbors);
  }

  const queue = stages
    .filter((s) => (inDegree.get(s.id) ?? 0) === 0)
    .map((s) => s.id);

  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const neighbor of adjacency.get(id) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) queue.push(neighbor);
    }
  }

  return visited !== stages.length;
}

/**
 * Validates a PipelineDAG for structural correctness.
 * Returns { ok: true } or { ok: false, reason: "..." }.
 */
export function validateDAGStructure(dag: PipelineDAG): DAGValidationResult {
  if (dag.stages.length === 0) {
    return { ok: false, reason: "DAG must have at least one stage" };
  }

  const stageIds = new Set<string>();
  for (const stage of dag.stages) {
    if (stageIds.has(stage.id)) {
      return { ok: false, reason: `Duplicate stage ID: "${stage.id}"` };
    }
    stageIds.add(stage.id);
  }

  for (const edge of dag.edges) {
    if (!stageIds.has(edge.from)) {
      return { ok: false, reason: `Edge "${edge.id}" references unknown stage: "${edge.from}"` };
    }
    if (!stageIds.has(edge.to)) {
      return { ok: false, reason: `Edge "${edge.id}" references unknown stage: "${edge.to}"` };
    }
    if (edge.from === edge.to) {
      return { ok: false, reason: `Edge "${edge.id}" is a self-loop` };
    }
  }

  if (hasCycle(dag.stages, dag.edges)) {
    return { ok: false, reason: "DAG contains a cycle" };
  }

  return { ok: true };
}
