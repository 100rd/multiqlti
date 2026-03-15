import { useState, useCallback, useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type OnConnect,
  MarkerType,
} from "reactflow";
import "reactflow/dist/style.css";
import { useToast } from "@/hooks/use-toast";
import { useSaveDAG, useValidateDAG } from "@/hooks/use-dag";
import type { PipelineDAG, DAGStage, DAGEdge } from "@shared/types";
import { DAGStageNode } from "./DAGStageNode";
import { DAGEdgeLabel } from "./DAGEdgeLabel";
import { DAGEdgeModal } from "./DAGEdgeModal";
import { DAGToolbar } from "./DAGToolbar";

// ─── React Flow node/edge type registrations ──────────────────────────────────

const NODE_TYPES = { dagStage: DAGStageNode };
const EDGE_TYPES = { dagEdge: DAGEdgeLabel };

// ─── Type aliases to keep generics manageable ─────────────────────────────────

type EdgeData = Pick<DAGEdge, "condition" | "label">;
type FlowNode = Node<DAGStage & { color?: string }>;
type FlowEdge = Edge<EdgeData>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dagStageToNode(stage: DAGStage & { color?: string }): FlowNode {
  return {
    id: stage.id,
    type: "dagStage",
    position: stage.position,
    data: stage,
  };
}

function dagEdgeToFlowEdge(edge: DAGEdge): FlowEdge {
  return {
    id: edge.id,
    source: edge.from,
    target: edge.to,
    type: "dagEdge",
    markerEnd: { type: MarkerType.ArrowClosed },
    data: { condition: edge.condition, label: edge.label },
  };
}

function flowEdgeToDagEdge(edge: FlowEdge): DAGEdge {
  return {
    id: edge.id,
    from: edge.source,
    to: edge.target,
    condition: edge.data?.condition,
    label: edge.data?.label,
  };
}

