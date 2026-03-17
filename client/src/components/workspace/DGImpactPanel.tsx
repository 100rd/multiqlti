import { X, ArrowUpLeft } from "lucide-react";
import type { DGEdge, DGNode } from "@/hooks/useDependencyGraph";

// ─── Props ────────────────────────────────────────────────────────────────────

interface DGImpactPanelProps {
  selectedNodeId: string;
  nodes: DGNode[];
  edges: DGEdge[];
  onClose: () => void;
  onNavigate: (filePath: string) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DGImpactPanel({
  selectedNodeId,
  nodes,
  edges,
  onClose,
  onNavigate,
}: DGImpactPanelProps) {
  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  // Files that import this file (reverse edges: edge.target === selectedNodeId)
  const importedBy = edges
    .filter((e) => e.target === selectedNodeId)
    .map((e) => nodes.find((n) => n.id === e.source))
    .filter((n): n is DGNode => n !== undefined);

  // Files this file imports (forward edges: edge.source === selectedNodeId)
  const imports = edges
    .filter((e) => e.source === selectedNodeId)
    .map((e) => nodes.find((n) => n.id === e.target))
    .filter((n): n is DGNode => n !== undefined);

  if (!selectedNode) return null;

  return (
    <div className="absolute right-0 top-0 bottom-0 w-64 bg-card border-l border-border flex flex-col z-10 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <p className="text-xs font-semibold truncate flex-1 font-mono">{selectedNode.label}</p>
        <button
          onClick={onClose}
          className="ml-2 shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Close impact panel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Imported by (reverse edges = impact radius) */}
        <div className="px-3 py-2 border-b border-border">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">
            Imported by ({importedBy.length})
          </p>
          {importedBy.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">No dependents</p>
          ) : (
            <ul className="space-y-0.5">
              {importedBy.map((node) => (
                <li key={node.id}>
                  <button
                    onClick={() => onNavigate(node.id)}
                    className="w-full text-left flex items-center gap-1.5 text-[11px] text-red-500 hover:text-red-400 font-mono truncate py-0.5"
                  >
                    <ArrowUpLeft className="h-3 w-3 shrink-0" />
                    <span className="truncate">{node.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Imports (forward edges) */}
        <div className="px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">
            Imports ({imports.length})
          </p>
          {imports.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">No imports</p>
          ) : (
            <ul className="space-y-0.5">
              {imports.map((node) => (
                <li key={node.id}>
                  <button
                    onClick={() => onNavigate(node.id)}
                    className="w-full text-left text-[11px] text-muted-foreground hover:text-foreground font-mono truncate py-0.5"
                  >
                    {node.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
