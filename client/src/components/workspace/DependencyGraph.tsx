import { useMemo, useCallback, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
  type Node,
  type Edge,
} from "reactflow";
import "reactflow/dist/style.css";
import { useDependencyGraph, type DGNode, type DGEdge } from "@/hooks/useDependencyGraph";
import { useWorkspaceSocket } from "@/hooks/useWorkspaceSocket";
import { DGFileNode, type DGFileNodeData } from "./DGFileNode";
import { DGImpactPanel } from "./DGImpactPanel";

// ─── Node types ───────────────────────────────────────────────────────────────

const NODE_TYPES = { dgFile: DGFileNode };

// ─── Layout helpers ───────────────────────────────────────────────────────────

const NODE_WIDTH = 200;
const NODE_HEIGHT = 52;
const H_GAP = 60;
const V_GAP = 80;

function computeLayout(
  nodes: DGNode[],
  edges: DGEdge[],
): Record<string, { x: number; y: number }> {
  const inDegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));

  for (const e of edges) {
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    adj.get(e.source)?.push(e.target);
  }

  const waves: string[][] = [];
  let queue = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const visited = new Set<string>();

  while (queue.length > 0) {
    waves.push([...queue]);
    queue.forEach((id) => visited.add(id));
    const next: string[] = [];
    for (const id of queue) {
      for (const nxt of adj.get(id) ?? []) {
        const deg = (inDegree.get(nxt) ?? 1) - 1;
        inDegree.set(nxt, deg);
        if (deg === 0 && !visited.has(nxt)) next.push(nxt);
      }
    }
    queue = next;
  }

  // Any unreached nodes (cycles) go in a final wave
  const unreached = nodes.filter((n) => !visited.has(n.id)).map((n) => n.id);
  if (unreached.length > 0) waves.push(unreached);

  const positions: Record<string, { x: number; y: number }> = {};
  for (let wi = 0; wi < waves.length; wi++) {
    const wave = waves[wi];
    const totalWidth = wave.length * (NODE_WIDTH + H_GAP) - H_GAP;
    const startX = -totalWidth / 2;
    for (let ni = 0; ni < wave.length; ni++) {
      positions[wave[ni]] = {
        x: startX + ni * (NODE_WIDTH + H_GAP),
        y: wi * (NODE_HEIGHT + V_GAP),
      };
    }
  }
  return positions;
}

function basename(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

// ─── Converters ───────────────────────────────────────────────────────────────

function dgNodesToFlow(
  nodes: DGNode[],
  positions: Record<string, { x: number; y: number }>,
  selectedId: string | null,
  impactedIds: Set<string>,
): Node<DGFileNodeData>[] {
  return nodes.map((n) => ({
    id: n.id,
    type: "dgFile",
    position: positions[n.id] ?? { x: 0, y: 0 },
    data: {
      label: basename(n.id),
      importedByCount: n.importedByCount,
      importCount: n.importCount,
      isSelected: n.id === selectedId,
      isImpacted: impactedIds.has(n.id),
    },
    selected: n.id === selectedId,
  }));
}

function dgEdgesToFlow(
  edges: DGEdge[],
  selectedId: string | null,
  impactedIds: Set<string>,
): Edge[] {
  return edges.map((e) => {
    const isImpact = selectedId !== null && e.target === selectedId;
    const isOutgoing = selectedId !== null && e.source === selectedId;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: isImpact
        ? { stroke: "rgb(239 68 68)", strokeWidth: 2 }
        : isOutgoing
          ? { stroke: "rgb(99 102 241)", strokeWidth: 1.5 }
          : { stroke: undefined },
      animated: isImpact,
    };
  });
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface DependencyGraphProps {
  workspaceId: string;
  onNodeClick: (filePath: string) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DependencyGraph({ workspaceId, onNodeClick }: DependencyGraphProps) {
  const { data, isLoading, error } = useDependencyGraph(workspaceId);
  const { indexStatus } = useWorkspaceSocket(workspaceId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // IDs that import the selected file (reverse-edge impact set)
  const impactedIds = useMemo<Set<string>>(() => {
    if (!selectedId || !data) return new Set();
    return new Set(data.edges.filter((e) => e.target === selectedId).map((e) => e.source));
  }, [selectedId, data]);

  const positions = useMemo(
    () => (data ? computeLayout(data.nodes, data.edges) : {}),
    [data],
  );

  const initialNodes = useMemo(
    () => (data ? dgNodesToFlow(data.nodes, positions, selectedId, impactedIds) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, positions],
  );

  const initialEdges = useMemo(
    () => (data ? dgEdgesToFlow(data.edges, selectedId, impactedIds) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<DGFileNodeData>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Recompute highlight state whenever selection changes
  const applySelection = useCallback(
    (id: string | null, currentData: typeof data) => {
      if (!currentData) return;
      const newImpacted = id
        ? new Set(currentData.edges.filter((e) => e.target === id).map((e) => e.source))
        : new Set<string>();

      setNodes(dgNodesToFlow(currentData.nodes, positions, id, newImpacted));
      setEdges(dgEdgesToFlow(currentData.edges, id, newImpacted));
    },
    [positions, setNodes, setEdges],
  );

  const handleNodeClick = useCallback(
    (_evt: React.MouseEvent, node: Node<DGFileNodeData>) => {
      const newId = selectedId === node.id ? null : node.id;
      setSelectedId(newId);
      applySelection(newId, data);
      if (newId) onNodeClick(newId);
    },
    [selectedId, data, applySelection, onNodeClick],
  );

  // ─── Render states ──────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="space-y-2 w-64">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 rounded-md border border-border bg-muted/30 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const err = error as (Error & { status?: number; indexStatus?: string }) | null;

  if (err) {
    const isNotIndexed = err.status === 409;
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-1">
          <p className="text-sm text-muted-foreground">
            {isNotIndexed ? "Workspace not yet indexed" : "Failed to load dependency graph"}
          </p>
          {isNotIndexed && (
            <p className="text-xs text-muted-foreground">
              Use the Index Now button to build the symbol graph.
            </p>
          )}
          {!isNotIndexed && <p className="text-xs text-red-500">{err.message}</p>}
        </div>
      </div>
    );
  }

  if (!data || data.nodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">No dependency data available.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 relative overflow-hidden">
      {/* Indexing overlay */}
      {indexStatus === "indexing" && (
        <div className="absolute inset-0 z-20 bg-background/60 backdrop-blur-sm flex items-center justify-center">
          <p className="text-sm text-muted-foreground animate-pulse">Indexing...</p>
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        deleteKeyCode={null}
        nodesDraggable
        nodesConnectable={false}
      >
        <Background />
        <Controls />
        <MiniMap
          nodeColor={() => "hsl(var(--primary))"}
          maskColor="rgba(0,0,0,0.1)"
        />
      </ReactFlow>

      {/* Impact panel */}
      {selectedId && data && (
        <DGImpactPanel
          selectedNodeId={selectedId}
          nodes={data.nodes}
          edges={data.edges}
          onClose={() => {
            setSelectedId(null);
            applySelection(null, data);
          }}
          onNavigate={(filePath) => {
            setSelectedId(filePath);
            applySelection(filePath, data ?? null);
            onNodeClick(filePath);
          }}
        />
      )}
    </div>
  );
}