// Auto-layout: topological sort, then arrange in vertical waves
function computeAutoLayout(
  stages: DAGStage[],
  edges: DAGEdge[],
): Record<string, { x: number; y: number }> {
  const WAVE_HEIGHT = 160;
  const NODE_WIDTH = 200;
  const NODE_GAP = 40;

  const inDegree = new Map<string, number>(stages.map((s) => [s.id, 0]));
  const adj = new Map<string, string[]>(stages.map((s) => [s.id, []]));

  for (const e of edges) {
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    adj.get(e.from)?.push(e.to);
  }

  const waves: string[][] = [];
  let queue = stages.filter((s) => (inDegree.get(s.id) ?? 0) === 0).map((s) => s.id);

  while (queue.length > 0) {
    waves.push([...queue]);
    const next: string[] = [];
    for (const id of queue) {
      for (const nxt of adj.get(id) ?? []) {
        const deg = (inDegree.get(nxt) ?? 1) - 1;
        inDegree.set(nxt, deg);
        if (deg === 0) next.push(nxt);
      }
    }
    queue = next;
  }

  const positions: Record<string, { x: number; y: number }> = {};
  for (let wi = 0; wi < waves.length; wi++) {
    const wave = waves[wi];
    const totalWidth = wave.length * (NODE_WIDTH + NODE_GAP) - NODE_GAP;
    const startX = -totalWidth / 2;
    for (let ni = 0; ni < wave.length; ni++) {
      positions[wave[ni]] = {
        x: startX + ni * (NODE_WIDTH + NODE_GAP),
        y: wi * WAVE_HEIGHT,
      };
    }
  }
  return positions;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface DAGCanvasProps {
  pipelineId: string;
  dag: PipelineDAG | null;
  readOnly?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DAGCanvas({ pipelineId, dag, readOnly = false }: DAGCanvasProps) {
  const { toast } = useToast();
  const saveDAG = useSaveDAG(pipelineId);
  const validateDAG = useValidateDAG(pipelineId);

  const [pendingConnection, setPendingConnection] = useState<{
    fromId: string;
    toId: string;
    connection: Connection;
  } | null>(null);

  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);

  // ─── React Flow state ──────────────────────────────────────────────────────

  const initialNodes = useMemo<FlowNode[]>(
    () => (dag?.stages ?? []).map((s) => dagStageToNode(s as DAGStage & { color?: string })),
    // One-time initialization — intentionally using empty dep array
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const initialEdges = useMemo<FlowEdge[]>(
    () => (dag?.edges ?? []).map(dagEdgeToFlowEdge),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<DAGStage & { color?: string }>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<EdgeData>(initialEdges);

  // ─── Build PipelineDAG from current React Flow state ──────────────────────

  const buildDAG = useCallback(
    (currentNodes: FlowNode[], currentEdges: FlowEdge[]): PipelineDAG => ({
      stages: currentNodes.map((n) => ({
        ...(n.data as DAGStage),
        position: n.position,
      })),
      edges: currentEdges.map(flowEdgeToDagEdge),
    }),
    [],
  );

  // ─── Connect handler ───────────────────────────────────────────────────────

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (readOnly) return;
      setPendingConnection({
        fromId: connection.source,
        toId: connection.target,
        connection,
      });
    },
    [readOnly],
  );

  const handleEdgeModalSave = useCallback(
    (result: { condition?: DAGEdge["condition"]; label?: string }) => {
      if (pendingConnection) {
        const newEdge: FlowEdge = {
          id: `edge-${pendingConnection.fromId}-${pendingConnection.toId}-${Date.now()}`,
          source: pendingConnection.fromId,
          target: pendingConnection.toId,
          type: "dagEdge",
          markerEnd: { type: MarkerType.ArrowClosed },
          data: { condition: result.condition, label: result.label },
        };
        setEdges((prev: FlowEdge[]) => addEdge(newEdge, prev));
        setPendingConnection(null);
      } else if (editingEdgeId) {
        setEdges((prev: FlowEdge[]) =>
          prev.map((e: FlowEdge) =>
            e.id === editingEdgeId
              ? { ...e, data: { condition: result.condition, label: result.label } }
              : e,
          ),
        );
        setEditingEdgeId(null);
      }
    },
    [pendingConnection, editingEdgeId, setEdges],
  );

  const handleEdgeModalClose = useCallback(() => {
    setPendingConnection(null);
    setEditingEdgeId(null);
  }, []);

  const onEdgeClick = useCallback(
    (_evt: React.MouseEvent, edge: FlowEdge) => {
      if (!readOnly) setEditingEdgeId(edge.id);
    },
    [readOnly],
  );

  // ─── Toolbar actions ───────────────────────────────────────────────────────

  const handleAutoLayout = useCallback(() => {
    const dagStages = nodes.map((n) => n.data as DAGStage);
    const dagEdges = edges.map(flowEdgeToDagEdge);
    const positions = computeAutoLayout(dagStages, dagEdges);
    setNodes((prev: FlowNode[]) =>
      prev.map((n: FlowNode) => (positions[n.id] ? { ...n, position: positions[n.id] } : n)),
    );
  }, [nodes, edges, setNodes]);

  const handleValidate = useCallback(() => {
    const currentDAG = buildDAG(nodes, edges);
    validateDAG.mutate(currentDAG, {
      onSuccess: (data: unknown) => {
        const result = data as { valid?: boolean; ok?: boolean; reason?: string };
        if (result?.valid === false || result?.ok === false) {
          toast({
            title: "DAG Validation Failed",
            description: result.reason ?? "Check edge references and cycles.",
            variant: "destructive",
          });
        } else {
          toast({ title: "DAG is valid", description: "No cycles or broken references found." });
        }
      },
      onError: (err: Error) => {
        toast({ title: "Validation error", description: err.message, variant: "destructive" });
      },
    });
  }, [nodes, edges, buildDAG, validateDAG, toast]);

  const handleSave = useCallback(() => {
    const currentDAG = buildDAG(nodes, edges);
    saveDAG.mutate(currentDAG, {
      onSuccess: () => {
        toast({ title: "DAG saved", description: "Pipeline DAG configuration updated." });
      },
      onError: (err: Error) => {
        toast({ title: "Save failed", description: err.message, variant: "destructive" });
      },
    });
  }, [nodes, edges, buildDAG, saveDAG, toast]);

  // ─── Modal derived state ───────────────────────────────────────────────────

  const modalOpen = pendingConnection !== null || editingEdgeId !== null;

  const modalFromId = pendingConnection?.fromId ?? (() => {
    const e = edges.find((ed: FlowEdge) => ed.id === editingEdgeId);
    return e?.source ?? "";
  })();

  const modalToId = pendingConnection?.toId ?? (() => {
    const e = edges.find((ed: FlowEdge) => ed.id === editingEdgeId);
    return e?.target ?? "";
  })();

  const editingEdgeData = editingEdgeId
    ? edges.find((ed: FlowEdge) => ed.id === editingEdgeId)?.data
    : undefined;

  return (
    <div className="flex flex-col h-full" role="region" aria-label="DAG Pipeline Editor">
      {!readOnly && (
        <DAGToolbar
          pipelineId={pipelineId}
          onAutoLayout={handleAutoLayout}
          onValidate={handleValidate}
          onSave={handleSave}
          isSaving={saveDAG.isPending}
          isValidating={validateDAG.isPending}
        />
      )}

      <div className="flex-1 min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={readOnly ? undefined : onNodesChange}
          onEdgesChange={readOnly ? undefined : onEdgesChange}
          onConnect={readOnly ? undefined : onConnect}
          onEdgeClick={readOnly ? undefined : onEdgeClick}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          deleteKeyCode={readOnly ? null : "Delete"}
        >
          <Background />
          <Controls />
          <MiniMap
            nodeColor={() => "#6366f1"}
            maskColor="rgba(0,0,0,0.1)"
          />
        </ReactFlow>
      </div>

      <DAGEdgeModal
        open={modalOpen}
        fromStageId={modalFromId}
        toStageId={modalToId}
        initialEdge={editingEdgeData
          ? {
              condition: (editingEdgeData as EdgeData).condition,
              label: (editingEdgeData as EdgeData).label,
            }
          : undefined}
        onSave={handleEdgeModalSave}
        onClose={handleEdgeModalClose}
      />
    </div>
  );
}
