import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getStraightPath,
  type EdgeProps,
} from "reactflow";
import type { DAGEdge } from "@shared/types";

type DAGEdgeLabelProps = EdgeProps & {
  data?: Pick<DAGEdge, "condition" | "label">;
};

export const DAGEdgeLabel = memo(({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
  data,
}: DAGEdgeLabelProps) => {
  const [edgePath, labelX, labelY] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });

  const conditionSummary = data?.condition
    ? `if ${data.condition.field} ${data.condition.operator}${data.condition.value !== undefined ? ` ${String(data.condition.value)}` : ""}`
    : null;

  const displayLabel = data?.label ?? conditionSummary;

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      {displayLabel && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            className="nodrag nopan"
          >
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium
                         bg-muted text-muted-foreground border border-border shadow-sm
                         max-w-[140px] truncate"
              title={displayLabel}
            >
              {displayLabel}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

DAGEdgeLabel.displayName = "DAGEdgeLabel";
