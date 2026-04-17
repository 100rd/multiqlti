/**
 * Inventory & Dependency Graph (issue #275)
 *
 * Route: /workspaces/:id/inventory
 *
 * Features:
 * - Interactive SVG force-directed graph (connections/pipelines/stages/skills/models)
 * - Filters: by type, used/unused, last activity
 * - Search box (filters nodes by label)
 * - Click node → side panel with metadata + dependents
 * - Orphans tab (connections unused for 30 days)
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  Search,
  X,
  RefreshCw,
  AlertTriangle,
  Loader2,
  Network,
  Plug,
  GitMerge,
  Layers,
  Sparkles,
  Cpu,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type {
  InventoryGraph,
  InventoryNode,
  InventoryEdge,
  InventoryNodeType,
  ConnectionDependentsResponse,
} from "@shared/types";

// ─── Auth helper ─────────────────────────────────────────────────────────────

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function apiRequest<T>(url: string): Promise<T> {
  const token = getAuthToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// ─── Query hooks ──────────────────────────────────────────────────────────────

function useInventoryGraph(workspaceId: string) {
  return useQuery<InventoryGraph>({
    queryKey: ["/api/workspaces", workspaceId, "inventory"],
    queryFn: () => apiRequest<InventoryGraph>(`/api/workspaces/${workspaceId}/inventory`),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}

function useOrphans(workspaceId: string) {
  return useQuery<{ nodes: InventoryNode[] }>({
    queryKey: ["/api/workspaces", workspaceId, "inventory", "orphans"],
    queryFn: () =>
      apiRequest<{ nodes: InventoryNode[] }>(
        `/api/workspaces/${workspaceId}/inventory/orphans`,
      ),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}

function useDependents(workspaceId: string, connectionId: string | null) {
  return useQuery<ConnectionDependentsResponse>({
    queryKey: ["/api/workspaces", workspaceId, "connections", connectionId, "dependents"],
    queryFn: () =>
      apiRequest<ConnectionDependentsResponse>(
        `/api/workspaces/${workspaceId}/connections/${connectionId}/dependents`,
      ),
    enabled: !!workspaceId && !!connectionId,
    staleTime: 30_000,
  });
}

// ─── Node colour + icon ───────────────────────────────────────────────────────

const NODE_COLOUR: Record<InventoryNodeType, string> = {
  connection: "#6366f1", // indigo
  pipeline: "#10b981",  // emerald
  stage: "#f59e0b",     // amber
  skill: "#8b5cf6",     // violet
  model: "#3b82f6",     // blue
};

const NODE_ICON_LABEL: Record<InventoryNodeType, string> = {
  connection: "Conn",
  pipeline: "Pipe",
  stage: "Stg",
  skill: "Skill",
  model: "Mdl",
};

function NodeTypeIcon({ type, className }: { type: InventoryNodeType; className?: string }) {
  const icons: Record<InventoryNodeType, React.ReactNode> = {
    connection: <Plug className={cn("h-4 w-4", className)} />,
    pipeline: <GitMerge className={cn("h-4 w-4", className)} />,
    stage: <Layers className={cn("h-4 w-4", className)} />,
    skill: <Sparkles className={cn("h-4 w-4", className)} />,
    model: <Cpu className={cn("h-4 w-4", className)} />,
  };
  return <>{icons[type]}</>;
}

// ─── Simple force-layout ──────────────────────────────────────────────────────

interface LayoutNode extends InventoryNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

function computeInitialLayout(nodes: InventoryNode[]): LayoutNode[] {
  const angleStep = (2 * Math.PI) / Math.max(nodes.length, 1);
  const radius = Math.min(220, 30 * nodes.length);
  return nodes.map((n, i) => ({
    ...n,
    x: 400 + radius * Math.cos(i * angleStep),
    y: 300 + radius * Math.sin(i * angleStep),
    vx: 0,
    vy: 0,
  }));
}

const REPULSION = 3000;
const ATTRACTION = 0.04;
const DAMPING = 0.85;
const MIN_DIST = 40;
const ITERATIONS = 80;

function runForceLayout(
  nodes: LayoutNode[],
  edges: InventoryEdge[],
): LayoutNode[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const positions = nodes.map((n) => ({ ...n }));
  const posMap = new Map(positions.map((n) => [n.id, n]));

  for (let iter = 0; iter < ITERATIONS; iter++) {
    // Repulsion between all node pairs
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const ni = positions[i];
        const nj = positions[j];
        const dx = nj.x - ni.x;
        const dy = nj.y - ni.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), MIN_DIST);
        const force = REPULSION / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        ni.vx -= fx;
        ni.vy -= fy;
        nj.vx += fx;
        nj.vy += fy;
      }
    }

    // Attraction along edges
    for (const edge of edges) {
      const src = posMap.get(edge.source);
      const tgt = posMap.get(edge.target);
      if (!src || !tgt) continue;
      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      src.vx += dx * ATTRACTION;
      src.vy += dy * ATTRACTION;
      tgt.vx -= dx * ATTRACTION;
      tgt.vy -= dy * ATTRACTION;
    }

    // Update positions
    for (const n of positions) {
      n.x += n.vx;
      n.y += n.vy;
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      // Keep within canvas bounds
      n.x = Math.max(60, Math.min(740, n.x));
      n.y = Math.max(40, Math.min(560, n.y));
    }
  }

  return positions;
}

// ─── SVG Graph component ──────────────────────────────────────────────────────

interface GraphProps {
  nodes: InventoryNode[];
  edges: InventoryEdge[];
  selectedId: string | null;
  onSelectNode: (id: string) => void;
}

function InventoryGraphSvg({ nodes, edges, selectedId, onSelectNode }: GraphProps) {
  const [layout, setLayout] = useState<LayoutNode[]>([]);

  useEffect(() => {
    if (nodes.length === 0) {
      setLayout([]);
      return;
    }
    const initial = computeInitialLayout(nodes);
    const laid = runForceLayout(initial, edges);
    setLayout(laid);
  }, [nodes, edges]);

  const posMap = new Map(layout.map((n) => [n.id, { x: n.x, y: n.y }]));

  return (
    <svg
      viewBox="0 0 800 600"
      className="w-full h-full"
      style={{ minHeight: 400 }}
      aria-label="Dependency graph"
    >
      <defs>
        <marker
          id="arrowhead"
          markerWidth="10"
          markerHeight="7"
          refX="10"
          refY="3.5"
          orient="auto"
        >
          <polygon points="0 0, 10 3.5, 0 7" fill="#6b7280" />
        </marker>
      </defs>

      {/* Edges */}
      {edges.map((edge, i) => {
        const src = posMap.get(edge.source);
        const tgt = posMap.get(edge.target);
        if (!src || !tgt) return null;
        return (
          <line
            key={i}
            x1={src.x}
            y1={src.y}
            x2={tgt.x}
            y2={tgt.y}
            stroke={edge.relation === "contains" ? "#4b5563" : "#9ca3af"}
            strokeWidth={edge.relation === "contains" ? 1.5 : 1}
            strokeDasharray={edge.relation === "uses" ? "4 2" : undefined}
            markerEnd="url(#arrowhead)"
            opacity={0.6}
          />
        );
      })}

      {/* Nodes */}
      {layout.map((node) => {
        const colour = NODE_COLOUR[node.type];
        const isSelected = selectedId === node.id;
        const r = isSelected ? 22 : 18;
        return (
          <g
            key={node.id}
            transform={`translate(${node.x}, ${node.y})`}
            onClick={() => onSelectNode(node.id)}
            style={{ cursor: "pointer" }}
            role="button"
            aria-label={`Node: ${node.label}`}
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && onSelectNode(node.id)}
          >
            {node.isOrphan && (
              <circle
                r={r + 5}
                fill="none"
                stroke="#f59e0b"
                strokeWidth={2}
                strokeDasharray="3 2"
                opacity={0.7}
              />
            )}
            <circle
              r={r}
              fill={colour}
              opacity={isSelected ? 1 : 0.8}
              stroke={isSelected ? "#fff" : "none"}
              strokeWidth={isSelected ? 2 : 0}
            />
            <text
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={9}
              fontFamily="monospace"
              fill="#fff"
              fontWeight="bold"
            >
              {NODE_ICON_LABEL[node.type]}
            </text>
            <text
              y={r + 10}
              textAnchor="middle"
              fontSize={9}
              fontFamily="sans-serif"
              fill="#d1d5db"
            >
              {node.label.length > 14 ? `${node.label.slice(0, 12)}…` : node.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── Side panel ───────────────────────────────────────────────────────────────

function MetadataRow({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  const display =
    value instanceof Date
      ? value.toLocaleString()
      : typeof value === "boolean"
      ? value.toString()
      : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  return (
    <div className="flex gap-2 text-xs py-0.5">
      <span className="text-muted-foreground min-w-[90px] shrink-0">{label}</span>
      <span className="font-mono truncate">{display}</span>
    </div>
  );
}

interface SidePanelProps {
  node: InventoryNode;
  workspaceId: string;
  onClose: () => void;
}

function NodeSidePanel({ node, workspaceId, onClose }: SidePanelProps) {
  const { data: depsData, isLoading: depsLoading } = useDependents(
    workspaceId,
    node.type === "connection" ? node.id : null,
  );

  return (
    <aside className="w-80 border-l border-border bg-card flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: NODE_COLOUR[node.type] }}
          />
          <span className="text-sm font-semibold truncate max-w-[180px]">{node.label}</span>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close panel">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Type + orphan status */}
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="secondary" className="capitalize">
            <NodeTypeIcon type={node.type} className="mr-1" />
            {node.type}
          </Badge>
          {node.isOrphan && (
            <Badge variant="outline" className="text-amber-500 border-amber-500/50">
              <AlertTriangle className="h-3 w-3 mr-1" />
              Orphan
            </Badge>
          )}
        </div>

        {/* Metadata */}
        <section>
          <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">
            Metadata
          </p>
          <div className="bg-muted/40 rounded-md px-3 py-2 space-y-0.5">
            <MetadataRow label="ID" value={node.id} />
            {Object.entries(node.metadata).map(([k, v]) => (
              <MetadataRow key={k} label={k} value={v} />
            ))}
          </div>
        </section>

        {/* Dependents (connections only) */}
        {node.type === "connection" && (
          <section>
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">
              Dependents
            </p>
            {depsLoading ? (
              <div className="space-y-1">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-3/4" />
              </div>
            ) : depsData?.dependents.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No dependents found</p>
            ) : (
              <ul className="space-y-1">
                {depsData?.dependents.map((dep, i) => (
                  <li
                    key={i}
                    className="text-xs flex items-center gap-1.5 bg-muted/40 rounded px-2 py-1"
                  >
                    {dep.kind === "pipeline" ? (
                      <GitMerge className="h-3 w-3 text-emerald-500 shrink-0" />
                    ) : (
                      <Layers className="h-3 w-3 text-amber-500 shrink-0" />
                    )}
                    <span className="truncate">
                      {dep.pipelineName}
                      {dep.stageIndex !== undefined && (
                        <span className="text-muted-foreground ml-1">
                          / Stage {dep.stageIndex}
                          {dep.stageTeamId ? ` (${dep.stageTeamId})` : ""}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}

// ─── Orphan list ──────────────────────────────────────────────────────────────

function OrphanList({ nodes }: { nodes: InventoryNode[] }) {
  if (nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-40 text-muted-foreground text-sm">
        <Network className="h-8 w-8 mb-2 opacity-30" />
        No orphaned connections found
      </div>
    );
  }

  return (
    <ul className="space-y-2 p-4">
      {nodes.map((node) => (
        <li
          key={node.id}
          className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2"
        >
          <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{node.label}</p>
            <p className="text-xs text-muted-foreground">
              {(node.metadata.connectionType as string) ?? "connection"} — no activity for 30+ days
            </p>
          </div>
          <Badge variant="outline" className="shrink-0 text-amber-500 border-amber-500/50">
            Unused
          </Badge>
        </li>
      ))}
    </ul>
  );
}

// ─── Filters ─────────────────────────────────────────────────────────────────

type TypeFilter = InventoryNodeType | "all";
type UsageFilter = "all" | "used" | "unused";

function applyFilters(
  nodes: InventoryNode[],
  edges: InventoryEdge[],
  typeFilter: TypeFilter,
  usageFilter: UsageFilter,
  search: string,
): { filteredNodes: InventoryNode[]; filteredEdges: InventoryEdge[] } {
  let filteredNodes = nodes;

  if (typeFilter !== "all") {
    filteredNodes = filteredNodes.filter((n) => n.type === typeFilter);
  }

  if (usageFilter !== "all") {
    const nodesWithDependents = new Set<string>();
    for (const edge of edges) {
      nodesWithDependents.add(edge.target);
    }
    if (usageFilter === "used") {
      filteredNodes = filteredNodes.filter((n) => nodesWithDependents.has(n.id));
    } else {
      filteredNodes = filteredNodes.filter((n) => !nodesWithDependents.has(n.id));
    }
  }

  if (search.trim()) {
    const q = search.toLowerCase();
    filteredNodes = filteredNodes.filter(
      (n) =>
        n.label.toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q) ||
        n.type.toLowerCase().includes(q),
    );
  }

  const filteredIds = new Set(filteredNodes.map((n) => n.id));
  const filteredEdges = edges.filter(
    (e) => filteredIds.has(e.source) && filteredIds.has(e.target),
  );

  return { filteredNodes, filteredEdges };
}

// ─── Legend ───────────────────────────────────────────────────────────────────

function GraphLegend() {
  const items: Array<{ type: InventoryNodeType; label: string }> = [
    { type: "connection", label: "Connection" },
    { type: "pipeline", label: "Pipeline" },
    { type: "stage", label: "Stage" },
    { type: "skill", label: "Skill" },
    { type: "model", label: "Model" },
  ];
  return (
    <div className="flex flex-wrap gap-3 px-4 py-2 border-t border-border bg-card/50">
      {items.map((item) => (
        <div key={item.type} className="flex items-center gap-1.5 text-xs">
          <span
            className="inline-block w-3 h-3 rounded-full"
            style={{ backgroundColor: NODE_COLOUR[item.type] }}
          />
          <span className="text-muted-foreground">{item.label}</span>
        </div>
      ))}
      <div className="flex items-center gap-1.5 text-xs">
        <span className="inline-block w-3 h-3 rounded-full border-2 border-amber-400 border-dashed" />
        <span className="text-muted-foreground">Orphan</span>
      </div>
      <div className="flex items-center gap-1.5 text-xs">
        <svg width="24" height="8">
          <line x1="0" y1="4" x2="20" y2="4" stroke="#4b5563" strokeWidth={1.5} />
        </svg>
        <span className="text-muted-foreground">Contains</span>
      </div>
      <div className="flex items-center gap-1.5 text-xs">
        <svg width="24" height="8">
          <line x1="0" y1="4" x2="20" y2="4" stroke="#9ca3af" strokeWidth={1} strokeDasharray="4 2" />
        </svg>
        <span className="text-muted-foreground">Uses</span>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Inventory() {
  const [, params] = useRoute("/workspaces/:id/inventory");
  const [, navigate] = useLocation();
  const workspaceId = params?.id ?? "";

  const { data: graphData, isLoading: graphLoading, refetch: refetchGraph } = useInventoryGraph(workspaceId);
  const { data: orphansData, isLoading: orphansLoading, refetch: refetchOrphans } = useOrphans(workspaceId);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [usageFilter, setUsageFilter] = useState<UsageFilter>("all");
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState("graph");

  const selectedNode = graphData?.nodes.find((n) => n.id === selectedNodeId) ?? null;

  const { filteredNodes, filteredEdges } = graphData
    ? applyFilters(graphData.nodes, graphData.edges, typeFilter, usageFilter, search)
    : { filteredNodes: [], filteredEdges: [] };

  function handleRefresh() {
    refetchGraph();
    refetchOrphans();
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border bg-card">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/workspaces/${workspaceId}`)}
          className="gap-1"
        >
          <ChevronLeft className="h-4 w-4" />
          Workspace
        </Button>

        <div className="h-5 w-px bg-border" />

        <Network className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold">Inventory</h1>

        {graphData && (
          <span className="text-xs text-muted-foreground">
            {graphData.nodes.length} nodes · {graphData.edges.length} edges
          </span>
        )}

        <div className="flex-1" />

        {/* Search */}
        <div className="relative w-52">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search nodes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-xs"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Type filter */}
        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as TypeFilter)}>
          <SelectTrigger className="h-8 w-36 text-xs">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="connection">Connection</SelectItem>
            <SelectItem value="pipeline">Pipeline</SelectItem>
            <SelectItem value="stage">Stage</SelectItem>
            <SelectItem value="skill">Skill</SelectItem>
            <SelectItem value="model">Model</SelectItem>
          </SelectContent>
        </Select>

        {/* Usage filter */}
        <Select value={usageFilter} onValueChange={(v) => setUsageFilter(v as UsageFilter)}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue placeholder="All usage" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All usage</SelectItem>
            <SelectItem value="used">Used</SelectItem>
            <SelectItem value="unused">Unused</SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant="ghost"
          size="icon"
          onClick={handleRefresh}
          className="h-8 w-8"
          aria-label="Refresh"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 flex overflow-hidden">
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex-1 flex flex-col overflow-hidden"
        >
          <div className="px-6 pt-3 border-b border-border bg-background">
            <TabsList>
              <TabsTrigger value="graph" className="flex items-center gap-1.5">
                <Network className="h-3.5 w-3.5" />
                Graph
              </TabsTrigger>
              <TabsTrigger value="orphans" className="flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" />
                Orphans
                {(orphansData?.nodes.length ?? 0) > 0 && (
                  <Badge
                    variant="secondary"
                    className="ml-1 h-4 px-1 text-[10px] bg-amber-500/15 text-amber-600"
                  >
                    {orphansData!.nodes.length}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="graph" className="flex-1 flex overflow-hidden m-0">
            <div className="flex-1 flex flex-col overflow-hidden">
              {graphLoading ? (
                <div className="flex flex-1 items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : !graphData || graphData.nodes.length === 0 ? (
                <div className="flex flex-1 items-center justify-center flex-col gap-2 text-muted-foreground">
                  <Network className="h-10 w-10 opacity-30" />
                  <p className="text-sm">No inventory data found for this workspace</p>
                </div>
              ) : filteredNodes.length === 0 ? (
                <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
                  No nodes match the current filters
                </div>
              ) : (
                <div className="flex-1 p-4 overflow-hidden bg-background/50">
                  <InventoryGraphSvg
                    nodes={filteredNodes}
                    edges={filteredEdges}
                    selectedId={selectedNodeId}
                    onSelectNode={setSelectedNodeId}
                  />
                </div>
              )}
              <GraphLegend />
            </div>

            {/* Side panel */}
            {selectedNode && (
              <NodeSidePanel
                node={selectedNode}
                workspaceId={workspaceId}
                onClose={() => setSelectedNodeId(null)}
              />
            )}
          </TabsContent>

          <TabsContent value="orphans" className="flex-1 overflow-y-auto m-0">
            {orphansLoading ? (
              <div className="flex items-center justify-center h-40">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <OrphanList nodes={orphansData?.nodes ?? []} />
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
