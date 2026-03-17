import { useState, useMemo, useCallback } from "react";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import ReactFlow, {
  Background,
  Controls,
  type Node,
  type Edge,
  MarkerType,
  useNodesState,
  useEdgesState,
} from "reactflow";
import "reactflow/dist/style.css";
import { cn } from "@/lib/utils";
import type { ThoughtNode, ThoughtTree as ThoughtTreeType } from "@shared/types";

// ─── Constants ────────────────────────────────────────────────────────────────

type NodeType = ThoughtNode["type"];
type FilterType = "all" | "reasoning" | "decision" | "tool";
type ViewMode = "list" | "graph";

const NODE_EMOJI: Record<NodeType, string> = {
  reasoning:    "🧠",
  tool_call:    "🔍",
  tool_result:  "📄",
  decision:     "✅",
  guardrail:    "⚠️",
  memory_recall:"💭",
  branch:       "🌿",
  conclusion:   "🏁",
};

const NODE_COLORS: Record<NodeType, string> = {
  reasoning:    "border-blue-500/30   bg-blue-500/5",
  tool_call:    "border-purple-500/30 bg-purple-500/5",
  tool_result:  "border-slate-500/30  bg-slate-500/5",
  decision:     "border-green-500/30  bg-green-500/5",
  guardrail:    "border-amber-500/30  bg-amber-500/5",
  memory_recall:"border-cyan-500/30   bg-cyan-500/5",
  branch:       "border-violet-500/30 bg-violet-500/5",
  conclusion:   "border-emerald-500/30 bg-emerald-500/5",
};

// ReactFlow graph node background colors
const NODE_BG: Record<NodeType, string> = {
  reasoning:    "#eff6ff",
  tool_call:    "#faf5ff",
  tool_result:  "#f8fafc",
  decision:     "#f0fdf4",
  guardrail:    "#fffbeb",
  memory_recall:"#ecfeff",
  branch:       "#f5f3ff",
  conclusion:   "#ecfdf5",
};

// Provider-specific ring tints for debate participant nodes
const PROVIDER_TINT: Record<string, string> = {
  anthropic: "ring-blue-400/50",
  google:    "ring-green-400/50",
  xai:       "ring-orange-400/50",
};

// ─── ReactFlow custom node component ─────────────────────────────────────────

interface TTNodeData {
  node: ThoughtNode;
  onSelect: (node: ThoughtNode) => void;
}

function ThoughtTreeFlowNode({ data }: { data: TTNodeData }) {
  const { node, onSelect } = data;
  const isConsensus = node.metadata?.isConsensus;
  const provider = node.metadata?.provider;
  const providerRing = provider ? (PROVIDER_TINT[provider] ?? "") : "";

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 cursor-pointer transition-all select-none text-left",
        "min-w-[140px] max-w-[200px]",
        isConsensus && `ring-2 ring-yellow-400/70 ${providerRing}`,
        !isConsensus && provider && `ring-1 ${providerRing}`,
      )}
      style={{
        background: NODE_BG[node.type],
        borderColor: isConsensus ? "#facc15" : undefined,
      }}
      onClick={() => onSelect(node)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onSelect(node)}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-xs shrink-0">{NODE_EMOJI[node.type]}</span>
        <span className="text-[11px] font-medium truncate text-foreground">
          {node.label}
        </span>
      </div>
      {node.metadata?.model && (
        <span className="text-[9px] text-muted-foreground mt-0.5 block truncate italic">
          {node.metadata.model}
        </span>
      )}
    </div>
  );
}

const RF_NODE_TYPES = { ttNode: ThoughtTreeFlowNode };

// ─── Graph layout ─────────────────────────────────────────────────────────────

const NODE_W = 200;
const NODE_H = 56;
const H_GAP = 50;
const V_GAP = 80;

function computeGraphLayout(nodes: ThoughtNode[]): Record<string, { x: number; y: number }> {
  const children = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const n of nodes) {
    children.set(n.id, []);
    inDegree.set(n.id, 0);
  }

  for (const n of nodes) {
    if (n.parentId && children.has(n.parentId)) {
      children.get(n.parentId)!.push(n.id);
      inDegree.set(n.id, (inDegree.get(n.id) ?? 0) + 1);
    }
  }

  // BFS level assignment
  const levels = new Map<string, number>();
  const queue: string[] = [];

  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      queue.push(id);
      levels.set(id, 0);
    }
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const lvl = levels.get(id) ?? 0;
    for (const child of children.get(id) ?? []) {
      const prev = levels.get(child) ?? 0;
      levels.set(child, Math.max(prev, lvl + 1));
      queue.push(child);
    }
  }

  // Group by level
  const byLevel = new Map<number, string[]>();
  for (const [id, lvl] of levels) {
    const list = byLevel.get(lvl) ?? [];
    list.push(id);
    byLevel.set(lvl, list);
  }

  const positions: Record<string, { x: number; y: number }> = {};

  for (const [lvl, ids] of byLevel) {
    const totalW = ids.length * NODE_W + (ids.length - 1) * H_GAP;
    let xStart = -(totalW / 2);

    for (const id of ids) {
      positions[id] = {
        x: xStart,
        y: lvl * (NODE_H + V_GAP),
      };
      xStart += NODE_W + H_GAP;
    }
  }

  return positions;
}

