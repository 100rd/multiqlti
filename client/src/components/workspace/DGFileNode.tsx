import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DGFileNodeData {
  label: string;
  importedByCount: number;
  importCount: number;
  isSelected?: boolean;
  isImpacted?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

function DGFileNodeInner({ data, selected }: NodeProps<DGFileNodeData>) {
  const isHighImpact = data.importedByCount >= 5;

  return (
    <div
      className={cn(
        "px-3 py-2 rounded-md border text-xs font-mono min-w-[120px] max-w-[200px] shadow-sm transition-colors",
        selected
          ? "border-primary bg-primary/10 text-primary"
          : data.isImpacted
            ? "border-red-500/60 bg-red-500/10 text-red-500"
            : isHighImpact
              ? "border-amber-500/40 bg-amber-500/5 text-foreground"
              : "border-border bg-card text-foreground",
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!w-2 !h-2 !bg-muted-foreground !border-border"
      />

      <p className="truncate font-medium text-[11px]">{data.label}</p>

      <div className="flex items-center gap-2 mt-1 text-[9px] text-muted-foreground">
        {data.importCount > 0 && <span title="imports">{data.importCount} imp</span>}
        {data.importedByCount > 0 && (
          <span title="imported by" className={cn(isHighImpact && "text-amber-500 font-semibold")}>
            {data.importedByCount} used
          </span>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-2 !h-2 !bg-muted-foreground !border-border"
      />
    </div>
  );
}

export const DGFileNode = memo(DGFileNodeInner);