// ─── Graph View ───────────────────────────────────────────────────────────────

function ThoughtTreeGraphView({
  nodes: treeNodes,
  onSelectNode,
}: {
  nodes: ThoughtTreeType;
  onSelectNode: (n: ThoughtNode) => void;
}) {
  const positions = useMemo(() => computeGraphLayout(treeNodes), [treeNodes]);

  const rfNodes: Node<TTNodeData>[] = useMemo(
    () =>
      treeNodes.map((n) => ({
        id: n.id,
        type: "ttNode",
        position: positions[n.id] ?? { x: 0, y: 0 },
        data: { node: n, onSelect: onSelectNode },
      })),
    [treeNodes, positions, onSelectNode],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      treeNodes
        .filter((n) => n.parentId)
        .map((n) => ({
          id: `e-${n.parentId}-${n.id}`,
          source: n.parentId!,
          target: n.id,
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { strokeWidth: 1.5, stroke: "#94a3b8" },
        })),
    [treeNodes],
  );

  const [rfNodesState, , onNodesChange] = useNodesState(rfNodes);
  const [rfEdgesState, , onEdgesChange] = useEdgesState(rfEdges);

  return (
    <div className="rounded-lg border border-border overflow-hidden" style={{ height: 320 }}>
      <ReactFlow
        nodes={rfNodesState}
        edges={rfEdgesState}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={RF_NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.3}
        attributionPosition="bottom-right"
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

// ─── List View row ────────────────────────────────────────────────────────────

function ThoughtNodeRow({
  node,
  depth,
  onSelect,
}: {
  node: ThoughtNode;
  depth: number;
  onSelect: (n: ThoughtNode) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasContent = node.content && node.content !== node.label;
  const isConsensus = node.metadata?.isConsensus;
  const provider = node.metadata?.provider;

  return (
    <div style={{ marginLeft: depth * 16 }}>
      <div
        className={cn(
          "rounded-md border px-3 py-2 mb-1 cursor-pointer transition-colors",
          NODE_COLORS[node.type],
          isConsensus && "ring-2 ring-yellow-400/70",
          provider && (PROVIDER_TINT[provider] ?? ""),
          hasContent ? "hover:brightness-105" : "cursor-default",
        )}
        onClick={() => {
          if (hasContent) setExpanded(!expanded);
          onSelect(node);
        }}
      >
        <div className="flex items-start gap-2">
          <span className="text-sm shrink-0">{NODE_EMOJI[node.type]}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-foreground truncate">
                {node.label}
              </span>
              {node.metadata?.model && (
                <span className="text-[9px] text-muted-foreground shrink-0 italic">
                  {node.metadata.model}
                </span>
              )}
              {node.durationMs !== undefined && (
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {node.durationMs}ms
                </span>
              )}
              {node.metadata?.tokensUsed !== undefined && (
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {node.metadata.tokensUsed} tok
                </span>
              )}
              {hasContent && (
                <span className="ml-auto shrink-0">
                  {expanded
                    ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
                    : <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  }
                </span>
              )}
            </div>
            {expanded && hasContent && (
              <pre className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed">
                {node.content}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Node detail panel ────────────────────────────────────────────────────────

function NodeDetailPanel({ node, onClose }: { node: ThoughtNode; onClose: () => void }) {
  return (
    <div className="mt-2 rounded-lg border border-border p-3 bg-muted/20">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <span className="text-sm">{NODE_EMOJI[node.type]}</span>
          <span className="text-xs font-semibold">{node.label}</span>
          {node.metadata?.model && (
            <span className="text-[10px] text-muted-foreground italic">
              — {node.metadata.model}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Close
        </button>
      </div>
      <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-y-auto">
        {node.content}
      </pre>
      {node.metadata?.isConsensus && (
        <div className="mt-2 text-[10px] text-yellow-600 font-medium">
          ⭐ Consensus point across participants
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface ThoughtTreeProps {
  nodes: ThoughtTreeType;
}

/** Auto-switch to graph view when parent links exist or node count exceeds threshold. */
const GRAPH_MODE_THRESHOLD = 15;

export default function ThoughtTree({ nodes }: ThoughtTreeProps) {
  const [filter, setFilter] = useState<FilterType>("all");
  const [selectedNode, setSelectedNode] = useState<ThoughtNode | null>(null);

  const hasParentLinks = nodes.some((n) => n.parentId !== null);
  const defaultMode: ViewMode = hasParentLinks || nodes.length > GRAPH_MODE_THRESHOLD
    ? "graph"
    : "list";
  const [viewMode, setViewMode] = useState<ViewMode>(defaultMode);

  const handleSelectNode = useCallback((n: ThoughtNode) => {
    setSelectedNode((prev) => (prev?.id === n.id ? null : n));
  }, []);

  if (!nodes || nodes.length === 0) return null;

  const filtered = nodes.filter((n) => {
    if (filter === "all") return true;
    if (filter === "reasoning") return n.type === "reasoning" || n.type === "branch" || n.type === "conclusion";
    if (filter === "decision") return n.type === "decision";
    if (filter === "tool") return n.type === "tool_call" || n.type === "tool_result";
    return true;
  });

  const idToDepth = useMemo(() => {
    const map = new Map<string, number>();
    for (const node of nodes) {
      if (!node.parentId) {
        map.set(node.id, 0);
      } else {
        const parentDepth = map.get(node.parentId) ?? 0;
        map.set(node.id, parentDepth + 1);
      }
    }
    return map;
  }, [nodes]);

  const totalDuration = nodes.reduce((s, n) => s + (n.durationMs ?? 0), 0);
  const totalTokens = nodes.reduce((s, n) => s + (n.metadata?.tokensUsed ?? 0), 0);
  const decisionCount = nodes.filter((n) => n.type === "decision").length;
  const toolCallCount = nodes.filter((n) => n.type === "tool_call").length;
  const branchCount = nodes.filter((n) => n.type === "branch").length;
  const conclusionCount = nodes.filter((n) => n.type === "conclusion").length;
  const consensusCount = nodes.filter((n) => n.metadata?.isConsensus).length;

  const filterOptions: { label: string; value: FilterType }[] = [
    { label: "All", value: "all" },
    { label: "Reasoning", value: "reasoning" },
    { label: "Decisions", value: "decision" },
    { label: "Tools", value: "tool" },
  ];

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs font-medium text-muted-foreground">Thought Tree</p>

        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex gap-0 border border-border rounded-md overflow-hidden">
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={cn(
                "px-2 py-0.5 text-[10px] transition-colors flex items-center gap-1",
                viewMode === "list"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              <ChevronRight className="h-2.5 w-2.5" />
              List
            </button>
            <button
              type="button"
              onClick={() => setViewMode("graph")}
              className={cn(
                "px-2 py-0.5 text-[10px] transition-colors flex items-center gap-1",
                viewMode === "graph"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              <GitBranch className="h-2.5 w-2.5" />
              Graph
              {hasParentLinks && (
                <span className="ml-0.5 text-[9px] text-emerald-500 font-bold">•</span>
              )}
            </button>
          </div>

          {/* Filter chips — only in list mode */}
          {viewMode === "list" && filterOptions.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={cn(
                "text-[10px] px-2 py-0.5 rounded-full border transition-colors",
                filter === f.value
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:border-primary/50",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main view */}
      {viewMode === "graph" ? (
        <ThoughtTreeGraphView nodes={filtered} onSelectNode={handleSelectNode} />
      ) : (
        <div className="rounded-lg border border-border p-2 max-h-64 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              No {filter === "all" ? "" : filter} nodes
            </p>
          ) : (
            filtered.map((node) => (
              <ThoughtNodeRow
                key={node.id}
                node={node}
                depth={idToDepth.get(node.id) ?? 0}
                onSelect={handleSelectNode}
              />
            ))
          )}
        </div>
      )}

      {/* Selected node detail */}
      {selectedNode && (
        <NodeDetailPanel node={selectedNode} onClose={() => setSelectedNode(null)} />
      )}

      {/* Footer stats */}
      <div className="flex gap-3 flex-wrap text-[10px] text-muted-foreground px-1">
        {totalDuration > 0 && <span>Duration: {totalDuration}ms</span>}
        {totalTokens > 0 && <span>Tokens: {totalTokens}</span>}
        {decisionCount > 0 && <span>Decisions: {decisionCount}</span>}
        {toolCallCount > 0 && <span>Tool calls: {toolCallCount}</span>}
        {branchCount > 0 && <span>🌿 Branches: {branchCount}</span>}
        {conclusionCount > 0 && <span>🏁 Conclusions: {conclusionCount}</span>}
        {consensusCount > 0 && (
          <span className="text-yellow-600">⭐ Consensus: {consensusCount}</span>
        )}
      </div>
    </div>
  );
}
